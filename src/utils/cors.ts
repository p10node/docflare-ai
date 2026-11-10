/**
 * CORS helpers for multi-domain widget embedding.
 *
 * Strategy:
 *  - Preflight (OPTIONS) requests are always answered with the caller's Origin reflected,
 *    because the site id is only known once the JSON body is parsed.
 *  - The /api/chat handler then enforces that the Origin matches the site's registered
 *    domain (or the global ALLOWED_ORIGINS list) and returns 403 otherwise.
 *  - Management routes are protected by ADMIN_TOKEN, so reflecting the Origin is harmless there.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types';

const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';
const MAX_AGE_SECONDS = 86400;

/** Parse the comma-separated ALLOWED_ORIGINS variable into a clean list. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_PATTERN = new RegExp(`^(?:\\*\\.)?(?:${HOST_LABEL}\\.)*${HOST_LABEL}$`);

/**
 * Normalize a site domain: "https://Docs.Example.com/path" -> "docs.example.com"; "*.example.com" is
 * kept as a wildcard. Returns null for anything that is not a plain hostname, e.g. "", "https://",
 * "a..b" or "example.com." (an empty domain would block the widget everywhere and let the crawler
 * accept any trailing-dot host).
 */
export function normalizeDomain(raw: string): string | null {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:?#].*$/, '');
  return domain.length <= 253 && DOMAIN_PATTERN.test(domain) ? domain : null;
}

/** Build the CORS response headers for a given request Origin. */
export function buildCorsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': String(MAX_AGE_SECONDS),
    Vary: 'Origin',
  };
}

/**
 * Match a hostname against a domain pattern.
 *  - "docs.example.com" matches exactly (and its "www." variant)
 *  - "*.example.com" matches any subdomain and the apex domain
 */
export function hostnameMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (!pat) return false;
  if (pat.startsWith('*.')) {
    const base = pat.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pat || host === 'www.' + pat || 'www.' + host === pat;
}

/**
 * Decide whether a browser Origin may talk to a site's chat endpoint.
 * Requests without an Origin header (curl, server-to-server) are allowed.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  siteDomain: string | null,
  allowList: string[],
): boolean {
  if (!origin) return true;
  if (allowList.includes('*')) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  // Global allow-list: full origins ("https://app.example.com") or bare hostnames.
  for (const entry of allowList) {
    if (entry === origin) return true;
    if (hostnameMatches(url.hostname, entry)) return true;
  }

  // Local development convenience.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;

  return siteDomain ? hostnameMatches(url.hostname, siteDomain) : false;
}

/** Hono middleware: answers preflight requests and appends CORS headers to every response. */
export function cors(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const origin = c.req.header('Origin') ?? null;
    const headers = buildCorsHeaders(origin);

    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    await next();

    // Re-create the response so headers are mutable even for proxied/immutable responses.
    const res = new Response(c.res.body, c.res);
    for (const [key, value] of Object.entries(headers)) res.headers.set(key, value);
    c.res = res;
  };
}
