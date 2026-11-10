/** Chat SSE stream: normal completion, client disconnect and upstream failure. */
import { describe, expect, test } from 'bun:test';
import { buildChatStream } from '../src/services/stream';

const encoder = new TextEncoder();
const tokenLine = (text: string) => encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`);

/** Workers AI-like stream that emits `count` tokens (forever when Infinity), one per tick. */
function aiTokens(count: number) {
  const state = { cancelled: false, sent: 0 };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(2);
      if (state.sent >= count) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      controller.enqueue(tokenLine(`t${state.sent++} `));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const withTimeout = <T>(p: Promise<T>, ms = 1000) =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error('timed out')))]);

describe('buildChatStream', () => {
  test('forwards every token and logs the full answer', async () => {
    const { stream: ai } = aiTokens(3);
    const logged: string[] = [];
    const { stream, finished } = buildChatStream('id-1', [], ai, async (a) => void logged.push(a));

    const text = await new Response(stream).text();
    await withTimeout(finished);

    expect(text).toContain('event: meta');
    expect(text.match(/event: token/g)).toHaveLength(3);
    expect(text).toContain('event: done');
    expect(logged).toEqual(['t0 t1 t2']);
  });

  test('a client disconnect stops generation and still logs the partial answer', async () => {
    const { stream: ai, state } = aiTokens(Infinity);
    const logged: string[] = [];
    const { stream, finished } = buildChatStream('id-2', [], ai, async (a) => void logged.push(a));

    const reader = stream.getReader();
    await reader.read(); // meta
    await reader.read(); // first token
    await reader.cancel();
    await withTimeout(finished);

    expect(state.cancelled).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toStartWith('t0');
  });

  test('an upstream failure ends the stream with a generic error event', async () => {
    let pulls = 0;
    const ai = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(tokenLine('partial'));
        else controller.error(new Error('upstream secret detail'));
      },
    });
    const logged: string[] = [];
    const { stream, finished } = buildChatStream('id-3', [], ai, async (a) => void logged.push(a));

    const text = await new Response(stream).text();
    await withTimeout(finished);

    expect(text).toContain('event: error');
    expect(text).not.toContain('secret detail');
    expect(logged).toEqual(['partial']);
  });
});
