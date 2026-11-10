/**
 * HTTP routes through the real Hono app with test bindings: admin token policy, site registration,
 * chat abuse guards and error redaction.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import worker from '../src/index';
import type { Env } from '../src/types';
import { createCtx, createEnv, mockFetch, sitemapResponse } from './helpers';

const REMOTE = 'https://docflare-ai.example.workers.dev';
const LOCAL = 'http://localhost:8787';
const SITEMAP = 'https://docs.example.com/sitemap.xml';

let restoreFetch: () => void = () => {};
afterEach(() => restoreFetch());

async function call(env: Env, url: string, init: RequestInit = {}) {
  const res = await worker.fetch(new Request(url, init), env, createCtx().ctx);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

const admin = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
});

const chat = (siteId: string, question = 'How do I deploy?'): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
  body: JSON.stringify({ siteId, question }),
});

describe('admin token', () => {
  test.each(['dev-token-change-me', 'short'])('example or short token %p only works on localhost', async (token) => {
    const { env } = createEnv({ ADMIN_TOKEN: token });

    const remote = await call(env, `${REMOTE}/api/sites`, admin(token));
    expect(remote.res.status).toBe(503);
    expect(remote.body.code).toBe('admin_token_weak');

    const local = await call(env, `${LOCAL}/api/sites`, admin(token));
    expect(local.res.status).toBe(200);
  });

  test('a strong token works remotely and a wrong one is rejected', async () => {
    const { env } = createEnv();
    expect((await call(env, `${REMOTE}/api/sites`, admin(env.ADMIN_TOKEN as string))).res.status).toBe(200);
    expect((await call(env, `${REMOTE}/api/sites`, admin('x'.repeat(32)))).res.status).toBe(401);
  });
});

describe('POST /api/sites/index', () => {
  const register = (env: Env, body: Record<string, unknown>) =>
    call(env, `${REMOTE}/api/sites/index`, admin(env.ADMIN_TOKEN as string, { method: 'POST', body: JSON.stringify(body) }));

  test('re-indexing without a domain keeps the registered (wildcard) domain', async () => {
    const { env } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse(['https://docs.example.com/a']) });

    const first = await register(env, { siteId: 'docs', sitemapUrl: SITEMAP, domain: '*.Example.com' });
    expect(first.res.status).toBe(202);
    expect(first.body.domain).toBe('*.example.com');

    const recrawl = await register(env, { siteId: 'docs', sitemapUrl: SITEMAP });
    expect(recrawl.body.domain).toBe('*.example.com');
  });

  test('a new site defaults to the sitemap host', async () => {
    const { env } = createEnv();
    restoreFetch = mockFetch({ [SITEMAP]: sitemapResponse(['https://docs.example.com/a']) });
    expect((await register(env, { siteId: 'docs', sitemapUrl: SITEMAP })).body.domain).toBe('docs.example.com');
  });

  test.each(['https://', 'a..b', 'example.com.', 'exa mple.com'])('rejects domain %p', async (domain) => {
    const { env } = createEnv();
    const { res, body } = await register(env, { siteId: 'docs', sitemapUrl: SITEMAP, domain });
    expect(res.status).toBe(400);
    expect(body.code).toBe('invalid_domain');
  });
});

describe('POST /api/chat', () => {
  const addSite = (sqlite: ReturnType<typeof createEnv>['sqlite']) =>
    sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('docs', 'docs.example.com', ?1)`, [SITEMAP]);

  test('the per-client rate limiter answers 429 before touching the database', async () => {
    const keys: string[] = [];
    const { env } = createEnv({
      CHAT_RATE_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });

    const { res, body } = await call(env, `${REMOTE}/api/chat`, chat('docs'));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(body.code).toBe('rate_limited');
    expect(keys).toEqual(['docs:203.0.113.7']);
  });

  test('the daily per-site limit stops answering once reached', async () => {
    const { env, sqlite } = createEnv({ DAILY_CHAT_LIMIT: '2' });
    addSite(sqlite);
    sqlite.run(`INSERT INTO queries (id, site_id, prompt) VALUES ('q1', 'docs', 'old'), ('q2', 'docs', 'old')`);
    sqlite.run(`INSERT INTO queries (id, site_id, prompt, created_at) VALUES ('q0', 'docs', 'x', datetime('now', '-2 days'))`);

    const limited = await call(env, `${REMOTE}/api/chat`, chat('docs'));
    expect(limited.res.status).toBe(429);
    expect(limited.body.code).toBe('daily_limit_reached');

    sqlite.run(`DELETE FROM queries WHERE id = 'q2'`);
    const answered = await call(env, `${REMOTE}/api/chat`, chat('docs'));
    expect(answered.res.status).toBe(200);
    expect(typeof answered.body.answer).toBe('string');
  });

  test('Workers AI errors are logged, not returned to the public client', async () => {
    const { env, sqlite, ai } = createEnv();
    addSite(sqlite);
    ai.state.handler = () => {
      const err = new Error('5028: internal model detail');
      err.name = 'AiError';
      throw err;
    };

    const { res, body } = await call(env, `${REMOTE}/api/chat`, chat('docs'));

    expect(res.status).toBe(502);
    expect(body.code).toBe('ai_error');
    expect(String(body.error)).not.toContain('internal model detail');
  });
});
