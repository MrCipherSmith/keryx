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
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./supervise";

/** Decode a byte stream and yield complete lines, newline stripped. */
async function* readLines(stream: ReadableStream<Uint8Array> | undefined): AsyncGenerator<string> {
  if (stream === undefined) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // `\r` so a CRLF-emitting CLI does not leave a stray carriage return
        // inside JSON that then fails to parse and is counted as version drift.
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        newline = buffer.indexOf("\n");
      }
    }
    // A final line without a trailing newline is still a line. Dropping it would
    // silently lose the terminal event of any CLI that does not end with one.
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
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
export function createBunSpawnPort(spawnImpl: BunSpawnLike = Bun.spawn as unknown as BunSpawnLike): ExternalSpawnPort {
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

      return {
        stdout: readLines(proc.stdout),
        stderr: readLines(proc.stderr),
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
