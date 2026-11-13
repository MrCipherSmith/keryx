import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { NormalizedMessage } from "../harness/provider/types";
import { MAX_TRANSCRIPT_FILE_BYTES } from "../lib/config-dir";
import { conversationEntry, type ConversationEntry } from "./conversation-history";

const READ_BYTES = 64 * 1024;
const FRAGMENT_CHARS = 4096;
const MATCH_STRIDE = 1024;

export type HistorySnapshot = { messages: readonly NormalizedMessage[]; directory?: string };
type Fragment = { entry: number; start: number; end: number };
type IndexedEntry = { message: number; first: number; end: number };
type MatchGroup = { entry: number; first: number; checkpoints: number[] };
type Match = { entry: number; fragment: number; start: number; end: number };
export type HistorySearch = { total: number; locate(index: number, signal: AbortSignal): Promise<Match | undefined> };

async function yieldToInput(signal: AbortSignal): Promise<void> {
  await Bun.sleep(0);
  signal.throwIfAborted();
}

/** The compatibility mirror is atomically replaced. Pin its inode for the lifetime of the window. */
class ArchiveLines {
  private offsets = [0];
  private block: { position: number; bytes: Promise<Buffer> } | undefined;

  private constructor(private readonly file: FileHandle, private readonly size: number) {}

  static async open(directory: string, count: number, signal: AbortSignal): Promise<ArchiveLines | undefined> {
    let file: FileHandle | undefined;
    try {
      file = await open(path.join(directory, "archive.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TRANSCRIPT_FILE_BYTES) {
        await file.close();
        return;
      }
      const lines = new ArchiveLines(file, stat.size);
      for (let position = 0; position < stat.size && lines.offsets.length <= count; position += READ_BYTES) {
        signal.throwIfAborted();
        const bytes = await lines.read(position, Math.min(READ_BYTES, stat.size - position));
        for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, newline + 1)) {
          lines.offsets.push(position + newline + 1);
          if (lines.offsets.length > count) break;
        }
      }
      if (lines.offsets.at(-1)! < stat.size) lines.offsets.push(stat.size);
      return lines;
    } catch {
      await file?.close().catch(() => {});
      signal.throwIfAborted();
      // An unavailable mirror is normal for legacy sessions and interrupted checkpoints.
      return undefined;
    }
  }

  async close(): Promise<void> { await this.file.close(); }

  private async read(position: number, length: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < length;) {
      const { bytesRead } = await this.file.read(bytes, offset, length - offset, position + offset);
      if (bytesRead === 0) throw new Error("History archive ended before the indexed line");
      offset += bytesRead;
    }
    return bytes;
  }

  async message(index: number, expected: NormalizedMessage): Promise<NormalizedMessage> {
    const start = this.offsets[index];
    const end = this.offsets[index + 1];
    if (start === undefined || end === undefined || end <= start) return expected;
    try {
      const position = Math.floor(start / READ_BYTES) * READ_BYTES;
      let line: Buffer;
      if (end - position <= READ_BYTES) {
        if (this.block?.position !== position) {
          this.block = { position, bytes: this.read(position, Math.min(READ_BYTES, this.size - position)) };
        }
        line = (await this.block.bytes).subarray(start - position, end - position);
      } else {
        line = await this.read(start, end - start);
      }
      const saved = JSON.parse(line.toString("utf8")) as NormalizedMessage | null;
      // The selected preservation checkpoint is authoritative, even if its mirror
      // was interrupted. Fall back per row, including unsaved or growing replies.
      if (saved?.role === expected.role && saved.content === expected.content
        && saved.provenance === expected.provenance && saved.injected === expected.injected) return saved;
    } catch {
      // A damaged mirror must not hide the already validated session history.
    }
    return expected;
  }
}

export function historySnapshot(archive: readonly NormalizedMessage[], tail: readonly NormalizedMessage[] = [], directory?: string): HistorySnapshot {
  const messages = [...archive, ...tail];
  // The foreground stream can still extend the last assistant message in place.
  const last = messages.at(-1);
  if (last?.role === "assistant") messages[messages.length - 1] = { ...last };
  return { messages, ...(directory === undefined ? {} : { directory }) };
}

export class HistoryReader {
  private readonly entries: IndexedEntry[] = [];
  private readonly fragments: Fragment[] = [];

  private constructor(private readonly snapshot: HistorySnapshot, private readonly file?: ArchiveLines) {}

