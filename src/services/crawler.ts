/**
 * Crawler: sitemap discovery, HTML → text extraction (via the native HTMLRewriter) and chunking.
 * Designed to be CPU-cheap so it fits the Workers Free plan budget.
 */
import type { ExtractedPage, TextChunk } from '../types';

const USER_AGENT = 'Mozilla/5.0 (compatible; DocFlareBot/1.0; +https://github.com/p10node/docflare-ai)';
const FETCH_TIMEOUT_MS = 15_000;
/** Sitemap indexes may point to many child sitemaps; cap how many we follow. */
const MAX_CHILD_SITEMAPS = 25;
/** Hard cap on extracted characters per page, bounding CPU and memory. */
const MAX_PAGE_TEXT_CHARS = 200_000;
/** Pages with less text than this are skipped (login walls, redirects, empty shells). */
const MIN_PAGE_TEXT_CHARS = 40;

/**
 * Chunk budget in estimated tokens. The embedding model (bge-m3) reads up to 8k tokens, so the budget
 * comes from retrieval and prompt size instead: small, topic-focused chunks retrieve better than long
 * mixed ones, and TOP_K chunks of this size keep the LLM prompt (the main Workers AI cost) small. It
 * also stays under bge-small's 512-token window together with the title/description caps in indexer.ts.
 */
export const CHUNK_TOKENS = 350;
export const CHUNK_OVERLAP_TOKENS = 40;
/** A heading starts a new chunk once the current chunk holds at least this many tokens. */
export const SECTION_MIN_TOKENS = 80;

const NON_HTML_EXTENSION =
  /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|bmp|css|js|mjs|map|json|xml|txt|zip|gz|tgz|tar|rar|7z|mp[34]|m4a|wav|webm|mov|woff2?|ttf|otf|eot|csv|rss|atom|xlsx?|docx?|pptx?)$/i;

/** Elements whose text is never indexed (boilerplate, code for the browser, hidden content). */
const SKIP_SELECTORS = [
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'form',
  'nav',
  'footer',
  'aside',
  'body > header',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[hidden]',
  // "Skip to content" links: they would otherwise prefix the first chunk of every page.
  'a[class*="skip"]',
  'a[href="#content"]',
  'a[href="#main"]',
  'a[href="#main-content"]',
];
/** Longest meta description kept (prepended to a page's first chunk for retrieval). */
const MAX_DESCRIPTION_CHARS = 300;
/** Marker set on skipped elements so one element matching several skip selectors is counted once. */
const SKIP_MARKER_ATTR = 'data-docflare-skip';

/** Block-level elements: a newline is inserted before them so sentences do not glue together. */
const BLOCK_SELECTORS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'br', 'div', 'section', 'article', 'main',
  'blockquote', 'pre', 'table', 'dt', 'dd', 'hr', 'summary', 'details',
];

/**
 * Headings are written to the extracted text as Markdown lines (`## Title`). The chunker uses them
 * as section boundaries, and the model sees which section an excerpt belongs to.
 */
const HEADING_SELECTORS = ['h1', 'h2', 'h3', 'h4'];
const HEADING_LINE = /^#{1,6} \S/;

/** Void elements never have an end tag, so they cannot open a "skip" scope. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlError';
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CrawlError(`Failed to fetch ${url}: ${reason}`);
  }
  if (!res.ok) throw new CrawlError(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res;
}

/** Fetch a sitemap body, transparently gunzipping `.xml.gz` files. */
async function fetchSitemapText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, 'application/xml,text/xml,*/*;q=0.8');
  const isGzip = /\.gz($|\?)/i.test(url) || /gzip/i.test(res.headers.get('Content-Type') ?? '');
  if (isGzip && res.body) {
    try {
      return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    } catch {
      // Body was probably already decompressed by the runtime; fall through to plain text.
    }
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// Sitemap parsing
// ---------------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the common named/numeric XML & HTML entities. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeFromCodePoint(parseInt(lower.slice(2), 16), match);
    if (lower.startsWith('#')) return safeFromCodePoint(parseInt(lower.slice(1), 10), match);
    return ENTITY_MAP[lower] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) locs.push(decodeEntities(m[1].trim()));
  }
  return locs;
}

