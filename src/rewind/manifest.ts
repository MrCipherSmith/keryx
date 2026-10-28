import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  /** Optional protected native capture provenance. Never projected to remote clients. */
  native?: NativeRewindProvenance;
}
export interface NativeRewindCapture {
  sessionId: string; nativeSessionId: string; checkoutId: string; nonce: string;
  gitHead: string; workspaceBaseline: string; historyVersion: number;
}
export interface NativeRewindProvenance {
  sessionId: string; nativeSessionId: string; checkoutId: string; nonceDigest: string;
  gitHead: string; workspaceBaseline: string; historyVersion: number; snapshotDigest: string; signature: string;
}
function entryDigest(entry: RewindEntry): string {
  return createHash("sha256").update(JSON.stringify([entry.seq, entry.kind, entry.tree, entry.at, entry.archiveIndex, entry.prompt, entry.skipped])).digest("hex");
}
export function signNativeRewindEntry(entry: RewindEntry, capture: NativeRewindCapture): NativeRewindProvenance {
  const body = { sessionId: capture.sessionId, nativeSessionId: capture.nativeSessionId, checkoutId: capture.checkoutId,
    nonceDigest: createHash("sha256").update(capture.nonce).digest("hex"), gitHead: capture.gitHead,
    workspaceBaseline: capture.workspaceBaseline, historyVersion: capture.historyVersion, snapshotDigest: entryDigest(entry) };
  if (!validNative({ ...body, signature: "0".repeat(64) }) || capture.nonce.length < 16) throw new Error("invalid-native-capture");
  return { ...body, signature: createHmac("sha256", capture.nonce).update(JSON.stringify(body)).digest("hex") };
}
export function verifyNativeRewindEntry(entry: RewindEntry, current: NativeRewindCapture): boolean {
  const proof = entry.native;
  if (!proof || !validNative(proof) || !/^[a-f0-9]{40}$/.test(entry.tree) || !Number.isSafeInteger(entry.seq) || entry.seq < 1
    || proof.sessionId !== current.sessionId || proof.nativeSessionId !== current.nativeSessionId || proof.checkoutId !== current.checkoutId
    || proof.gitHead !== current.gitHead || proof.snapshotDigest !== entryDigest(entry)) return false;
  const signed = signNativeRewindEntry(entry, { ...current, workspaceBaseline: proof.workspaceBaseline, historyVersion: proof.historyVersion });
  return proof.nonceDigest === signed.nonceDigest && timingSafeEqual(Buffer.from(proof.signature, "hex"), Buffer.from(signed.signature, "hex"));
}
function validNative(value: unknown): value is NativeRewindProvenance {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 9 && ["sessionId", "nativeSessionId", "checkoutId"].every(key => typeof row[key] === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(row[key] as string))
    && ["nonceDigest", "workspaceBaseline", "snapshotDigest", "signature"].every(key => typeof row[key] === "string" && /^[a-f0-9]{64}$/.test(row[key] as string))
    && typeof row.gitHead === "string" && /^[a-f0-9]{40,64}$/.test(row.gitHead) && Number.isSafeInteger(row.historyVersion) && Number(row.historyVersion) > 0;
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
    Array.isArray(entry.skipped) && entry.skipped.every(item => typeof item === "string") &&
    (entry.native === undefined || validNative(entry.native))
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