  static async open(snapshot: HistorySnapshot, signal: AbortSignal): Promise<HistoryReader> {
    const file = snapshot.directory === undefined ? undefined : await ArchiveLines.open(snapshot.directory, snapshot.messages.length, signal);
    const history = new HistoryReader(snapshot, file);
    try {
      for (let index = 0; index < snapshot.messages.length; index++) {
        if (index % 128 === 0) await yieldToInput(signal);
        const entry = conversationEntry(snapshot.messages[index]!);
        if (entry === undefined) continue;
        const first = history.fragments.length;
        for (let start = 0; start < entry.text.length;) {
          let end = Math.min(start + FRAGMENT_CHARS, entry.text.length);
          if (end < entry.text.length) {
            // A long line may have no newline at all. Only scan the part of
            // this fragment where a break could actually change the split.
            const searchFrom = start + FRAGMENT_CHARS / 2 + 1;
            const newline = entry.text.slice(searchFrom, end).lastIndexOf("\n");
            if (newline >= 0) end = searchFrom + newline + 1;
            const code = entry.text.charCodeAt(end);
            if (code >= 0xdc00 && code <= 0xdfff) end--;
          }
          history.fragments.push({ entry: history.entries.length, start, end });
          start = end;
        }
        history.entries.push({ message: index, first, end: history.fragments.length });
      }
      signal.throwIfAborted();
      return history;
    } catch (error) {
      await history.close();
      throw error;
    }
  }

  get length(): number { return this.fragments.length; }
  async close(): Promise<void> { await this.file?.close(); }

  private async entry(index: number): Promise<ConversationEntry> {
    const messageIndex = this.entries[index]!.message;
    const expected = this.snapshot.messages[messageIndex]!;
    const message = this.file === undefined ? expected : await this.file.message(messageIndex, expected);
    return conversationEntry(message)!;
  }

  async page(start: number, end: number, signal: AbortSignal): Promise<Array<ConversationEntry & { index: number; entry: number; start: number }>> {
    const rows: Array<ConversationEntry & { index: number; entry: number; start: number }> = [];
    let last = -1;
    let entry: ConversationEntry | undefined;
    for (let index = start; index < end; index++) {
      signal.throwIfAborted();
      const fragment = this.fragments[index]!;
      if (last !== fragment.entry) {
        entry = await this.entry(fragment.entry);
        last = fragment.entry;
      }
      rows.push({
        index, entry: fragment.entry, start: fragment.start,
        label: fragment.start === 0 ? entry!.label : "", text: entry!.text.slice(fragment.start, fragment.end),
      });
    }
    return rows;
  }

  async search(needle: string, signal: AbortSignal): Promise<HistorySearch> {
    if (needle === "") return { total: 0, locate: async () => undefined };
    const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(literal, "giu");
    const groups: MatchGroup[] = [];
    let total = 0;
    for (let index = 0; index < this.entries.length; index++) {
      if (index % 64 === 0) await yieldToInput(signal);
      const { text } = await this.entry(index);
      const first = total;
      const checkpoints: number[] = [];
      pattern.lastIndex = 0;
      for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
        if ((total - first) % MATCH_STRIDE === 0) checkpoints.push(hit.index);
        total++;
        if (total % 8192 === 0) await yieldToInput(signal);
      }
      if (total > first) groups.push({ entry: index, first, checkpoints });
    }
    return {
      total,
      locate: async (ordinal, lookupSignal) => {
        if (ordinal < 0 || ordinal >= total) return undefined;
        let lo = 0;
        let hi = groups.length;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >>> 1;
          if (groups[mid]!.first <= ordinal) lo = mid;
          else hi = mid;
        }
        const group = groups[lo]!;
        const { text } = await this.entry(group.entry);
        lookupSignal.throwIfAborted();
        const relative = ordinal - group.first;
        const matcher = new RegExp(literal, "giu");
        matcher.lastIndex = group.checkpoints[Math.floor(relative / MATCH_STRIDE)]!;
        let hit = matcher.exec(text)!;
        for (let i = relative % MATCH_STRIDE; i > 0; i--) hit = matcher.exec(text)!;
        const { first, end } = this.entries[group.entry]!;
        lo = first;
        hi = end;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >>> 1;
          if (this.fragments[mid]!.start <= hit.index) lo = mid;
          else hi = mid;
        }
        return { entry: group.entry, fragment: lo, start: hit.index, end: hit.index + hit[0].length };
      },
    };
  }
}
