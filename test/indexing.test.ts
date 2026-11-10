/**
 * Indexing pipeline against a real SQLite schema (migrations applied) and in-memory bindings:
 * per-site page ids, sitemap pruning, queue claims/leases, rate-limit release and redirect checks.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Db, type PageRow } from '../src/db/schema';
import { MAX_ATTEMPTS, processPendingPages, registerSite } from '../src/services/indexer';
import { pageIdFor } from '../src/utils/hash';
import { createEnv, mockFetch, pageResponse, sitemapResponse } from './helpers';

const SITEMAP = 'https://docs.example.com/sitemap.xml';
const A = 'https://docs.example.com/a';
const B = 'https://docs.example.com/b';

let restoreFetch: () => void = () => {};
afterEach(() => restoreFetch());

const pagesOf = (sqlite: ReturnType<typeof createEnv>['sqlite'], siteId: string) =>
  sqlite.query('SELECT * FROM pages WHERE site_id = ?1 ORDER BY url').all(siteId) as PageRow[];

describe('registerSite', () => {
  test('two sites listing the same URL each get their own page row', async () => {
    const { env, sqlite } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A]) });

    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);
    const second = await registerSite(env, 'docs-v2', SITEMAP, 'docs.example.com', 100);

    expect(second.queued).toBe(1);
    expect(pagesOf(sqlite, 'docs')).toHaveLength(1);
    expect(pagesOf(sqlite, 'docs-v2')).toHaveLength(1);
    expect(pagesOf(sqlite, 'docs')[0]?.id).not.toBe(pagesOf(sqlite, 'docs-v2')[0]?.id);
  });

  test('re-registering keeps rows created with the old URL-only page id', async () => {
    const { env, sqlite } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A]) });
    sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('docs', 'docs.example.com', ?1)`, [SITEMAP]);
    sqlite.run(
      `INSERT INTO pages (id, site_id, url, status, chunk_count) VALUES ('legacy-page-id', 'docs', ?1, 'indexed', 2)`,
      [A],
    );

    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);

    const rows = pagesOf(sqlite, 'docs');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('legacy-page-id');
    expect(rows[0]?.status).toBe('pending');
  });

  test('re-crawling deletes pages (and their vectors) that left the sitemap', async () => {
    const { env, sqlite, vectorize } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A, B]) });
    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);
    const idB = await pageIdFor('docs', B);
    sqlite.run(`UPDATE pages SET status = 'indexed', chunk_count = 2 WHERE id = ?1`, [idB]);

    restoreFetch();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A]) });
    const result = await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);

    expect(result.removed).toBe(1);
    expect(pagesOf(sqlite, 'docs').map((p) => p.url)).toEqual([A]);
    expect(vectorize.deleted).toEqual([`${idB}-0`, `${idB}-1`]);
  });

  test('a wildcard domain accepts the apex and every subdomain', async () => {
    const { env } = createEnv();
    restoreFetch = mockFetch({
      [SITEMAP]: sitemapResponse([A, 'https://api.example.com/x', 'https://example.com/', 'https://evil.test/y']),
    });
    const result = await registerSite(env, 'docs', SITEMAP, '*.example.com', 100);
    expect(result.queued).toBe(3);
  });
});

describe('processPendingPages', () => {
  test('concurrent claims never hand out the same page', async () => {
    const { env } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse(['a', 'b', 'c', 'd'].map((p) => `${A}${p}`)) });
    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);
    const db = new Db(env.DB);

    const [first, second] = await Promise.all([db.claimPending('docs', 2, 15), db.claimPending(null, 2, 15)]);
    const ids = [...(first ?? []), ...(second ?? [])].map((p) => p.id);

    expect(new Set(ids).size).toBe(4);
    expect(await db.claimPending('docs', 2, 15)).toEqual([]);
    expect((await db.progress('docs')).processing).toBe(4);
  });

  test('expired leases are reclaimed; a page that keeps killing the Worker is marked failed', async () => {
    const { env, sqlite } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A, B]), [A]: pageResponse('Page A') });
    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);
    // A: claimed once by an invocation that died an hour ago. B: died MAX_ATTEMPTS times already.
    sqlite.run(`UPDATE pages SET status = 'processing', attempts = 1, updated_at = datetime('now', '-1 hour')`);
    sqlite.run(`UPDATE pages SET attempts = ?1 WHERE url = ?2`, [MAX_ATTEMPTS, B]);

    const result = await processPendingPages(env, 'docs', 5);

    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(1);
    const [a, b] = pagesOf(sqlite, 'docs');
    expect(a?.status).toBe('indexed');
    expect(b?.status).toBe('failed');
    expect(b?.error).toContain(`Gave up after ${MAX_ATTEMPTS} attempts`);
  });

  test('a live lease is not stolen', async () => {
    const { env, sqlite } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A]) });
    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);
    sqlite.run(`UPDATE pages SET status = 'processing', attempts = 1, updated_at = datetime('now', '-1 minute')`);

    const result = await processPendingPages(env, null, 5);
    expect(result.processed).toBe(0);
  });

  test('a rate-limited batch hands its pages back without counting the attempt', async () => {
    const { env, sqlite, ai } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A, B]), [A]: pageResponse('A'), [B]: pageResponse('B') });
    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);
    ai.state.handler = () => {
      throw new Error('3040: Capacity temporarily exceeded, rate limited');
    };

    const result = await processPendingPages(env, 'docs', 5);

    expect(result.rateLimited).toBe(true);
    expect(result.processed).toBe(0);
    for (const page of pagesOf(sqlite, 'docs')) {
      expect(page.status).toBe('pending');
      expect(page.attempts).toBe(0);
    }
  });

  test('a page that redirects to another site is not indexed', async () => {
    const { env, sqlite, vectorize } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse([A]), [A]: pageResponse('Moved', 'https://evil.test/landing') });
    await registerSite(env, 'docs', SITEMAP, 'docs.example.com', 100);

    const result = await processPendingPages(env, 'docs', 5);

    expect(result.failed).toBe(1);
    expect(pagesOf(sqlite, 'docs')[0]?.error).toContain('redirected off-site');
    expect(vectorize.vectors.size).toBe(0);
  });
});