/**
 * True when the hostname belongs to the allowed site (same host or a subdomain of it). A wildcard site
 * domain ("*.example.com") covers the apex and every subdomain, like the widget origin check.
 */
export function isSameSite(hostname: string, allowedHost: string): boolean {
  const host = hostname.toLowerCase();
  const allowed = allowedHost.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
  if (!allowed) return false;
  return host === allowed || host.endsWith('.' + allowed);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Normalize a candidate page URL or return null when it should not be crawled. */
export function normalizePageUrl(raw: string, allowedHost: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isSameSite(url.hostname, allowedHost)) return null;
  if (NON_HTML_EXTENSION.test(url.pathname)) return null;
  url.hash = '';
  return url.toString();
}

export interface SitemapOptions {
  /** Only URLs on this host (or its subdomains) are kept. Prevents crawling third-party sites. */
  allowedHost: string;
  /** Maximum number of page URLs to return. */
  maxUrls: number;
}

/**
 * Fetch a sitemap (or sitemap index) and return the unique, crawlable HTML page URLs it lists.
 */
export async function fetchSitemapUrls(sitemapUrl: string, options: SitemapOptions): Promise<string[]> {
  const queue: string[] = [sitemapUrl];
  const seenSitemaps = new Set<string>();
  const pages = new Set<string>();
  let childSitemaps = 0;

  while (queue.length > 0 && pages.size < options.maxUrls) {
    const current = queue.shift() as string;
    if (seenSitemaps.has(current)) continue;
    seenSitemaps.add(current);

    const xml = await fetchSitemapText(current);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const locs = extractLocs(xml);

    if (isIndex) {
      for (const loc of locs) {
        if (childSitemaps >= MAX_CHILD_SITEMAPS) break;
        // Child sitemaps must live on the same site as well.
        try {
          if (!isSameSite(new URL(loc).hostname, options.allowedHost)) continue;
        } catch {
          continue;
        }
        queue.push(loc);
        childSitemaps++;
      }
      continue;
    }

    for (const loc of locs) {
      const normalized = normalizePageUrl(loc, options.allowedHost);
      if (normalized) pages.add(normalized);
      if (pages.size >= options.maxUrls) break;
    }
  }

  if (pages.size === 0) {
    throw new CrawlError(
      `Sitemap ${sitemapUrl} contains no crawlable HTML URLs on ${options.allowedHost}. ` +
        'Check that the sitemap is reachable and lists pages on the same domain.',
    );
  }
  return [...pages];
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

/** Collapse whitespace while preserving paragraph breaks. */
export function cleanText(raw: string): string {
  return decodeEntities(raw)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Download a page and extract its readable text using HTMLRewriter (streaming, native, CPU-cheap).
 * Navigation, headers, footers, scripts and styles are dropped; headings become `## Title` lines.
 * With `allowedHost`, a page that redirects to another site is rejected instead of being indexed
 * under the original URL.
 */
export async function extractPage(url: string, allowedHost?: string): Promise<ExtractedPage> {
  const res = await fetchWithTimeout(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  const finalHost = res.url ? hostnameOf(res.url) : null;
  if (allowedHost && finalHost && !isSameSite(finalHost, allowedHost)) {
    await res.body?.cancel();
    throw new CrawlError(`Skipped ${url}: redirected off-site to ${res.url}`);
  }
  const contentType = res.headers.get('Content-Type') ?? '';
  if (contentType && !/html|xhtml/i.test(contentType)) {
    throw new CrawlError(`Skipped ${url}: not an HTML document (${contentType})`);
  }

  let title = '';
  let h1 = '';
  let description = '';
  let text = '';
  let skipDepth = 0;
  let headingDepth = 0;
  let truncated = false;

  // Skipped elements open a scope that is closed by their end tag. Void elements have no
  // end tag and are ignored; `<body>` resets the depth in case `</head>` was omitted.
  // One element can match several skip selectors (e.g. `<nav hidden>`), which runs this handler
  // once per selector while HTMLRewriter fires a single end-tag callback per element. The marker
  // attribute makes the handler idempotent (the rewritten output is discarded, so it is harmless).
  const skipHandler: HTMLRewriterElementContentHandlers = {
    element(el) {
      if (VOID_TAGS.has(el.tagName.toLowerCase())) return;
      if (el.hasAttribute(SKIP_MARKER_ATTR)) return;
      el.setAttribute(SKIP_MARKER_ATTR, '');
      try {
        el.onEndTag(() => {
          skipDepth = Math.max(0, skipDepth - 1);
        });
        skipDepth++;
      } catch {
        // Element cannot have an end tag (e.g. self-closing foreign element): nothing to skip.
      }
    },
  };
  const blockHandler: HTMLRewriterElementContentHandlers = {
    element() {
      if (skipDepth === 0 && !truncated) text += '\n';
    },
  };
  // Headings open a Markdown heading line; the text inside is flattened to one line. Should an end
  // tag never arrive (broken markup), the following block elements still start on new lines, so the
  // only effect is that line breaks inside the heading are collapsed.
  const headingHandler: HTMLRewriterElementContentHandlers = {
    element(el) {
      if (skipDepth > 0 || truncated) return;
      const level = Number(el.tagName.charAt(1)) || 1;
      try {
        el.onEndTag(() => {
          headingDepth = Math.max(0, headingDepth - 1);
          text += '\n';
        });
        headingDepth++;
        text += '\n' + '#'.repeat(level) + ' ';
      } catch {
        // Cannot have an end tag: not a real heading element.
      }
    },
  };
  // <meta name="description"> wins over og:description; the first non-empty value is kept.
  const descriptionHandler: HTMLRewriterElementContentHandlers = {
    element(el) {
      const content = el.getAttribute('content')?.trim();
      if (content && (!description || el.getAttribute('name')?.toLowerCase() === 'description')) description = content;
    },
  };

  let rewriter = new HTMLRewriter();
  for (const selector of SKIP_SELECTORS) rewriter = rewriter.on(selector, skipHandler);
  for (const selector of BLOCK_SELECTORS) rewriter = rewriter.on(selector, blockHandler);
  for (const selector of HEADING_SELECTORS) rewriter = rewriter.on(selector, headingHandler);
  rewriter = rewriter
    .on('meta[name="description" i]', descriptionHandler)
    .on('meta[property="og:description" i]', descriptionHandler)
    .on('body', {
      element() {
        skipDepth = 0;
      },
    })
    .on('title', {
      text(chunk) {
        if (title.length < 500) title += chunk.text;
      },
    })
    .on('h1', {
      text(chunk) {
        if (skipDepth === 0 && h1.length < 500) h1 += chunk.text;
      },
    })
    .on('html', {
      text(chunk) {
        if (skipDepth > 0 || truncated) return;
        text += headingDepth > 0 ? chunk.text.replace(/\s+/g, ' ') : chunk.text;
        if (text.length > MAX_PAGE_TEXT_CHARS) truncated = true;
      },
    });

  // The transformed body must be consumed for the handlers to run.
  await rewriter.transform(res).arrayBuffer();

  const cleaned = cleanText(text);
  if (cleaned.length < MIN_PAGE_TEXT_CHARS) {
    throw new CrawlError(`Skipped ${url}: no extractable text content`);
  }

  const pageTitle = cleanText(title || h1).split('\n')[0]?.slice(0, 200) || url;
  const pageDescription = cleanText(description).replace(/\n+/g, ' ').slice(0, MAX_DESCRIPTION_CHARS);
  return { url, title: pageTitle, description: pageDescription, text: cleaned };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Cheap upper-bound token estimate, calibrated on BERT WordPiece counts for English, Vietnamese and
 * code: ~4.5 chars per token for ASCII letters/digits/spaces, ~0.7 for ASCII punctuation, and one
 * token per non-ASCII character (accented letters and CJK are split into word pieces). bge-m3's and
 * Llama's tokenizers handle accented and CJK text more efficiently, so the estimate errs on the high
 * side there: Vietnamese/CJK chunks come out somewhat shorter than English ones, never longer.
 */
export function estimateTokens(text: string): number {
  let word = 0;
  let punct = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) other++;
    else if (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 32 ||
      c === 10
    ) {
      word++;
    } else punct++;
  }
  return Math.ceil(word / 4.5 + punct / 0.7 + other);
}

/** Shorten text so it fits in `maxTokens` (estimated), cutting at a whitespace when possible. */
export function truncateToTokens(text: string, maxTokens: number): string {
  let out = text;
  let tokens = estimateTokens(out);
  while (tokens > maxTokens && out.length > 0) {
    const keep = Math.floor((out.length * maxTokens) / tokens) - 1;
    let cut = out.slice(0, Math.max(0, keep));
    const space = cut.lastIndexOf(' ');
    if (space > cut.length / 2) cut = cut.slice(0, space);
    out = cut.trimEnd();
    tokens = estimateTokens(out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Budget per chunk in estimated tokens. */
  maxTokens?: number;
  /** Trailing sentences carried into the next chunk, in estimated tokens. */
  overlapTokens?: number;
  /** A heading starts a new chunk when the current chunk already holds this many tokens. */
  sectionMinTokens?: number;
}

const isHeading = (unit: string): boolean => HEADING_LINE.test(unit);

/** Split text into sentence-like units, keeping paragraph boundaries and heading lines intact. */
function splitUnits(text: string): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed || /^#{1,6}$/.test(trimmed)) continue; // empty heading (icon-only <h3>)
    if (isHeading(trimmed)) {
      units.push(trimmed);
      continue;
    }
    // Split after sentence punctuation followed by whitespace and an upper-case letter / digit / quote.
    for (const sentence of trimmed.split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"'(\[])/u)) {
      if (sentence.trim()) units.push(sentence.trim());
    }
  }
  return units;
}

/** Hard-split an oversized unit (e.g. a long code block) into pieces that fit the token budget. */
function hardSplit(unit: string, maxTokens: number): string[] {
  const pieces = Math.ceil(estimateTokens(unit) / (maxTokens * 0.9));
  if (pieces <= 1) return [unit];
  const size = Math.ceil(unit.length / pieces);
  const parts: string[] = [];
  for (let i = 0; i < unit.length; i += size) {
    const part = unit.slice(i, i + size);
    if (estimateTokens(part) > maxTokens && part.length > 1) parts.push(...hardSplit(part, maxTokens));
    else parts.push(part);
  }
  return parts;
}

/** Join units with spaces; headings get their own line. */
function joinUnits(units: string[]): string {
  let out = '';
  for (let i = 0; i < units.length; i++) {
    const unit = units[i] as string;
    if (i > 0) out += isHeading(unit) || isHeading(units[i - 1] as string) ? '\n' : ' ';
    out += unit;
  }
  return out;
}

/**
 * Chunk text into ~CHUNK_TOKENS blocks with ~CHUNK_OVERLAP_TOKENS of overlap.
 * Chunks end on sentence boundaries whenever possible, and a heading starts a fresh chunk (without
 * overlap) once the current chunk is big enough, so one chunk rarely mixes unrelated sections.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxTokens = options.maxTokens ?? CHUNK_TOKENS;
  const overlapTokens = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS;
  const sectionMinTokens = options.sectionMinTokens ?? SECTION_MIN_TOKENS;

  const units = splitUnits(text).flatMap((u) => (estimateTokens(u) > maxTokens ? hardSplit(u, maxTokens) : [u]));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  // Whether `current` holds anything beyond the overlap carried from the previous chunk.
  let hasNewContent = false;

  const flush = (withOverlap: boolean) => {
    if (current.length === 0) return;
    chunks.push(joinUnits(current));
    // Carry the tail of the previous chunk forward as overlap (never across a section boundary).
    const carry: string[] = [];
    let carryTokens = 0;
    if (withOverlap) {
      for (let i = current.length - 1; i >= 0; i--) {
        const unit = current[i] as string;
        const tokens = estimateTokens(unit);
        if (carryTokens + tokens > overlapTokens) break;
        carry.unshift(unit);
        carryTokens += tokens;
      }
    }
    current = carry;
    currentTokens = carryTokens;
    hasNewContent = false;
  };

  for (const unit of units) {
    const tokens = estimateTokens(unit);
    if (isHeading(unit) && currentTokens >= sectionMinTokens) flush(false);
    else if (currentTokens + tokens > maxTokens && current.length > 0) flush(true);
    current.push(unit);
    currentTokens += tokens;
    hasNewContent = true;
  }
  if (current.length > 0 && hasNewContent) chunks.push(joinUnits(current));

  return chunks
    .map((t) => t.trim())
    .filter((t, _i, all) => t.length > 0 && (all.length === 1 || t.length >= 20))
    .map((t, index) => ({ index, text: t }));
}
