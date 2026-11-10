/**
 * D1 data access layer: row interfaces, SQL statements and a thin repository class.
 * Schema lives in migrations/ (0000_init.sql, 0001_queue_lease.sql).
 */
import type { IndexProgress } from '../types';

export type PageStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface SiteRow {
  id: string;
  domain: string;
  sitemap_url: string;
  created_at: string;
}

export interface PageRow {
  id: string;
  site_id: string;
  url: string;
  title: string | null;
  chunk_count: number;
  status: PageStatus;
  error: string | null;
  /** Number of times the page was claimed for indexing since it was last queued. */
  attempts: number;
  updated_at: string;
}

export interface QueryRow {
  id: string;
  site_id: string;
  prompt: string;
  response: string | null;
  created_at: string;
}

/** All SQL in one place so it is easy to audit. Positional parameters use ?1, ?2, ... */
export const SQL = {
  upsertSite: `
    INSERT INTO sites (id, domain, sitemap_url)
    VALUES (?1, ?2, ?3)
    ON CONFLICT (id) DO UPDATE SET domain = excluded.domain, sitemap_url = excluded.sitemap_url`,
  getSite: `SELECT * FROM sites WHERE id = ?1`,
  listSites: `SELECT * FROM sites ORDER BY created_at DESC`,
  deleteSite: `DELETE FROM sites WHERE id = ?1`,

  /**
   * Insert a page or reset an existing one back to the queue. Keyed on (site_id, url) rather than the
   * id, so rows created before page ids included the site id keep their id (and their vectors).
   */
  enqueuePage: `
    INSERT INTO pages (id, site_id, url, status, error, attempts, updated_at)
    VALUES (?1, ?2, ?3, 'pending', NULL, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (site_id, url) DO UPDATE SET
      status = 'pending', error = NULL, attempts = 0, updated_at = CURRENT_TIMESTAMP`,
  /**
   * Atomically claim the next pages: pending ones, plus "processing" ones whose lease expired (the
   * invocation that claimed them died). A single UPDATE is atomic in D1, so concurrent cron ticks and
   * /process calls never receive the same page. The claim refreshes `updated_at`, which starts the lease.
   * ?1 site, ?2 limit, ?3 lease modifier ("-15 minutes").
   */
  claimPendingForSite: `
    UPDATE pages SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM pages
      WHERE site_id = ?1
        AND (status = 'pending' OR (status = 'processing' AND updated_at < datetime('now', ?3)))
      ORDER BY updated_at ASC LIMIT ?2)
    RETURNING *`,
  /** Same as claimPendingForSite across all sites. ?1 limit, ?2 lease modifier. */
  claimPendingAny: `
    UPDATE pages SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM pages
      WHERE status = 'pending' OR (status = 'processing' AND updated_at < datetime('now', ?2))
      ORDER BY updated_at ASC LIMIT ?1)
    RETURNING *`,
  /** Hand a claimed page back to the queue without counting the attempt (e.g. Workers AI rate limit). */
  releasePage: `
    UPDATE pages SET status = 'pending', attempts = MAX(attempts - 1, 0) WHERE id = ?1 AND status = 'processing'`,
  markPageIndexed: `
    UPDATE pages SET title = ?2, chunk_count = ?3, status = 'indexed', error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1`,
  markPageFailed: `
    UPDATE pages SET status = 'failed', error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1`,
  pageStats: `SELECT status, COUNT(*) AS n FROM pages WHERE site_id = ?1 GROUP BY status`,
  pageStatsAll: `SELECT site_id, status, COUNT(*) AS n FROM pages GROUP BY site_id, status`,
  listPages: `SELECT id, url, chunk_count FROM pages WHERE site_id = ?1`,
  listPageVectors: `SELECT id, chunk_count FROM pages WHERE site_id = ?1 AND chunk_count > 0`,
  deletePage: `DELETE FROM pages WHERE id = ?1`,
  deletePagesForSite: `DELETE FROM pages WHERE site_id = ?1`,

  insertQuery: `INSERT INTO queries (id, site_id, prompt, response) VALUES (?1, ?2, ?3, ?4)`,
  listQueries: `
    SELECT id, site_id, prompt, response, created_at FROM queries
    WHERE site_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  countQueriesSince: `SELECT COUNT(*) AS n FROM queries WHERE site_id = ?1 AND created_at >= datetime('now', ?2)`,
  pruneQueries: `DELETE FROM queries WHERE created_at < datetime('now', ?1)`,
  deleteQueriesForSite: `DELETE FROM queries WHERE site_id = ?1`,
} as const;

/** D1 limits the number of bound parameters per statement; keep batches modest. */
const BATCH_SIZE = 50;

/** Progress with every counter at zero. */
export function emptyProgress(siteId: string): IndexProgress {
  return { siteId, total: 0, pending: 0, processing: 0, indexed: 0, failed: 0 };
}

function addCount(progress: IndexProgress, status: string, n: number): void {
  if (status === 'pending' || status === 'processing' || status === 'indexed' || status === 'failed') {
    progress[status] += n;
    progress.total += n;
  }
}

export class Db {
  constructor(private readonly d1: D1Database) {}

  // --- sites ---------------------------------------------------------------

  async upsertSite(id: string, domain: string, sitemapUrl: string): Promise<void> {
    await this.d1.prepare(SQL.upsertSite).bind(id, domain, sitemapUrl).run();
  }

  async getSite(id: string): Promise<SiteRow | null> {
    return this.d1.prepare(SQL.getSite).bind(id).first<SiteRow>();
  }

  async listSites(): Promise<SiteRow[]> {
    const { results } = await this.d1.prepare(SQL.listSites).all<SiteRow>();
    return results;
  }

  /** Remove a site together with its pages and chat history. */
  async deleteSite(id: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare(SQL.deleteQueriesForSite).bind(id),
      this.d1.prepare(SQL.deletePagesForSite).bind(id),
      this.d1.prepare(SQL.deleteSite).bind(id),
    ]);
  }

  // --- pages ---------------------------------------------------------------

  /** Queue URLs for crawling. Existing rows are reset to "pending" so re-indexing refreshes content. */
  async enqueuePages(siteId: string, pages: Array<{ id: string; url: string }>): Promise<void> {
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const slice = pages.slice(i, i + BATCH_SIZE);
      await this.d1.batch(slice.map((p) => this.d1.prepare(SQL.enqueuePage).bind(p.id, siteId, p.url)));
    }
  }

  /**
   * Claim up to `limit` pages for indexing (one site, or all sites when siteId is null). Claimed pages
   * are "processing" until marked indexed/failed or released; after `leaseMinutes` they are claimable
   * again, which recovers pages whose invocation was killed mid-crawl.
   */
  async claimPending(siteId: string | null, limit: number, leaseMinutes: number): Promise<PageRow[]> {
    const lease = `-${leaseMinutes} minutes`;
    const stmt = siteId
      ? this.d1.prepare(SQL.claimPendingForSite).bind(siteId, limit, lease)
      : this.d1.prepare(SQL.claimPendingAny).bind(limit, lease);
    const { results } = await stmt.all<PageRow>();
    return results;
  }

  /** Return claimed pages to the queue without counting the attempt. */
  async releasePages(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      await this.d1.batch(ids.slice(i, i + BATCH_SIZE).map((id) => this.d1.prepare(SQL.releasePage).bind(id)));
    }
  }

  async markPageIndexed(id: string, title: string, chunkCount: number): Promise<void> {
    await this.d1.prepare(SQL.markPageIndexed).bind(id, title, chunkCount).run();
  }

  async markPageFailed(id: string, error: string): Promise<void> {
    await this.d1.prepare(SQL.markPageFailed).bind(id, error.slice(0, 500)).run();
  }

  async progress(siteId: string): Promise<IndexProgress> {
    const { results } = await this.d1
      .prepare(SQL.pageStats)
      .bind(siteId)
      .all<{ status: PageStatus; n: number }>();
    const progress = emptyProgress(siteId);
    for (const row of results) addCount(progress, row.status, row.n);
    return progress;
  }

  /** Progress for every site in one query, keyed by site id. */
  async progressAll(): Promise<Map<string, IndexProgress>> {
    const { results } = await this.d1
      .prepare(SQL.pageStatsAll)
      .all<{ site_id: string; status: PageStatus; n: number }>();
    const map = new Map<string, IndexProgress>();
    for (const row of results) {
      const entry = map.get(row.site_id) ?? emptyProgress(row.site_id);
      addCount(entry, row.status, row.n);
      map.set(row.site_id, entry);
    }
    return map;
  }

  async listPages(siteId: string): Promise<Array<{ id: string; url: string; chunk_count: number }>> {
    const { results } = await this.d1
      .prepare(SQL.listPages)
      .bind(siteId)
      .all<{ id: string; url: string; chunk_count: number }>();
    return results;
  }

  async listPageVectors(siteId: string): Promise<Array<{ id: string; chunk_count: number }>> {
    const { results } = await this.d1
      .prepare(SQL.listPageVectors)
      .bind(siteId)
      .all<{ id: string; chunk_count: number }>();
    return results;
  }

  async deletePages(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      await this.d1.batch(ids.slice(i, i + BATCH_SIZE).map((id) => this.d1.prepare(SQL.deletePage).bind(id)));
    }
  }

  // --- queries -------------------------------------------------------------

  async logQuery(id: string, siteId: string, prompt: string, response: string): Promise<void> {
    await this.d1.prepare(SQL.insertQuery).bind(id, siteId, prompt, response).run();
  }

  async listQueries(siteId: string, limit: number): Promise<QueryRow[]> {
    const { results } = await this.d1.prepare(SQL.listQueries).bind(siteId, limit).all<QueryRow>();
    return results;
  }

  /** Chat log rows written for a site in the last `hours` hours. */
  async countQueriesSince(siteId: string, hours: number): Promise<number> {
    const row = await this.d1
      .prepare(SQL.countQueriesSince)
      .bind(siteId, `-${hours} hours`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Delete chat log rows older than `days` days. Returns the number of rows removed. */
  async pruneQueries(days: number): Promise<number> {
    const result = await this.d1.prepare(SQL.pruneQueries).bind(`-${days} days`).run();
    return result.meta?.changes ?? 0;
  }
}
