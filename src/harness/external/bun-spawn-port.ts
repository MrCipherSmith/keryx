// The real `ExternalSpawnPort`, backed by `Bun.spawn` (flow 176, T14).
//
// Everything else in `src/harness/external/` is pure or fake-injectable; this is
// the single file that actually creates an operating-system process, and it is
// deliberately the smallest one that can be. It owns exactly three concerns the
// supervisor must not: process creation, line framing, and stream teardown.
//
// Three rules here are not stylistic, and each has a measured failure behind it:
//
//   - **stdin is never inherited.** `"ignore"` closes it and `"pipe"` opens a
//     writer; there is no third option. A codex run that inherited an open stdin
//     printed "Reading additional input from stdin…" and waited forever.
//   - **Streams are framed into COMPLETE LINES here.** claude's `system/init`
//     event is multiple kilobytes because it enumerates the whole tool roster
//     and command list, so it spans read chunks by construction. A supervisor
//     holding a partial-line buffer would be the wrong place for that knowledge.
//   - **`kill()` must eventually close the pipes.** The supervisor races its
//     deadline against the reads precisely because a `kill` can reach only a
//     wrapper while the real CLI outlives it holding the pipes — the reason the
//     reference implementation's `npx`-wrapped runs hung past their timeout.
//     This port kills the process directly (no wrapper) and aborts its readers,
//     so the abandoned generators terminate instead of leaking.
import { ACP_DEFAULT_MAX_LINE_BYTES } from "../../acp/framing";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./supervise";

/**
 * The longest line this port buffers before giving up (flow 292 T13).
 *
 * The same 64 MiB ceiling keryx's own ACP agent side applies to its input
 * (`ACP_DEFAULT_MAX_LINE_BYTES`, `src/acp/framing.ts`), measured the same way:
 * UTF-16 code units in the undelimited buffer. A child that streams hundreds of
 * megabytes without a newline — hostile or broken — otherwise grows this buffer
 * until the keryx process dies of memory. Shared by every external transport:
 * the claude/codex codecs see the overflow as a failed stream read plus a killed
 * child; the ACP client sees its pending requests closed with this reason.
 */
export const DEFAULT_EXTERNAL_MAX_LINE_BYTES = ACP_DEFAULT_MAX_LINE_BYTES;

/** Thrown from a line stream whose undelimited buffer passed the ceiling. */
export class ExternalLineTooLongError extends Error {
  constructor(
    readonly stream: "stdout" | "stderr",
    readonly maxLineBytes: number,
  ) {
    super(
      `the child's ${stream} sent more than ${maxLineBytes} bytes without a newline; ` +
        "the run was stopped and the child killed",
    );
    this.name = "ExternalLineTooLongError";
  }
}

/**
 * Decode a byte stream and yield complete lines, newline stripped. Over
 * `maxLineBytes` without a newline, `onOverflow` runs (the port kills the child
 * there) and the generator throws {@link ExternalLineTooLongError}.
 *
 * LINEAR in the input (flow 292 T14). The first version appended every chunk
 * to one string and searched the whole string for a newline each time: a line
 * built from many small chunks was copied and re-scanned once per chunk, and
 * enforcing the 64 MiB ceiling peaked near 1 GB. Now each decoded chunk is
 * scanned once, only from where the previous search in it stopped; the pieces
 * of a pending line are kept in an array with a running length and joined once,
 * when the line completes. `onScan` reports how many characters each search
 * covered, so a test can pin that total to the input size.
 */
async function* readLines(
  stream: ReadableStream<Uint8Array> | undefined,
  name: "stdout" | "stderr",
  maxLineBytes: number,
  onOverflow: () => void,
  onScan?: (chars: number) => void,
): AsyncGenerator<string> {
  if (stream === undefined) return;
  const decoder = new TextDecoder();
  const pending: string[] = [];
  let pendingLength = 0;
  const reader = stream.getReader();
  const strip = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);
  const take = (last: string): string => {
    pending.push(last);
    const line = pending.length === 1 ? last : pending.join("");
    pending.length = 0;
    pendingLength = 0;
    return line;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      onScan?.(text.length);
      let from = 0;
      let newline = text.indexOf("\n", from);
      while (newline !== -1) {
        // `\r` so a CRLF-emitting CLI does not leave a stray carriage return
        // inside JSON that then fails to parse and is counted as version drift.
        yield strip(take(text.slice(from, newline)));
        from = newline + 1;
        newline = text.indexOf("\n", from);
      }
      if (from < text.length) {
        pending.push(text.slice(from));
        pendingLength += text.length - from;
      }
      if (pendingLength > maxLineBytes) {
        pending.length = 0;
        pendingLength = 0;
        onOverflow();
        void reader.cancel().catch(() => undefined);
        throw new ExternalLineTooLongError(name, maxLineBytes);
      }
    }
    // A final line without a trailing newline is still a line. Dropping it would
    // silently lose the terminal event of any CLI that does not end with one.
    const tail = decoder.decode();
    if (tail.length > 0) {
      pending.push(tail);
      pendingLength += tail.length;
    }
    if (pendingLength > 0) yield strip(take(""));
  } finally {
    reader.releaseLock();
  }
}

/** The minimal shape this port needs from `Bun.spawn`, so a unit test can supply one. */
export interface BunSpawnLike {
  (
    argv: readonly string[],
    opts: {
      cwd: string;
      env: Record<string, string>;
      stdin: "ignore" | "pipe";
      stdout: "pipe";
      stderr: "pipe";
    },
  ): {
    readonly stdout: ReadableStream<Uint8Array> | undefined;
    readonly stderr: ReadableStream<Uint8Array> | undefined;
    readonly stdin?: { write(text: string): void; flush?(): void } | undefined;
    readonly exited: Promise<number>;
    kill(): void;
  };
}

/**
 * Build the real spawn port.
 *
 * `spawnImpl` is injectable only so this file's own framing and teardown can be
 * tested without an operating-system process; production passes `Bun.spawn`.
 * Note this is NOT the subsystem's test seam — that is `ExternalSpawnPort`
 * itself, which every other test substitutes wholesale.
 */
export function createBunSpawnPort(
  spawnImpl: BunSpawnLike = Bun.spawn as unknown as BunSpawnLike,
  options: { readonly maxLineBytes?: number; readonly onScan?: (chars: number) => void } = {},
): ExternalSpawnPort {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_EXTERNAL_MAX_LINE_BYTES;
  return {
    spawn(argv: readonly string[], opts: ExternalSpawnOptions): SpawnedProcess {
      const proc = spawnImpl(argv, {
        cwd: opts.cwd,
        env: opts.env,
        // Never `"inherit"`. The union does not offer it, and this is where that
        // guarantee becomes real.
        stdin: opts.stdin,
        stdout: "pipe",
        stderr: "pipe",
      });

      const killOnOverflow = (): void => {
        try {
          proc.kill();
        } catch {
          // Already gone: nothing left to stop.
        }
      };
      return {
        stdout: readLines(proc.stdout, "stdout", maxLineBytes, killOnOverflow, options.onScan),
        stderr: readLines(proc.stderr, "stderr", maxLineBytes, killOnOverflow, options.onScan),
        writeStdin(text: string): void {
          // A one-shot run has no stdin writer; the handle refuses the call
          // before it reaches here, so silence is correct rather than a throw.
          proc.stdin?.write(text);
          proc.stdin?.flush?.();
        },
        kill(): void {
          proc.kill();
        },
        exited: proc.exited,
      };
    },
  };
}
