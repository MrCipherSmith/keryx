// Terminal-safe rendering of bus text (specification §7.3; review r1 F5, F11).
//
// Shared by the CLI (`src/commands/bus.ts`) and the surface-independent bus
// client (`./client.ts`): both print text a peer wrote (names, checkouts,
// branches, activity, event bodies) and neither may let it carry an escape
// sequence into the operator's terminal.
//
// review r1 F11: every control byte below is written as a `\x`/`\u` escape,
// never as a literal byte in the source. A previous version embedded the raw
// ESC (0x1B), BEL (0x07) and C1 (0x80-0x9F, via a literal U+009F character)
// bytes directly in the regex literals; a file that carries live escape
// sequences in its own source is exactly the kind of file a diff tool or
// `git`'s own binary-detection heuristics can stop treating as text.

import type { RenderedBusEvent } from "./client";

/**
 * Text written by peers, made safe for a terminal (review r1 F5): ANSI/VT
 * escape sequences (CSI, OSC, and any other ESC-introduced sequence) are
 * removed, every remaining C0/C1 control character and DEL becomes a space,
 * and runs of whitespace collapse to one. `--json` output is never passed
 * through this: it is data, and JSON escapes control characters itself.
 */
export function displaySafe(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex -- OSC ... BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
      // eslint-disable-next-line no-control-regex -- any other ESC sequence (ESC + one char)
      .replace(/\x1b[\s\S]?/g, "")
      // eslint-disable-next-line no-control-regex -- C1 CSI/OSC introducers and the rest of C0/C1, DEL
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * One rendered bus event as a single terminal line (review r1 F4, F11):
 * `⇄ [#<seq>] @<fromName> <kind>: <preview>`. Every free-text part is run
 * through `displaySafe` again — `preview` already is, from `./client.ts`,
 * but re-applying it here is idempotent and keeps this function safe on its
 * own, whatever future caller builds a `RenderedBusEvent` by hand.
 *
 * Both the readline shell and the TUI use this one function, so the two
 * surfaces render identically and a fix to the format only has one place to
 * land.
 */
export function formatBusEventLine(event: RenderedBusEvent): string {
  const seq = displaySafe(`#${event.seq}`);
  const fromName = displaySafe(event.fromName);
  const kind = displaySafe(event.kind);
  const preview = displaySafe(event.preview);
  return `⇄ [${seq}] @${fromName} ${kind}: ${preview}`;
}

/** Where a bus background failure was observed. */
export type BusErrorWhere = "poll" | "heartbeat" | "session" | "ack";

/**
 * A throttled `onError` printer (review r1 F10, F11): at most one
 * `bus: <where> failed: <message>` line per `windowMs` per `where`, so a
 * persistently failing poll or heartbeat does not spam the operator's
 * terminal once per interval forever. Each `where` has its own independent
 * window — a stuck heartbeat does not silence a poll failure or vice versa.
 */
export function makeBusErrorReporter(
  print: (line: string) => void,
  windowMs = 60_000,
): (err: unknown, where: BusErrorWhere) => void {
  const lastPrintedAt = new Map<BusErrorWhere, number>();
  return (err, where) => {
    const now = Date.now();
    const last = lastPrintedAt.get(where);
    if (last !== undefined && now - last < windowMs) return;
    lastPrintedAt.set(where, now);
    const message = err instanceof Error ? err.message : String(err);
    print(`bus: ${where} failed: ${displaySafe(message)}`);
  };
}
