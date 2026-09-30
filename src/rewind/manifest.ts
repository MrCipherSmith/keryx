import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";

export type RewindEntryKind = "turn" | "pre-rewind";

export interface RewindEntry {
  seq: number;
  kind: RewindEntryKind;
  tree: string;
  at: string;
  /** Index of the turn's user message in the session archive; null when unknown. */
  archiveIndex: number | null;
  prompt: string;
  skipped: string[];
}

export interface RewindManifest {
  version: 1;
  nextSeq: number;
  entries: RewindEntry[];
}

const MANIFEST_FILE = "manifest.json";

export function emptyManifest(): RewindManifest {
  return { version: 1, nextSeq: 1, entries: [] };
}

function isEntry(value: unknown): value is RewindEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.seq === "number" &&
    (entry.kind === "turn" || entry.kind === "pre-rewind") &&
    typeof entry.tree === "string" &&
    typeof entry.at === "string" &&
    (entry.archiveIndex === null || typeof entry.archiveIndex === "number") &&
    typeof entry.prompt === "string" &&
    Array.isArray(entry.skipped)
  );
}

export function loadManifest(rewindDir: string): RewindManifest {
  const file = path.join(rewindDir, MANIFEST_FILE);
  if (!existsSync(file)) return emptyManifest();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; nextSeq?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return emptyManifest();
    const entries = parsed.entries.filter(isEntry);
    const highest = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    const nextSeq = typeof parsed.nextSeq === "number" && parsed.nextSeq > highest ? parsed.nextSeq : highest + 1;
    return { version: 1, nextSeq, entries };
  } catch {
    return emptyManifest();
  }
}

export async function saveManifest(rewindDir: string, manifest: RewindManifest): Promise<void> {
  mkdirSync(rewindDir, { recursive: true });
  await writeFileAtomic(path.join(rewindDir, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
}
