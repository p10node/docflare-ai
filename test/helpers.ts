/**
 * Test doubles for the Worker bindings: D1 on top of bun:sqlite (same SQLite dialect, real migrations),
 * an in-memory Vectorize index, a scriptable Workers AI binding and a fetch mock.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDING_DIMENSIONS } from '../src/services/ai';
import type { Env } from '../src/types';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

class TestStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly params: SQLQueryBindings[] = [],
  ) {}

  bind(...params: SQLQueryBindings[]): TestStatement {
    return new TestStatement(this.db, this.sql, params);
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return { results: this.db.query(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...this.params) as T | null) ?? null;
  }

  async run(): Promise<{ results: []; success: true; meta: { changes: number } }> {
    return { results: [], success: true, meta: { changes: this.runSync() } };
  }

  runSync(): number {
    return this.db.query(this.sql).run(...this.params).changes;
  }
}

/** A D1Database backed by an in-memory SQLite database with every migration applied. */
export function createTestDb(): { d1: D1Database; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  const d1 = {
    prepare: (sql: string) => new TestStatement(sqlite, sql),
    batch: async (statements: TestStatement[]) => sqlite.transaction(() => statements.map((s) => s.runSync()))(),
  };
  return { d1: d1 as unknown as D1Database, sqlite };
}

export function createVectorIndex() {
  const vectors = new Map<string, VectorizeVector>();
  const deleted: string[] = [];
  const index = {
    async upsert(batch: VectorizeVector[]) {
      for (const v of batch) vectors.set(v.id, v);
      return { mutationId: 'test' };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) {
        deleted.push(id);
        vectors.delete(id);
      }
      return { mutationId: 'test' };
    },
    async query() {
      return { matches: [], count: 0 };
    },
  };
  return { index: index as unknown as VectorizeIndex, vectors, deleted };
}

type AiHandler = (model: string, inputs: Record<string, unknown>) => unknown;

/** Workers AI double: embeddings return constant EMBEDDING_DIMENSIONS vectors unless `handler` says otherwise. */
export function createAi(handler?: AiHandler) {
  const state = { handler };
  const ai = {
    async run(model: string, inputs: Record<string, unknown>) {
      if (state.handler) return state.handler(model, inputs);
      if (Array.isArray(inputs.text)) {
        return { data: inputs.text.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)) };
      }
      return { response: 'test answer' };
    },
  };
  return { ai: ai as unknown as Ai, state };
}

export function createEnv(overrides: Partial<Env> = {}) {
  const { d1, sqlite } = createTestDb();
  const vectorize = createVectorIndex();
  const ai = createAi();
  const env: Env = {
    AI: ai.ai,
    VECTOR_INDEX: vectorize.index,
    DB: d1,
    ASSETS: {} as Fetcher,
    ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
    ...overrides,
  };
  return { env, sqlite, vectorize, ai };
}

export function createCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };
  return { ctx: ctx as unknown as ExecutionContext, pending };
}

/** Replace global fetch with a URL -> Response map. Returns a restore function. */
export function mockFetch(routes: Record<string, () => Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function sitemapResponse(urls: string[]): () => Response {
  const body = `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
  return () => new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}

/** An HTML page; `finalUrl` simulates the URL the response ended up at after redirects. */
export function pageResponse(title: string, finalUrl?: string): () => Response {
  const html =
    `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>` +
    `<p>This is the documentation page about ${title}, long enough to be indexed.</p></main></body></html>`;
  return () => {
    const res = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (finalUrl) Object.defineProperty(res, 'url', { value: finalUrl });
    return res;
  };
}
