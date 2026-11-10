/**
 * Unit tests for the pure, runtime-independent parts of DocFlare AI.
 * Run with `bun test`. Everything that needs Workers bindings (AI, Vectorize, D1) is exercised via
 * `wrangler dev` instead. Bun ships a native HTMLRewriter, so page extraction is covered here.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyRerank,
  buildRagMessages,
  iterateWorkersAiTokens,
  LANGUAGE_REMINDER,
  outputText,
  rerankChunks,
  textToWorkersAiStream,
  toSources,
} from '../src/services/ai';
import {
  CHUNK_TOKENS,
  SECTION_MIN_TOKENS,
  chunkText,
  cleanText,
  decodeEntities,
  estimateTokens,
  extractPage,
  isSameSite,
  normalizePageUrl,
  truncateToTokens,
} from '../src/services/crawler';
import { buildChunkRecords } from '../src/services/indexer';
import { diversify } from '../src/services/vectorize';
import { hostnameMatches, isOriginAllowed, normalizeDomain, parseAllowedOrigins } from '../src/utils/cors';
import { pageIdFor, sha256Hex, timingSafeEqual } from '../src/utils/hash';
import type { RetrievedChunk } from '../src/types';

const paragraph =
  'This is sentence number one. Here is another sentence, slightly longer than the first one! Does chunking work?';
const longText = Array.from({ length: 60 }, (_, i) => paragraph.replace('one', String(i))).join('\n');

describe('token estimate', () => {
  test('is an upper bound around 4.5 chars per token for English prose and never under-counts accents', () => {
    const english = 'The quick brown fox jumps over the lazy dog near the river bank today.';
    expect(estimateTokens(english)).toBeGreaterThanOrEqual(16);
    expect(estimateTokens(english)).toBeLessThanOrEqual(24);
    // Vietnamese: every accented character counts as a token of its own.
    expect(estimateTokens('Tại sao bạn nên dùng Kubernetes')).toBeGreaterThan(estimateTokens('Tai sao ban nen dung Kubernetes'));
    expect(estimateTokens('')).toBe(0);
  });

  test('truncateToTokens respects the budget and leaves short text alone', () => {
    const long = 'Ứng dụng web cho developer. '.repeat(80);
    const cut = truncateToTokens(long, 50);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(50);
    expect(cut.length).toBeGreaterThan(20);
    expect(truncateToTokens('short', 50)).toBe('short');
  });
});

describe('chunkText', () => {
  test('splits long text into several bounded chunks with sequential indexes', () => {
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => estimateTokens(c.text) <= CHUNK_TOKENS)).toBe(true);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test('keeps Vietnamese text inside the token budget even though it has fewer chars per token', () => {
    const vi = 'Tại sao bạn nên dùng Kubernetes thay vì Docker Swarm cho hệ thống sản xuất của mình? '.repeat(60);
    const chunks = chunkText(vi);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => estimateTokens(c.text) <= CHUNK_TOKENS)).toBe(true);
  });

  test('starts a new chunk at a heading once the current chunk is big enough, without overlap', () => {
    const intro = 'This sentence introduces the company and what it does for customers. '.repeat(8);
    const text = `# Home\n${intro}\n## Open source\nTooling we maintain in the open, starting with k10s.\n## Books\nThe long-form version of the insights.`;
    expect(estimateTokens(intro)).toBeGreaterThanOrEqual(SECTION_MIN_TOKENS);
    const chunks = chunkText(text);
    const oss = chunks.find((c) => c.text.startsWith('## Open source'));
    expect(oss).toBeDefined();
    expect(oss!.text).toContain('k10s');
    expect(oss!.text).not.toContain('introduces the company');
    expect(chunks[0]!.text.startsWith('# Home\nThis sentence')).toBe(true);
  });

  test('keeps a heading in the current chunk when that chunk is still small', () => {
    const chunks = chunkText('# Title\nShort intro.\n## Section\nBody text here.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('# Title\nShort intro.\n## Section\nBody text here.');
  });

  test('carries sentence overlap into the next chunk', () => {
    const [first, second] = chunkText(longText);
    const lastSentence = first!.text.split(/(?<=[.!?])\s+/).at(-1)!;
    expect(second!.text).toContain(lastSentence);
  });

  test('keeps short text as a single chunk and drops empty input', () => {
    expect(chunkText('Short text here.')).toHaveLength(1);
    expect(chunkText('   \n  ')).toHaveLength(0);
  });

  test('hard-splits oversized units such as long code blocks', () => {
    const chunks = chunkText('x'.repeat(5000));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => estimateTokens(c.text) <= CHUNK_TOKENS)).toBe(true);
    expect(chunks.map((c) => c.text).join('')).toBe('x'.repeat(5000));
  });

  test('never emits duplicate chunks', () => {
    const texts = chunkText(longText).map((c) => c.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('text cleaning', () => {
  test('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x41; &nbsp;e')).toBe("a & b <c> 'd' A  e");
  });

  test('collapses whitespace but keeps paragraph breaks', () => {
    expect(cleanText('  Hello \n\n\n\n World  \t x \n')).toBe('Hello\n\nWorld x');
  });
});

describe('extractPage', () => {
  const body = 'Install the package, then run the dev server to see your docs. '.repeat(3);
  const html = `<!doctype html><html><head><title>Getting started | Docs</title><style>p{margin:0}</style>
<meta property="og:description" content="OG summary"><meta name="description" content="How to install &amp; run the docs."></head>
<body><a class="skip-link" href="#main">Skip to content</a><header><nav>Home Pricing</nav><nav class="mobile-nav" hidden><a href="/">Home</a></nav></header>
<main><h1>Getting started</h1><p>${body}</p><h2>
  Install <code>it</code>
</h2><p>Second paragraph.</p></main><footer>Copyright Example Inc.</footer></body></html>`;

  async function withHtml<T>(fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  test('keeps main content and drops boilerplate, even when one element matches several skip selectors', async () => {
    const page = await withHtml(() => extractPage('https://example.com/docs'));
    expect(page.title).toBe('Getting started | Docs');
    expect(page.text).toContain('Getting started');
    expect(page.text).toContain('Install the package');
    expect(page.text).not.toContain('Pricing');
    expect(page.text).not.toContain('Copyright');
    expect(page.text).not.toContain('margin');
    expect(page.text).not.toContain('Skip to content');
  });

  test('writes headings as Markdown lines with their text flattened', async () => {
    const page = await withHtml(() => extractPage('https://example.com/docs'));
    expect(page.text).toMatch(/^# Getting started\n/);
    expect(page.text).toMatch(/\n## Install it\n+Second paragraph\./);
  });

  test('prefers <meta name="description"> over og:description and decodes entities', async () => {
    const page = await withHtml(() => extractPage('https://example.com/docs'));
    expect(page.description).toBe('How to install & run the docs.');
  });
});

describe('chunk records', () => {
  const page = { url: 'https://d.com/', title: 'Acme - Widgets', description: 'Acme makes widgets.', text: '' };
  const chunks = [
    { index: 0, text: 'first chunk' },
    { index: 1, text: 'second chunk' },
  ];

  test('prepends the description to the first chunk and the title to every embedding input', () => {
    const records = buildChunkRecords(page, chunks);
    expect(records[0]).toEqual({ index: 0, text: 'Acme makes widgets.\n\nfirst chunk', embedInput: 'Acme - Widgets\n\nAcme makes widgets.\n\nfirst chunk' });
    expect(records[1]).toEqual({ index: 1, text: 'second chunk', embedInput: 'Acme - Widgets\n\nsecond chunk' });
  });

  test('leaves chunks untouched when the page has no description or title', () => {
    const records = buildChunkRecords({ ...page, title: '', description: '' }, chunks);
    expect(records.map((r) => r.text)).toEqual(['first chunk', 'second chunk']);
    expect(records.map((r) => r.embedInput)).toEqual(['first chunk', 'second chunk']);
  });

  test('keeps a long description in the stored text but caps it in the embedding input', () => {
    const description = 'Ứng dụng web cho developer và content creator. '.repeat(12).trim();
    const records = buildChunkRecords({ ...page, description }, chunks);
    expect(records[0]!.text.startsWith(description)).toBe(true);
    expect(records[0]!.embedInput).not.toContain(description);
    expect(records[0]!.embedInput.endsWith('first chunk')).toBe(true);
    expect(estimateTokens(records[0]!.embedInput)).toBeLessThan(40 + 80 + estimateTokens('first chunk') + 4);
  });
});

describe('rerank', () => {
  const chunk = (id: string, score: number): RetrievedChunk => ({
    id,
    score,
    metadata: { siteId: 's', pageId: 'p', url: `https://d.com/${id}`, title: id, chunk: 0, text: `text ${id}` },
  });
  const candidates = [chunk('a', 0.9), chunk('b', 0.8), chunk('c', 0.7)];

  test('applyRerank reorders by reranker score and replaces the scores', () => {
    const out = applyRerank(candidates, { response: [{ id: 0, score: 0.1 }, { id: 2, score: 0.95 }, { id: 1, score: 0.4 }] });
    expect(out.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(out.map((c) => c.score)).toEqual([0.95, 0.4, 0.1]);
    expect(candidates.map((c) => c.score)).toEqual([0.9, 0.8, 0.7]); // input untouched
  });

  test('applyRerank ignores bad entries and appends unscored chunks in vector order', () => {
    const out = applyRerank(candidates, { response: [{ id: 7, score: 1 }, { id: 2 }, { id: 1, score: 0.5 }, { id: 1, score: 0.2 }] });
    expect(out.map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(out[0]!.score).toBe(0.5);
  });

  test('applyRerank falls back to the input order on malformed output', () => {
    expect(applyRerank(candidates, undefined)).toBe(candidates);
    expect(applyRerank(candidates, { response: [] })).toBe(candidates);
    expect(applyRerank(candidates, {} as never)).toBe(candidates);
  });

  test('rerankChunks sends every candidate as a context and keeps working when the model fails', async () => {
    let seen: unknown;
    const ok = { run: async (_m: string, inputs: unknown) => { seen = inputs; return { response: [{ id: 1, score: 0.9 }, { id: 0, score: 0.2 }, { id: 2, score: 0.1 }] }; } } as unknown as Ai;
    const out = await rerankChunks(ok, 'open source?', candidates);
    expect(out.map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(seen).toEqual({ query: 'open source?', contexts: [{ text: 'text a' }, { text: 'text b' }, { text: 'text c' }], top_k: 3 });

    const broken = { run: async () => { throw new Error('3040: rate limited'); } } as unknown as Ai;
    expect(await rerankChunks(broken, 'q', candidates)).toBe(candidates);
    expect(await rerankChunks(broken, 'q', candidates.slice(0, 1))).toEqual(candidates.slice(0, 1));
  });
});

describe('diversify', () => {
  const c = (url: string, id: string) => ({ id, metadata: { url } });
  const ranked = [c('/a', 'a0'), c('/a', 'a1'), c('/a', 'a2'), c('/b', 'b0'), c('/a', 'a3'), c('/c', 'c0'), c('/b', 'b1')];

  test('caps chunks per page while preserving score order', () => {
    expect(diversify(ranked, 4, 2).map((x) => x.id)).toEqual(['a0', 'a1', 'b0', 'c0']);
  });

  test('fills remaining slots with the best leftovers when few pages match', () => {
    expect(diversify(ranked.slice(0, 3), 3, 2).map((x) => x.id)).toEqual(['a0', 'a1', 'a2']);
  });

  test('returns at most topK', () => {
    expect(diversify(ranked, 2, 2).map((x) => x.id)).toEqual(['a0', 'a1']);
  });
});

describe('sitemap URL filtering', () => {
  test('normalizes same-site HTML URLs and strips fragments', () => {
    expect(normalizePageUrl('https://docs.example.com/a/b#frag', 'docs.example.com')).toBe(
      'https://docs.example.com/a/b',
    );
    expect(normalizePageUrl('https://api.example.com/x', 'example.com')).toBe('https://api.example.com/x');
  });

  test('rejects other hosts, non-HTML assets and non-http schemes', () => {
    expect(normalizePageUrl('https://evil.com/x', 'docs.example.com')).toBeNull();
    expect(normalizePageUrl('https://docs.example.com/x.pdf', 'docs.example.com')).toBeNull();
    expect(normalizePageUrl('ftp://docs.example.com/x', 'docs.example.com')).toBeNull();
    expect(normalizePageUrl('not a url', 'docs.example.com')).toBeNull();
  });

  test('isSameSite accepts www and subdomains only', () => {
    expect(isSameSite('www.example.com', 'example.com')).toBe(true);
    expect(isSameSite('docs.example.com', 'example.com')).toBe(true);
    expect(isSameSite('example.com.evil.io', 'example.com')).toBe(false);
  });

  test('isSameSite understands wildcard site domains and never matches an empty one', () => {
    expect(isSameSite('api.example.com', '*.example.com')).toBe(true);
    expect(isSameSite('example.com', '*.example.com')).toBe(true);
    expect(isSameSite('example.org', '*.example.com')).toBe(false);
    expect(isSameSite('evil.test.', '')).toBe(false);
    expect(normalizePageUrl('https://docs.example.com/x', '*.example.com')).toBe('https://docs.example.com/x');
  });
});

describe('CORS / origin policy', () => {
  test('hostnameMatches handles exact, www and wildcard patterns', () => {
    expect(hostnameMatches('docs.example.com', 'docs.example.com')).toBe(true);
    expect(hostnameMatches('www.example.com', 'example.com')).toBe(true);
    expect(hostnameMatches('a.b.example.com', '*.example.com')).toBe(true);
    expect(hostnameMatches('example.com', '*.example.com')).toBe(true);
    expect(hostnameMatches('example.com.evil.io', 'example.com')).toBe(false);
  });

  test('normalizeDomain keeps hostnames and wildcards and rejects everything else', () => {
    expect(normalizeDomain(' https://Docs.Example.com:8080/path ')).toBe('docs.example.com');
    expect(normalizeDomain('*.example.com')).toBe('*.example.com');
    expect(normalizeDomain('localhost')).toBe('localhost');
    for (const bad of ['', 'https://', 'a..b', 'example.com.', '-a.com', 'exa mple.com', '*.', 'a.*.com']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });

  test('isOriginAllowed enforces the site domain and the allow-list', () => {
    expect(isOriginAllowed(null, 'docs.example.com', [])).toBe(true);
    expect(isOriginAllowed('https://docs.example.com', 'docs.example.com', [])).toBe(true);
    expect(isOriginAllowed('https://evil.com', 'docs.example.com', [])).toBe(false);
    expect(isOriginAllowed('https://evil.com', 'docs.example.com', ['*'])).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', 'docs.example.com', [])).toBe(true);
    expect(isOriginAllowed('not a url', 'docs.example.com', [])).toBe(false);
    const list = parseAllowedOrigins(' https://app.other.com , foo.com');
    expect(list).toEqual(['https://app.other.com', 'foo.com']);
    expect(isOriginAllowed('https://app.other.com', 'docs.example.com', list)).toBe(true);
    expect(isOriginAllowed('https://foo.com', 'docs.example.com', list)).toBe(true);
  });
});

describe('hash utilities', () => {
  test('sha256Hex and pageIdFor are deterministic', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await pageIdFor('docs', 'https://a.com/')).toHaveLength(24);
    expect(await pageIdFor('docs', 'https://a.com/')).toBe(await pageIdFor('docs', 'https://a.com/'));
  });

  test('pageIdFor differs per site for the same URL', async () => {
    expect(await pageIdFor('docs', 'https://a.com/')).not.toBe(await pageIdFor('docs-v2', 'https://a.com/'));
  });

  test('timingSafeEqual compares correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('RAG prompt', () => {
  const chunks: RetrievedChunk[] = [
    {
      id: 'p-0',
      score: 0.91234,
      metadata: { siteId: 's', pageId: 'p', url: 'https://d.com/a', title: 'A', chunk: 0, text: 'alpha text' },
    },
  ];

  test('builds system + history + user messages with titled context', () => {
    const messages = buildRagMessages(
      'q?',
      chunks,
      [
        { role: 'user', content: 'prev' },
        { role: 'assistant', content: 'ans' },
      ],
      'd.com',
    );
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[0]!.content).toContain('Source: A (https://d.com/a)\nalpha text');
    expect(messages[0]!.content).toContain('language of the user');
    expect(messages[0]!.content).toContain('for d.com');
    expect(messages.at(-1)!.content).toBe(`q?\n\n${LANGUAGE_REMINDER}`);
  });

  test('toSources produces 1-based sources with rounded scores', () => {
    expect(toSources(chunks)).toEqual([{ index: 1, url: 'https://d.com/a', title: 'A', score: 0.9123 }]);
  });
});

describe('Workers AI output parsing', () => {
  const sse = (lines: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'));
        c.close();
      },
    });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const out: string[] = [];
    for await (const t of iterateWorkersAiTokens(stream)) out.push(t);
    return out;
  };

  test('outputText accepts the Llama `response` shape and the OpenAI `choices` shapes', () => {
    expect(outputText({ response: 'hi' })).toBe('hi');
    expect(outputText({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
    expect(outputText({ choices: [{ delta: { content: 'tok' } }] })).toBe('tok');
    expect(outputText({ choices: [{ message: { content: null } }] })).toBe('');
    expect(outputText({})).toBe('');
    expect(outputText(undefined)).toBe('');
  });

  test('iterateWorkersAiTokens yields Llama-style tokens and stops at [DONE]', async () => {
    const tokens = await collect(
      sse(['data: {"response":"Hel"}', '', 'data: {"response":"lo","usage":{}}', '', 'data: [DONE]', 'data: {"response":"late"}']),
    );
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  test('iterateWorkersAiTokens yields OpenAI-style delta tokens and skips reasoning-only chunks', async () => {
    const tokens = await collect(
      sse([
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
        'data: {"choices":[{"delta":{"content":"4"}}]}',
        'data: [DONE]',
      ]),
    );
    expect(tokens).toEqual(['4']);
  });

  test('iterateWorkersAiTokens keeps a last line that has no trailing newline', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"response":"a"}\n\ndata: {"response":"b"}'));
        c.close();
      },
    });
    expect(await collect(stream)).toEqual(['a', 'b']);
  });

  test('textToWorkersAiStream round-trips through iterateWorkersAiTokens', async () => {
    expect(await collect(textToWorkersAiStream('plain answer'))).toEqual(['plain answer']);
  });
});
