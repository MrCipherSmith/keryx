import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPathInside, pathExists, writeFileAtomic } from "../lib/fs";
import { guardOutput, redactRaw } from "../security/guard";
import { renderRunMarkdown, stableJson, validateRunRecord } from "./record";
import type { ExecutionRunRecord, RunProvenance } from "./types";

export type LatestPointer = {
  run_id: string;
  commit: string | null;
  branch: string | null;
  worktree: string | null;
  generated_at: string;
  record: string;
};

export type ArtifactPointerStatus = {
  status: "fresh" | "stale" | "mismatch" | "missing";
  pointer: LatestPointer | null;
  reason?: string;
};

export async function readArtifactPointer(
  root: string,
  expected?: Pick<RunProvenance, "commit" | "branch" | "worktree">,
): Promise<ArtifactPointerStatus> {
  const pointerFile = path.join(root, "latest.json");
  if (!(await pathExists(pointerFile))) return { status: "missing", pointer: null };
  let pointer: LatestPointer;
  try {
    pointer = JSON.parse(await readFile(pointerFile, "utf8")) as LatestPointer;
  } catch {
    return { status: "stale", pointer: null, reason: "latest pointer is invalid JSON" };
  }
  const recordFile = pointer.record ? path.join(root, pointer.record) : null;
  if (!recordFile || !isPathInside(root, recordFile) || !(await pathExists(recordFile))) {
    return { status: "stale", pointer, reason: "pointer record is missing" };
  }
  if (expected && ["commit", "branch", "worktree"].some((field) =>
    expected[field as keyof typeof expected] !== pointer[field as keyof LatestPointer])) {
    return { status: "mismatch", pointer, reason: "latest provenance does not match requested provenance" };
  }
  return { status: "fresh", pointer };
}

export async function writeRunArtifacts(
  root: string,
  record: ExecutionRunRecord,
  options: { cwd?: string } = {},
): Promise<{ jsonPath: string; markdownPath: string; pointer: LatestPointer }> {
  let safeRecord = record;
  if (options.cwd) {
    const serialized = stableJson(record);
    const guard = await guardOutput({ cwd: options.cwd, content: serialized, target: "report", source: "generated" });
    if (!guard.allowed) throw new Error(guard.reason ?? "security gate blocked metrics artifact");
    const redacted = await redactRaw({ cwd: options.cwd, content: serialized, source: "generated" });
    try {
      safeRecord = JSON.parse(redacted.content) as ExecutionRunRecord;
    } catch {
      throw new Error("security redaction produced an invalid metrics record");
    }
  }
  const validation = validateRunRecord(safeRecord);
  if (!validation.valid) throw new Error(`invalid run record: ${validation.errors.join(", ")}`);
  const runs = path.join(root, "runs");
  const jsonFile = path.join(runs, `${safeRecord.run_id}.json`);
  const markdownFile = path.join(runs, `${safeRecord.run_id}.md`);
  if (await pathExists(jsonFile)) throw new Error(`immutable run record already exists: ${safeRecord.run_id}`);
  await writeFileAtomic(jsonFile, stableJson(safeRecord));
  await writeFileAtomic(markdownFile, renderRunMarkdown(safeRecord));
  const pointer: LatestPointer = {
    run_id: safeRecord.run_id,
    commit: safeRecord.provenance.commit,
    branch: safeRecord.provenance.branch,
    worktree: safeRecord.provenance.worktree,
    generated_at: new Date().toISOString(),
    record: path.posix.join("runs", `${safeRecord.run_id}.json`),
  };
  await writeFileAtomic(path.join(root, "latest.json"), stableJson(pointer));
  return { jsonPath: jsonFile, markdownPath: markdownFile, pointer };
}

export async function readLatestPointer(
  root: string,
  expected?: Pick<RunProvenance, "commit" | "branch" | "worktree">,
): Promise<{
  status: "fresh" | "stale" | "mismatch" | "missing";
  pointer: LatestPointer | null;
  record: ExecutionRunRecord | null;
  reason?: string;
}> {
  const pointerFile = path.join(root, "latest.json");
  if (!(await pathExists(pointerFile))) return { status: "missing", pointer: null, record: null };
  let pointer: LatestPointer;
  try {
    pointer = JSON.parse(await readFile(pointerFile, "utf8")) as LatestPointer;
  } catch {
    return { status: "stale", pointer: null, record: null, reason: "latest pointer is invalid JSON" };
  }
  const recordFile = pointer.record ? path.join(root, pointer.record) : null;
  if (!recordFile || !isPathInside(root, recordFile) || !(await pathExists(recordFile))) return { status: "stale", pointer, record: null, reason: "pointer record is missing or escapes artifact root" };
  let record: ExecutionRunRecord;
  try {
    record = JSON.parse(await readFile(recordFile, "utf8")) as ExecutionRunRecord;
  } catch {
    return { status: "stale", pointer, record: null, reason: "pointer record is invalid JSON" };
  }
  if (expected && ["commit", "branch", "worktree"].some((field) =>
    expected[field as keyof typeof expected] !== pointer[field as keyof LatestPointer])) {
    return { status: "mismatch", pointer, record, reason: "latest provenance does not match requested provenance" };
  }
  if (pointer.run_id !== record.run_id) return { status: "stale", pointer, record, reason: "pointer run_id does not match record" };
  if (["commit", "branch", "worktree"].some((field) =>
    pointer[field as keyof LatestPointer] !== record.provenance[field as keyof typeof record.provenance])) {
    return { status: "mismatch", pointer, record, reason: "latest pointer provenance does not match its record" };
  }
  return { status: "fresh", pointer, record };
}
