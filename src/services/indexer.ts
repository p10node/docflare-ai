/**
 * Indexing pipeline: sitemap → queue (D1) → crawl → chunk → embed → Vectorize.
 *
 * Work is done in small batches so each invocation stays inside the Workers Free plan CPU
 * budget. Batches are driven by the cron trigger and/or POST /api/sites/:siteId/process.
 */
import type { Env, ExtractedPage, IndexProgress, TextChunk } from '../types';
import { Db, type PageRow } from '../db/schema';
import { pageIdFor } from '../utils/hash';
import { AiRateLimitError, embedTexts } from './ai';
import { chunkText, extractPage, fetchSitemapUrls, truncateToTokens } from './crawler';
import { chunkVectorId, deletePageVectors, deletePagesVectors, upsertChunks, type ChunkVector } from './vectorize';

export interface RegisterResult {
  siteId: string;
  domain: string;
  sitemapUrl: string;
  /** URLs discovered in the sitemap and queued for crawling. */
  queued: number;
  /** Previously indexed pages no longer listed in the sitemap; their rows and vectors were deleted. */
  removed: number;
}

export interface PageResult {
  url: string;
  status: 'indexed' | 'failed';
  title?: string;
  chunks?: number;
  error?: string;
}

export interface ProcessResult {
  processed: number;
  indexed: number;
  failed: number;
  /** True when Workers AI rate limiting stopped the batch early; remaining pages stay queued. */
  rateLimited: boolean;
  results: PageResult[];
}

/**
 * A claimed page stays "processing" this long before another invocation may claim it again. Matches
 * the longest a cron invocation can run, so a live invocation never loses its pages.
 */
export const LEASE_MINUTES = 15;
/**
 * Claims allowed per page. Every claim counts, and a page is only re-claimed when the invocation that
 * held it died without recording a result (CPU, memory or time limit), so this is the number of times
 * a page may kill the Worker before it is marked failed.
 */
export const MAX_ATTEMPTS = 3;

/** Register (or refresh) a site, enqueue every HTML URL in its sitemap and drop pages it no longer lists. */
export async function registerSite(
  env: Env,
  siteId: string,
  sitemapUrl: string,
  domain: string,
  maxPages: number,
): Promise<RegisterResult> {
  const db = new Db(env.DB);
  const urls = await fetchSitemapUrls(sitemapUrl, { allowedHost: domain, maxUrls: maxPages });

  await db.upsertSite(siteId, domain, sitemapUrl);
  const pages = await Promise.all(urls.map(async (url) => ({ id: await pageIdFor(siteId, url), url })));
  await db.enqueuePages(siteId, pages);
  const removed = await pruneRemovedPages(env, db, siteId, new Set(urls));

  return { siteId, domain, sitemapUrl, queued: pages.length, removed };
}

/**
 * Delete the pages of a site whose URL is not in `keep` (removed from the sitemap, or past MAX_PAGES),
 * vectors first so a failure leaves the rows in place for the next re-crawl to retry.
 */
async function pruneRemovedPages(env: Env, db: Db, siteId: string, keep: Set<string>): Promise<number> {
  const stale = (await db.listPages(siteId)).filter((page) => !keep.has(page.url));
  if (stale.length === 0) return 0;
  await deletePagesVectors(env.VECTOR_INDEX, stale);
  await db.deletePages(stale.map((page) => page.id));
  return stale.length;
}

/**
 * Token caps for the title / description prepended to embedding inputs, so they add context without
 * drowning out the chunk's own text. Together with CHUNK_TOKENS (350) inputs also stay under 512
 * tokens, the window of the smaller BGE models.
 */
const EMBED_TITLE_TOKENS = 40;
const EMBED_DESCRIPTION_TOKENS = 80;

export interface ChunkRecord {
  index: number;
  /** Text stored in Vectorize metadata and shown to the LLM. */
  text: string;
  /** Text actually embedded. */
  embedInput: string;
}

/**
 * Decide what is stored and what is embedded for each chunk.
 * The meta description is prepended to the first chunk and the page title to every embedding input:
 * landing/about copy rarely spells out the site name, so without this "what is <site>?" retrieves the
 * legal pages (which do) instead of the About page. The stored text keeps the full description; the
 * embedding input gets token-capped copies so they never outweigh the chunk text.
 */
