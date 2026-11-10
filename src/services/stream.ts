/**
 * Chat SSE protocol: re-emits Workers AI tokens as DocFlare's own events.
 *   event: meta   {id, sources}
 *   event: token  {text}
 *   event: done   {id}
 *   event: error  {message}
 */
import type { Source } from '../types';
import { iterateWorkersAiTokens } from './ai';

const STREAM_ERROR_MESSAGE = 'The answer was interrupted. Please try again.';

/** Encode one custom SSE event. */
export function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Build the response stream for one answer. The full answer is collected and handed to `onComplete`
 * for persistence; `finished` resolves once that is done, whatever happened to the stream.
 * When the client disconnects, token reading stops, which cancels the Workers AI stream so the model
 * stops generating (and spending quota) for nobody.
 */
export function buildChatStream(
  id: string,
  sources: Source[],
  aiStream: ReadableStream<Uint8Array>,
  onComplete: (answer: string) => Promise<void>,
): { stream: ReadableStream<Uint8Array>; finished: Promise<void> } {
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let open = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /** Enqueue unless the client is gone; returns false once the stream can no longer be written. */
      const send = (event: string, data: unknown): boolean => {
        if (!open) return false;
        try {
          controller.enqueue(sseEvent(event, data));
        } catch {
          open = false;
        }
        return open;
      };

      let answer = '';
      try {
        send('meta', { id, sources });
        for await (const token of iterateWorkersAiTokens(aiStream)) {
          answer += token;
          if (!send('token', { text: token })) break;
        }
        send('done', { id });
      } catch (err) {
        console.error(
          JSON.stringify({ event: 'chat.stream_failed', message: err instanceof Error ? err.message : String(err) }),
        );
        send('error', { message: STREAM_ERROR_MESSAGE });
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // Closed or cancelled concurrently: nothing left to do.
          }
        }
        try {
          await onComplete(answer.trim());
        } catch (err) {
          console.error(
            JSON.stringify({ event: 'chat.log_failed', message: err instanceof Error ? err.message : String(err) }),
          );
        } finally {
          resolveFinished();
        }
      }
    },
    cancel() {
      open = false;
    },
  });

  return { stream, finished };
}
