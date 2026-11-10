/**
 * Workers AI helpers: embeddings, RAG prompt construction and text generation.
 * No external API keys - everything runs through the `AI` binding.
 */
import type { ChatMessage, RetrievedChunk, Source } from '../types';

/**
 * Multilingual embedding model (100+ languages): a Vietnamese question finds Vietnamese or English pages.
 * Changing it requires a Vectorize index with EMBEDDING_DIMENSIONS dimensions and a re-crawl of every site.
 */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
// `@cf/meta/llama-3.1-8b-instruct` was deprecated by Cloudflare on 2026-05-30 (AiError 5028); the fp8 build is the drop-in.
export const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
/** Cross-encoder used to re-order the vector-search candidates before they reach the LLM. */
export const RERANK_MODEL = '@cf/baai/bge-reranker-base';
export const EMBEDDING_DIMENSIONS = 1024;

/** Texts per embedding call. bge-m3 documents no item limit; 50 keeps each request modest. */
const EMBED_BATCH_SIZE = 50;
/** Longest passage handed to the reranker (its window is ~512 tokens for query + passage). */
const RERANK_MAX_CHARS = 2000;
/** Generation settings tuned for factual, grounded answers. */
const MAX_OUTPUT_TOKENS = 768;
const TEMPERATURE = 0.2;
/** Keep the prompt well inside the model's ~8k token context window. */
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 1500;
/**
 * Appended to the user's question. Small models follow the language of the chat history (or of the
 * excerpts) over a system rule; a reminder right next to the question is what reliably works.
 */
export const LANGUAGE_REMINDER = '(Answer in the same language as this question.)';

/** Minimal structural view of the AI binding, decoupled from model-specific generics. */
type AiRunner = {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
};

type EmbeddingOutput = { shape?: number[]; data?: number[][] };
/**
 * Text generation output. Llama-family models return `{ response }`; OpenAI-compatible models
 * (GLM, Gemma 4, gpt-oss, ...) return `{ choices: [{ message: { content } }] }` and stream
 * `{ choices: [{ delta: { content } }] }`. Both shapes are accepted so CHAT_MODEL can be swapped.
 */
type TextGenerationOutput = {
  response?: string;
  choices?: Array<{ message?: { content?: string | null }; delta?: { content?: string | null } }>;
};

/** Answer text from either output shape ("" when absent). */
export function outputText(output: TextGenerationOutput | undefined): string {
  if (!output) return '';
  if (typeof output.response === 'string') return output.response;
  const choice = output.choices?.[0];
  return choice?.message?.content ?? choice?.delta?.content ?? '';
}

/** Raised when Workers AI reports a quota / rate limit problem. Mapped to HTTP 429. */
export class AiRateLimitError extends Error {
  constructor(message = 'Workers AI rate limit or daily quota reached. Please try again later.') {
    super(message);
    this.name = 'AiRateLimitError';
  }
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Workers AI error codes 3040 (rate limited) / 3036 (account limited) plus generic phrasing.
  return /rate.?limit|too many requests|\b429\b|\b3040\b|\b3036\b|daily limit|quota|capacity/i.test(msg);
}