export function buildChunkRecords(page: ExtractedPage, chunks: TextChunk[]): ChunkRecord[] {
  const description = page.description.trim();
  const embedTitle = truncateToTokens(page.title.trim(), EMBED_TITLE_TOKENS);
  const embedDescription = truncateToTokens(description, EMBED_DESCRIPTION_TOKENS);
  return chunks.map((chunk, i) => {
    const first = i === 0 && description.length > 0;
    const text = first ? `${description}\n\n${chunk.text}` : chunk.text;
    const body = first && embedDescription ? `${embedDescription}\n\n${chunk.text}` : chunk.text;
    return { index: chunk.index, text, embedInput: embedTitle ? `${embedTitle}\n\n${body}` : body };
  });
}

/** Crawl, chunk, embed and store a single page. `allowedHost` rejects redirects to other sites. */
export async function indexPage(
  env: Env,
  page: PageRow,
  allowedHost?: string,
): Promise<{ title: string; chunks: number }> {
  const extracted = await extractPage(page.url, allowedHost);
  const chunks = chunkText(extracted.text);
  if (chunks.length === 0) throw new Error('No text chunks produced');

  const records = buildChunkRecords(extracted, chunks);
  const embeddings = await embedTexts(
    env.AI,
    records.map((r) => r.embedInput),
  );

  const vectors: ChunkVector[] = records.map((record, i) => ({
    id: chunkVectorId(page.id, record.index),
    values: embeddings[i] as number[],
    metadata: {
      siteId: page.site_id,
      pageId: page.id,
      url: page.url,
      title: extracted.title,
      chunk: record.index,
      text: record.text,
    },
  }));

  await upsertChunks(env.VECTOR_INDEX, page.site_id, vectors);

  // A re-crawled page may have shrunk; remove stale trailing vectors from the previous run.
  if (page.chunk_count > chunks.length) {
    await deletePageVectors(env.VECTOR_INDEX, page.id, chunks.length, page.chunk_count);
  }

  return { title: extracted.title, chunks: chunks.length };
}

/**
 * Claim and process the next batch of pending pages (for one site, or across all sites when siteId is
 * null). Failures are recorded per page; a Workers AI rate limit stops the batch and hands the
 * unprocessed pages back to the queue.
 */
export async function processPendingPages(
  env: Env,
  siteId: string | null,
  batchSize: number,
): Promise<ProcessResult> {
  const db = new Db(env.DB);
  const pages = await db.claimPending(siteId, batchSize, LEASE_MINUTES);
  const result: ProcessResult = { processed: 0, indexed: 0, failed: 0, rateLimited: false, results: [] };
  const domains = new Map<string, string | undefined>();
  const domainOf = async (id: string) => {
    if (!domains.has(id)) domains.set(id, (await db.getSite(id))?.domain);
    return domains.get(id);
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] as PageRow;
    try {
      if (page.attempts > MAX_ATTEMPTS) {
        throw new Error(
          `Gave up after ${MAX_ATTEMPTS} attempts: the Worker was stopped while indexing this page ` +
            '(CPU, memory or time limit). Re-crawl the sitemap to retry.',
        );
      }
      const { title, chunks } = await indexPage(env, page, await domainOf(page.site_id));
      await db.markPageIndexed(page.id, title, chunks);
      result.indexed++;
      result.results.push({ url: page.url, status: 'indexed', title, chunks });
    } catch (err) {
      if (err instanceof AiRateLimitError) {
        // Hand this page and the rest of the batch back; the next cron tick retries them.
        result.rateLimited = true;
        await db.releasePages(pages.slice(i).map((p) => p.id));
        console.warn(JSON.stringify({ event: 'index.rate_limited', url: page.url }));
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      await db.markPageFailed(page.id, message);
      result.failed++;
      result.results.push({ url: page.url, status: 'failed', error: message });
      console.warn(JSON.stringify({ event: 'index.page_failed', url: page.url, error: message }));
    }
    result.processed++;
  }

  if (result.processed > 0) {
    const { results: _omit, ...summary } = result;
    console.log(JSON.stringify({ event: 'index.batch', siteId, ...summary }));
  }
  return result;
}

/** Remove a site: its vectors, pages, chat history and the site row itself. */
export async function removeSite(env: Env, siteId: string): Promise<{ vectorsDeleted: number }> {
  const db = new Db(env.DB);
  const pages = await db.listPageVectors(siteId);
  const vectorsDeleted = await deletePagesVectors(env.VECTOR_INDEX, pages);
  await db.deleteSite(siteId);
  return { vectorsDeleted };
}

export async function getProgress(env: Env, siteId: string): Promise<IndexProgress> {
  return new Db(env.DB).progress(siteId);
}
