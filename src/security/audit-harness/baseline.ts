// Flow 308 (W8 Design part A, Lane A) — baseline.ts: the checksum-guarded
// suppression file `.metaproject/security-audit-baseline.json`, on the same
// tamper-detection mechanism `src/security/config.ts` already uses for
// `security.config.json` (`computeObjectChecksum`, reused as-is).

import path from "node:path";
import { pathExists, writeFileAtomic } from "../../lib/fs";
import { readJsonObjectFile } from "../../lib/json";
import { computeObjectChecksum } from "../config";
import { validateAgainstSchema, type JsonSchema } from "../schemas";
import type { AuditFinding, BaselineEntry, BaselineState, BaselineTamperState } from "./types";

export const BASELINE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "entries"],
  properties: {
    schemaVersion: { type: "number" },
    checksum: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "justification"],
        properties: {
          findingId: { type: "string", minLength: 1 },
          justification: { type: "string", minLength: 1 },
          author: { type: "string" },
          expiresAt: { type: ["string", "null"] },
        },
      },
    },
  },
};

export function defaultBaselinePath(root: string): string {
  return path.join(root, ".metaproject", "security-audit-baseline.json");
}

export type LoadedBaseline = {
  state: BaselineState;
  /** Entries usable for suppression: only present when `tamperState === "ok"`. */
  applicableEntries: BaselineEntry[];
};

/**
 * Read and verify the baseline file. Returns `undefined` when no baseline is
 * configured at all (the file is absent) — the report's `baseline` field is
 * `null` in that case, a genuinely different state from "configured but
 * tampered/unreadable".
 */
export async function readBaseline(baselinePath: string): Promise<LoadedBaseline | undefined> {
  if (!(await pathExists(baselinePath))) {
    return undefined;
  }
  const read = await readJsonObjectFile(baselinePath);
  if (read.state !== "object") {
    return {
      state: { path: baselinePath, tamperState: "unreadable", entries: [] },
      applicableEntries: [],
    };
  }
  const schemaErrors = validateAgainstSchema(read.value, BASELINE_SCHEMA);
  if (schemaErrors.length > 0) {
    return {
      state: { path: baselinePath, tamperState: "unreadable", entries: [] },
      applicableEntries: [],
    };
  }
  const entries = (read.value.entries as BaselineEntry[]) ?? [];
  const expected = computeObjectChecksum(entries);
  const actual = typeof read.value.checksum === "string" ? read.value.checksum : undefined;
  const tamperState: BaselineTamperState = actual === undefined || actual !== expected ? "mismatch" : "ok";
  return {
    state: { path: baselinePath, tamperState, entries },
    applicableEntries: tamperState === "ok" ? entries : [],
  };
}

/** Whether a baseline entry currently suppresses its finding (not expired). */
export function entryIsActive(entry: BaselineEntry, now: Date): boolean {
  if (!entry.expiresAt) {
    return true;
  }
  const expires = new Date(entry.expiresAt);
  if (Number.isNaN(expires.getTime())) {
    return true;
  }
  return expires.getTime() >= now.getTime();
}

/**
 * Apply baseline suppression to a finding list in place (returns a new
 * array). Only entries from a baseline whose `tamperState` is `ok` suppress
 * anything — a tampered or unreadable baseline suppresses nothing, fail-safe.
 */
export function applySuppression(
  findings: readonly AuditFinding[],
  applicableEntries: readonly BaselineEntry[],
  now: Date,
): AuditFinding[] {
  const byFindingId = new Map(applicableEntries.map((entry) => [entry.findingId, entry] as const));
  return findings.map((finding) => {
    const entry = byFindingId.get(finding.id);
    if (!entry || !entryIsActive(entry, now)) {
      return finding;
    }
    return { ...finding, suppressed: { value: true, baselineEntryId: entry.findingId } };
  });
}

/** `indefinite-suppression` (low): one finding per baseline entry with no `expiresAt`. */
export function indefiniteSuppressionFindings(applicableEntries: readonly BaselineEntry[]): AuditFinding[] {
  return applicableEntries
    .filter((entry) => !entry.expiresAt)
    .map((entry) => ({
      id: `indefinite-${entry.findingId}`,
      surface: "settings" as const,
      check: "indefinite-suppression" as const,
      severity: "low" as const,
      confidence: 1,
      message: `Baseline suppression for finding ${entry.findingId} has no expiresAt — indefinite suppression.`,
      evidence: { category: "artifact-safety", matchedToken: `finding:${entry.findingId}` },
      suppressed: { value: false, baselineEntryId: null },
    }));
}

/** Write (or reseal) the baseline file with an added entry. Only writing path for this file. */
export async function addBaselineEntry(
  root: string,
  entry: BaselineEntry,
  options: { baselinePath?: string } = {},
): Promise<void> {
  const filePath = options.baselinePath ?? defaultBaselinePath(root);
  let entries: BaselineEntry[] = [];
  if (await pathExists(filePath)) {
    const read = await readJsonObjectFile(filePath);
    if (read.state === "object" && Array.isArray(read.value.entries)) {
      entries = read.value.entries as BaselineEntry[];
    }
  }
  const next = [...entries.filter((existing) => existing.findingId !== entry.findingId), entry];
  const checksum = computeObjectChecksum(next);
  const payload = { schemaVersion: 1, entries: next, checksum };
  await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}
