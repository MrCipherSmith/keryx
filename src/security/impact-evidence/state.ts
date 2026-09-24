// Flow 308 (W8, Lane B, T6): per-session touch/denial state and the
// append-only event log for the impact-evidence gate.

import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { pathExists, writeFileAtomic } from "../../lib/fs";
import { readJsonObjectFile } from "../../lib/json";
import type { ImpactEvidenceLogEvent, ImpactEvidenceLogRecord } from "./types";

export interface ImpactEvidenceSessionState {
  touched: string[];
  denials: Record<string, number>;
}

const EMPTY_STATE: ImpactEvidenceSessionState = { touched: [], denials: {} };

/** `.metaproject/data/security/impact-evidence` under `root`. */
export function impactEvidenceDataRoot(root: string): string {
  return path.join(root, ".metaproject", "data", "security", "impact-evidence");
}

/**
 * Sanitize a session id to `[A-Za-z0-9._-]` before it ever becomes a
 * filename — a session id is caller-supplied (a harness's own id), and this
 * is the one place it touches the filesystem.
 */
export function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

function sessionStatePath(root: string, sessionId: string): string {
  return path.join(impactEvidenceDataRoot(root), "sessions", `${sanitizeSessionId(sessionId)}.json`);
}

export async function loadSessionState(root: string, sessionId: string): Promise<ImpactEvidenceSessionState> {
  const file = sessionStatePath(root, sessionId);
  if (!(await pathExists(file))) {
    return { touched: [], denials: {} };
  }
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") {
    return { touched: [], denials: {} };
  }
  const value = read.value as Partial<ImpactEvidenceSessionState>;
  const touched = Array.isArray(value.touched) ? value.touched.filter((v): v is string => typeof v === "string") : [];
  const denials =
    value.denials && typeof value.denials === "object" && !Array.isArray(value.denials)
      ? Object.fromEntries(
          Object.entries(value.denials as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {};
  return { touched, denials };
}

export async function saveSessionState(
  root: string,
  sessionId: string,
  state: ImpactEvidenceSessionState,
): Promise<void> {
  const file = sessionStatePath(root, sessionId);
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function logPath(root: string): string {
  return path.join(impactEvidenceDataRoot(root), "log.jsonl");
}

export async function appendLogRecord(
  root: string,
  record: Omit<ImpactEvidenceLogRecord, "at"> & { at?: string },
): Promise<ImpactEvidenceLogRecord> {
  const full: ImpactEvidenceLogRecord = {
    at: record.at ?? new Date().toISOString(),
    sessionId: record.sessionId,
    event: record.event,
    files: record.files,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
  };
  const file = logPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

export async function readLogRecords(root: string): Promise<ImpactEvidenceLogRecord[]> {
  const file = logPath(root);
  if (!(await pathExists(file))) {
    return [];
  }
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(file, "utf8");
  const records: ImpactEvidenceLogRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as ImpactEvidenceLogRecord);
    } catch {
      // Corrupt line: skip rather than fail the whole read.
    }
  }
  return records;
}

export function isEventKnown(event: string): event is ImpactEvidenceLogEvent {
  return [
    "injected",
    "skipped-repeat",
    "skipped-exempt",
    "dampened",
    "disabled-env",
    "disabled-config",
    "rollback-required",
    "rollback-accepted",
    "service-failed",
  ].includes(event);
}

export { EMPTY_STATE };
