// Keep what an arm actually did, not only what it scored.
//
// A result row says an arm found one gold file of four. It cannot say why: whether
// the agent never searched, searched the wrong words, or held the answer and
// dropped it. The first smoke run that produced a surprising number — keryx's own
// shell finding one file in both arms while the grok CLI found all four on the same
// model — had no way to answer that, because every adapter read its stream into
// memory and threw it away, and the keryx events file lived in a temp directory
// deleted in a `finally`.
//
// Written BEFORE the answer is interpreted, so an arm that is refused (a timeout,
// a missing roster, a forbidden tool) still leaves the transcript that explains the
// refusal. A refused arm is exactly the one someone will want to read.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Write an arm's raw stream, and its stderr beside it when there was any.
 *
 * No-op when `file` is undefined, so an adapter called outside the arena — the
 * pilot runner, a test — behaves exactly as before.
 */
export function writeTranscript(file: string | undefined, stream: string, stderr = ""): void {
  if (file === undefined) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stream, "utf8");
  if (stderr.trim().length > 0) writeFileSync(`${file}.stderr`, stderr, "utf8");
}