function wrapAiError(err: unknown): never {
  if (isRateLimitError(err)) throw new AiRateLimitError();
  throw err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/** Embed a list of texts (batched). Returns one EMBEDDING_DIMENSIONS vector per input, in order. */
export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  const runner = ai as unknown as AiRunner;
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    let output: EmbeddingOutput;
    try {
      output = (await runner.run(EMBEDDING_MODEL, { text: batch, truncate_inputs: true })) as EmbeddingOutput;
    } catch (err) {
      wrapAiError(err);
    }
    const data = output.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`Embedding model returned ${data?.length ?? 0} vectors for ${batch.length} inputs`);
    }
    for (const vec of data) {
      if (vec.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Unexpected embedding size ${vec.length}, expected ${EMBEDDING_DIMENSIONS}`);
      }
      vectors.push(vec);
    }
  }
  return vectors;
}

/** Embed a single query string. */
export async function embedQuery(ai: Ai, text: string): Promise<number[]> {
  const [vector] = await embedTexts(ai, [text]);
  if (!vector) throw new Error('Embedding model returned no vector');
  return vector;
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

/** bge-reranker output: one relevance score (sigmoid, 0-1) per context index. */
type RerankOutput = { response?: Array<{ id?: number; score?: number }> };

/**
 * Re-order candidates with the reranker's scores. Pure and defensive: malformed or empty output
 * leaves the input order untouched; contexts the model did not score keep their vector order after
 * the scored ones. Each returned chunk carries the reranker score in `score`.
 */
export function applyRerank(chunks: RetrievedChunk[], output: RerankOutput | undefined): RetrievedChunk[] {
  const entries = output?.response;
  if (!Array.isArray(entries)) return chunks;
  const scored: RetrievedChunk[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    const id = entry?.id;
    const score = entry?.score;
    const chunk = typeof id === 'number' ? chunks[id] : undefined;
    if (!chunk || typeof score !== 'number' || !Number.isFinite(score) || seen.has(id as number)) continue;
    seen.add(id as number);
    scored.push({ ...chunk, score });
  }
  if (scored.length === 0) return chunks;
  scored.sort((a, b) => b.score - a.score);
  chunks.forEach((chunk, i) => {
    if (!seen.has(i)) scored.push(chunk);
  });
  return scored;
}

/**
 * Second retrieval stage: score every candidate against the question with a cross-encoder and sort
 * by that score. Bi-encoder similarity alone tends to favour chunks that merely share vocabulary
 * with the question (e.g. the site name on legal pages); the reranker reads question and passage
 * together and promotes the paragraph that actually answers it. Any failure (rate limit, model
 * error, odd output) falls back to the vector order so chat keeps working.
 */
export async function rerankChunks(ai: Ai, query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  if (chunks.length < 2) return chunks;
  const runner = ai as unknown as AiRunner;
  let output: RerankOutput;
  try {
    output = (await runner.run(RERANK_MODEL, {
      query,
      contexts: chunks.map((chunk) => ({ text: chunk.metadata.text.slice(0, RERANK_MAX_CHARS) })),
      top_k: chunks.length,
    })) as RerankOutput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ event: 'rerank.failed', message }));
    return chunks;
  }
  return applyRerank(chunks, output);
}

// ---------------------------------------------------------------------------
// RAG prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are DocFlare, a friendly and precise documentation assistant for {{DOMAIN}}.

Rules:
- Answer ONLY using the documentation excerpts below. Never guess or use outside knowledge.
- Reply in the language of the user's question (English question -> English answer, Vietnamese question -> Vietnamese answer), even when the excerpts are written in a different language. Translate the facts you use.
- Answer directly, as if you knew the documentation yourself. Do not quote or list the excerpts, do not mention "the context", "the excerpts" or "the provided information", and do not add citation markers such as [1]. The sources are shown to the user separately.
- If the excerpts do not contain the answer, say so briefly and suggest what the user could search for instead.
- Never invent URLs, commands, flags, settings or version numbers that are not in the excerpts.
- Be concise. Use Markdown: short paragraphs, bullet lists, and fenced code blocks for commands or code.

Documentation excerpts:
{{CONTEXT}}`;

/** Convert retrieved chunks into sources (1-based, relevance order, same order as the context). */
export function toSources(chunks: RetrievedChunk[]): Source[] {
  return chunks.map((chunk, i) => ({
    index: i + 1,
    url: chunk.metadata.url,
    title: chunk.metadata.title || chunk.metadata.url,
    score: Number(chunk.score.toFixed(4)),
  }));
}

/** Build the chat messages array for the generation model. */
export function buildRagMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: ChatMessage[] = [],
  domain = 'this website',
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const context =
    chunks.length === 0
      ? '(no relevant documentation found)'
      : chunks
          .map((chunk) => {
            const title = chunk.metadata.title || chunk.metadata.url;
            return `Source: ${title} (${chunk.metadata.url})\n${chunk.metadata.text}`;
          })
          .join('\n\n---\n\n');

  const system = SYSTEM_PROMPT.replace('{{DOMAIN}}', domain).replace('{{CONTEXT}}', context);

  const trimmedHistory = history
    .slice(-MAX_HISTORY_TURNS)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));

  return [
    { role: 'system', content: system },
    ...trimmedHistory,
    { role: 'user', content: `${question}\n\n${LANGUAGE_REMINDER}` },
  ];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Generate a complete answer (non-streaming). */
export async function generateAnswer(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const runner = ai as unknown as AiRunner;
  try {
    const output = (await runner.run(CHAT_MODEL, {
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
    })) as TextGenerationOutput;
    return outputText(output).trim();
  } catch (err) {
    wrapAiError(err);
  }
}

/**
 * Generate an answer as a stream. Workers AI returns Server-Sent Events of the form
 * `data: {"response":"token"}` terminated by `data: [DONE]`.
 */
export async function generateAnswerStream(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
): Promise<ReadableStream<Uint8Array>> {
  const runner = ai as unknown as AiRunner;
  try {
    const output = await runner.run(CHAT_MODEL, {
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      stream: true,
    });
    if (!(output instanceof ReadableStream)) {
      // Some environments ignore `stream: true`; fall back to a one-shot stream.
      const text = outputText(output as TextGenerationOutput).trim();
      return textToWorkersAiStream(text);
    }
    return output as ReadableStream<Uint8Array>;
  } catch (err) {
    wrapAiError(err);
  }
}

/** Wrap a plain string into the same SSE shape Workers AI emits, for uniform downstream handling. */
export function textToWorkersAiStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/**
 * Extract the `response` tokens from a Workers AI SSE byte stream and yield them as strings.
 * Handles chunk boundaries that split a line and a last line without a trailing newline.
 * Stopping early (consumer breaks out, `[DONE]`, error) cancels the upstream stream.
 */
export async function* iterateWorkersAiTokens(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let drained = false;

  try {
    while (!drained) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        buffer += decoder.decode() + '\n';
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let token = '';
        try {
          token = outputText(JSON.parse(payload) as TextGenerationOutput);
        } catch {
          // Ignore malformed keep-alive lines.
        }
        if (token) yield token;
      }
    }
  } finally {
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
