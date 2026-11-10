/**
 * Shared types: Worker bindings, request/response payloads and internal models.
 */

/** Bindings and variables declared in wrangler.toml (plus secrets). */
export interface Env {
  /** Workers AI binding - embeddings and text generation. */
  AI: Ai;
  /** Vectorize index (1024 dimensions for bge-m3, cosine). */
  VECTOR_INDEX: VectorizeIndex;
  /** D1 database. */
  DB: D1Database;
  /** Static assets binding (public/). */
  ASSETS: Fetcher;

  /** Secret: bearer token for /api/sites/* management routes. */
  ADMIN_TOKEN?: string;
  /** Comma-separated list of extra origins allowed to call /api/chat ("*" = any). */
  ALLOWED_ORIGINS?: string;
  /** Max URLs taken from a sitemap per indexing run. */
  MAX_PAGES?: string;
  /** Pages processed per cron tick / process call. */
  INDEX_BATCH_SIZE?: string;
  /** Chunks retrieved per question. */
  TOP_K?: string;
  /** "false" disables the reranking stage (default on). */
  RERANK?: string;
  /** Max answered questions per site in a rolling 24 hours ("0" = unlimited). */
  DAILY_CHAT_LIMIT?: string;
  /** Days of chat log kept in the `queries` table ("0" = keep forever). */
  QUERY_RETENTION_DAYS?: string;
  /** Workers Rate Limiting binding: per site + client IP burst limit on /api/chat. */
  CHAT_RATE_LIMITER?: RateLimit;
}

/** Hono generic environment. */
export type AppBindings = { Bindings: Env };

/** Resolved numeric configuration with defaults applied. */
export interface AppConfig {
  maxPages: number;
  indexBatchSize: number;
  topK: number;
  /** Rerank vector-search candidates with a cross-encoder before prompting. */
  rerank: boolean;
  allowedOrigins: string[];
  /** 0 = unlimited. */
  dailyChatLimit: number;
  /** 0 = keep forever. */
  queryRetentionDays: number;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface IndexSiteRequest {
  /** Site slug, e.g. "my-docs". */
  siteId: string;
  /** Absolute URL of the XML sitemap (or sitemap index). */
  sitemapUrl: string;
  /**
   * Hostname allowed to embed the widget ("docs.example.com" or "*.example.com"). Defaults to the
   * domain already registered for this siteId, or the sitemap hostname for a new site.
   */
  domain?: string;
  /** When true, also crawl a first batch of pages inline. Default false. */
  process?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  siteId: string;
  question: string;
  /** Stream the answer as Server-Sent Events. Default false. */
  stream?: boolean;
  /** Previous turns, oldest first. Max 10 entries. */
  history?: ChatMessage[];
}

export interface Source {
  /** 1-based position in the sources list (relevance order). */
  index: number;
  url: string;
  title: string;
  /** Cosine similarity score returned by Vectorize. */
  score: number;
}

export interface ChatResponse {
  id: string;
  answer: string;
  sources: Source[];
}

export interface IndexProgress {
  siteId: string;
  total: number;
  pending: number;
  /** Claimed by a running cron tick or /process call. */
  processing: number;
  indexed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Internal models
// ---------------------------------------------------------------------------

/** Metadata stored alongside every vector in Vectorize. Must stay flat (string/number/boolean). */
export type ChunkMetadata = {
  siteId: string;
  pageId: string;
  url: string;
  title: string;
  chunk: number;
  text: string;
};

export interface TextChunk {
  index: number;
  text: string;
}

export interface ExtractedPage {
  url: string;
  title: string;
  /** <meta name="description"> (or og:description), possibly empty. */
  description: string;
  text: string;
}

export interface RetrievedChunk {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

/** Error carrying an HTTP status, turned into a JSON response by the app error handler. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
