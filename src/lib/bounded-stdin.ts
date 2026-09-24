/**
 * Read stdin to EOF, or give up at a deadline and RELEASE the read.
 *
 * Hook entry points are handed their payload on stdin by a harness that writes
 * and then closes. When something does not close it — a CI step, `ssh host
 * 'keryx …'` without a tty, a parent that spawns with `stdin: "pipe"` and never
 * writes — an unbounded read waits forever, and a hook that never exits wedges
 * the tool call it was supposed to gate. For a guard whose stated contract is
 * fail-open, hanging is the one failure mode worse than allowing.
 *
 * Two things are load-bearing and only one of them is obvious:
 *
 * 1. The deadline. Without it the read never returns.
 * 2. Cancelling the reader. Racing `Bun.stdin.text()` against a timer resolves
 *    the RACE, but the abandoned read keeps its own handle on the event loop —
 *    so the process writes its output and still never exits. `process.stdin
 *    .pause()` and `.unref()` do not release it either; they act on the Node
 *    stream, and `Bun.stdin.text()` holds a separate one. Cancelling the reader
 *    is what actually lets the process go.
 *
 * Partial data survives: `reader.cancel()` resolves a pending read with
 * `done: true` rather than rejecting, so whatever arrived before the deadline is
 * returned and only a genuinely unreadable stdin reaches the `catch`.
 *
 * O2-6: bounded in bytes too, not just in time — a caller that never closes
 * stdin but keeps writing to it (same failure shape the deadline above
 * covers, just via volume instead of silence) would otherwise have this
 * buffer every byte into memory before any caller-side size check runs. Once
 * `maxBytes` is exceeded, reading stops (the reader is cancelled, same as a
 * deadline trip) rather than continuing to grow `chunks` — the caller still
 * sees a result whose length is over the limit and can reject it, it is just
 * never asked to hold an unbounded one to get there. The byte cap is opt-in
 * (defaults to no cap); callers that need one pass it explicitly. The ctx
 * guard reads unbounded as before for backwards compatibility.
 */
export const LEARN_OBSERVE_MAX_STDIN_BYTES = 1024 * 1024 + 1; // 1 MiB + 1 byte

export async function readStdinBounded(deadlineMs: number, maxBytes: number = Number.POSITIVE_INFINITY): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }
  const reader = Bun.stdin.stream().getReader();
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), deadlineMs);
  timer.unref?.();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        total += chunk.length;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}
