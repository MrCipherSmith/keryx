// The journal of refused senders (flow 376, AC8).
//
// A message or button press from a Telegram user outside the allowlist is
// dropped before it reaches anything. This file is the only trace, and it holds
// exactly two fields per line: the user id and the time. Never the text, never
// the chat or thread, never the callback data: an attacker's words must not be
// able to reach a log, and an operator needs only "who knocked, and when".
//
// Bounded: past 1 MB the file rotates to `<name>.1`, replacing the previous
// rotation, so a flood cannot fill the disk.

import { renameSync, statSync } from "node:fs";
import path from "node:path";
import { appendOwnerOnlyLine } from "../lib/config-dir";
import { ensureRemoteDir, REJECTED_JOURNAL_FILE } from "./paths";

const MAX_JOURNAL_BYTES = 1_000_000;

export interface RejectedEntry {
  ts: string;
  /** The sender's Telegram user id, or null when the update carried none. */
  userId: number | null;
}

export class RejectedJournal {
  private readonly file: string;
  private readonly now: () => number;

  constructor(options: { dir?: string; now: () => number }) {
    this.file = path.join(ensureRemoteDir(options.dir), REJECTED_JOURNAL_FILE);
    this.now = options.now;
  }

  get path(): string {
    return this.file;
  }

  record(userId: number | undefined): void {
    this.rotateIfLarge();
    const entry: RejectedEntry = { ts: new Date(this.now()).toISOString(), userId: userId ?? null };
    appendOwnerOnlyLine(this.file, JSON.stringify(entry));
  }

  private rotateIfLarge(): void {
    try {
      if (statSync(this.file).size > MAX_JOURNAL_BYTES) {
        renameSync(this.file, `${this.file}.1`);
      }
    } catch {
      // Absent file: nothing to rotate.
    }
  }
}
