// The seam between an adapter, which owns the child process, and whatever
// supervises it.
//
// The arena's watchdog was written and tested and never called: the only bound on
// an arm was each adapter's own `setTimeout`, a wall clock and nothing else. The
// watchdog could not be called from `runArenaArm`, because the thing it has to
// watch — the child's pid and whether it is still producing anything — exists only
// inside the adapter. This is the smallest interface that hands those two facts
// out and gets a verdict back, without the benchmark layer importing the arena.

/** What an adapter exposes about its running child. */
export interface SupervisedChild {
  readonly pid: number;
  /** Milliseconds since the child last produced anything observable. */
  silenceMs(): number;
}

/** A running supervision, stopped by the adapter once the child has exited. */
export interface Supervision {
  stop(): void;
  /** Set when the supervisor killed the child; the adapter reports it instead of whatever the corpse left. */
  readonly killReason: string | undefined;
  readonly killDetail: string | undefined;
}

export type Supervise = (child: SupervisedChild) => Supervision;

/**
 * An arm the supervisor killed.
 *
 * Its own type so the sweep can record the kill reason as a field, and so an
 * adapter reports the kill rather than the "no turn_end" or "no result event" a
 * killed process leaves behind — the less specific message would hide the cause.
 */
export class ArmKilledError extends Error {
  constructor(
    readonly killReason: string,
    detail: string | undefined,
  ) {
    super(`watchdog killed the arm: ${killReason}${detail === undefined ? "" : ` — ${detail}`}`);
    this.name = "ArmKilledError";
  }
}

/** Throw when the supervision killed the child. Called after the child exits. */
export function throwIfKilled(supervision: Supervision | undefined): void {
  if (supervision?.killReason !== undefined) throw new ArmKilledError(supervision.killReason, supervision.killDetail);
}

/**
 * Read a stream to the end, noting when each chunk arrived.
 *
 * `new Response(stream).text()` answers only at the end, so an adapter that used
 * it could not say whether its child had been silent for five minutes or had
 * printed a line a second ago.
 */
export async function readTracked(stream: ReadableStream<Uint8Array>, onChunk: () => void): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    onChunk();
  }
  return text + decoder.decode();
}
