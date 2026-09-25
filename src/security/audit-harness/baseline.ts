// Flow 308 (W8 Design part A, Lane A) — baseline.ts: the checksum-guarded
// suppression file `.metaproject/security-audit-baseline.json`, on the same
// tamper-detection mechanism `src/security/config.ts` already uses for
// `security.config.json` (`computeObjectChecksum`, reused as-is).

import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../../lib/fs";
import { writeContained } from "../../lib/contained-write";
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

const STRICT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strict `YYYY-MM-DD` validation over a REAL calendar date (F9). The `Date`
 * constructor normalizes an out-of-range date instead of refusing it (e.g.
 * `new Date("2024-02-30")` rolls over to March 1st rather than failing), so
 * a regex shape check alone is not enough — this re-derives the same
 * year/month/day from the parsed UTC date and requires them to match the
 * input exactly.
 */
export function isValidCalendarDateString(value: string): boolean {
  const match = STRICT_DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Whether a baseline entry currently suppresses its finding (not expired).
 *
 * F9: an unparseable `expiresAt` (e.g. `"never"`) used to fall into an
 * explicit `Number.isNaN(...) -> return true` branch, meaning a GARBAGE
 * expiry value suppressed its finding PERMANENTLY — the opposite of the
 * fail-safe behavior every other unreadable/invalid state in this file has.
 * A value that is not a real, strictly-`YYYY-MM-DD` calendar date is now
 * treated as never active: it does not suppress anything. It is still
 * visible in `state.entries` (and so in the report's `baseline.entries`), so
 * the malformed value is reported, not silently dropped.
 *
 * N9: `expiresAt` is a DATE, not a timestamp — "expires 2026-09-24" reads,
 * to whoever wrote the baseline entry, as "suppresses through the end of
 * that day", not "suppresses only up to the exact instant midnight UTC
 * ticks over". Comparing against that date's `T00:00:00.000Z` (as this used
 * to) made an entry expire at the FIRST moment of its own expiry day, so a
 * suppression written as "expires today" was already inactive for the rest
 * of today. The cutoff is now that date's last instant, `T23:59:59.999Z`
 * UTC — inclusive THROUGH the end of the expiry day.
 */
export function entryIsActive(entry: BaselineEntry, now: Date): boolean {
  if (!entry.expiresAt) {
    return true;
  }
  if (!isValidCalendarDateString(entry.expiresAt)) {
    return false;
  }
  const expiresEndOfDay = new Date(`${entry.expiresAt}T23:59:59.999Z`);
  return expiresEndOfDay.getTime() >= now.getTime();
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

export type AddBaselineEntryResult = {
  resealed: boolean;
  /** N7: findingIds from the previous file that survived into the rewritten one. */
  carriedOver: string[];
  /** N7: findingIds seen in the previous file's raw JSON that did NOT survive (lost to the reseal). */
  discarded: string[];
  /** N7: set only on a reseal — where the pre-reseal file was copied before being overwritten. */
  backupPath?: string;
};

/**
 * Best-effort, schema-independent recovery of the findingIds a baseline file
 * NAMES, straight from its raw JSON — used only to report `discarded` (N7):
 * a file that fails whole-document schema validation (`readBaseline`'s
 * "unreadable" state) comes back with `entries: []`, telling the caller
 * NOTHING was recoverable, but the raw JSON may still name ids worth
 * reporting as lost. Never used for suppression — only for this message.
 */
async function readRawBaselineFindingIds(filePath: string): Promise<string[]> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return [];
    }
    const ids = (parsed as { entries: unknown[] }).entries
      .map((e) => (e && typeof e === "object" ? (e as { findingId?: unknown }).findingId : undefined))
      .filter((id): id is string => typeof id === "string");
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Write (or reseal) the baseline file with an added entry. Only writing path
 * for this file.
 *
 * F8: `baseline add` used to read the file's raw `entries` and rewrite it
 * with a freshly-computed checksum unconditionally — including when the
 * CURRENT file's checksum did not match its own contents (`tamperState`
 * `mismatch`/`unreadable`). That reseals a tampered baseline with a valid
 * checksum, laundering the tamper: the next audit run reports `ok` as if
 * nothing had happened, and every entry the tamperer added along with the
 * legitimate one is now silently trusted too. Adding to a non-`ok` baseline
 * is refused unless the caller explicitly passes `reseal: true`, in which
 * case the reseal is real (a fresh, valid checksum is written) but is not
 * silent — the caller is told it happened (`result.resealed`) so it can be
 * logged/printed.
 *
 * N7: a reseal is also not silent about WHAT it kept vs lost. Before
 * overwriting a tampered/unreadable file, it is copied to
 * `<file>.bak-<timestamp>` (so the pre-reseal bytes are never gone), and the
 * result reports which findingIds survived into the new file
 * (`carriedOver`) vs were named in the old file's raw JSON but did not
 * (`discarded`) — for an "unreadable" file (failed schema validation, or not
 * even parseable JSON), that is typically every id it named.
 */
export async function addBaselineEntry(
  root: string,
  entry: BaselineEntry,
  options: { baselinePath?: string; reseal?: boolean; now?: () => Date } = {},
): Promise<AddBaselineEntryResult> {
  const filePath = options.baselinePath ?? defaultBaselinePath(root);
  let entries: BaselineEntry[] = [];
  let resealed = false;
  let discarded: string[] = [];
  let backupPath: string | undefined;
  if (await pathExists(filePath)) {
    const loaded = await readBaseline(filePath);
    if (loaded && loaded.state.tamperState !== "ok") {
      if (options.reseal !== true) {
        throw new Error(
          `Refusing to add to baseline ${filePath}: it is currently "${loaded.state.tamperState}" ` +
            `(tampered or unreadable). Pass --reseal to explicitly reseal it and add anyway.`,
        );
      }
      // Back up the pre-reseal file BEFORE it is overwritten — the one and
      // only chance to keep its bytes once the rewrite below lands.
      const now = options.now ? options.now() : new Date();
      backupPath = `${filePath}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
      // R700-04: `copyFile` is a raw-write shape too — read the pre-reseal
      // bytes and write them back out through `writeContained` rather than
      // copying the file directly, so the backup gets the same containment
      // check as everything else this function writes.
      const preResealBytes = await readFile(filePath);
      await writeContained(root, path.relative(root, backupPath), preResealBytes);
      // `state.entries` is the raw, schema-valid entry list even when the
      // checksum mismatches (only an "unreadable" file — failed schema
      // validation entirely — has none to recover).
      entries = loaded.state.entries;
      const rawIds = await readRawBaselineFindingIds(filePath);
      const keptIds = new Set(entries.map((e) => e.findingId));
      discarded = rawIds.filter((id) => !keptIds.has(id));
      resealed = true;
    } else if (loaded) {
      entries = loaded.applicableEntries;
    }
  }
  const carriedOver = entries.filter((existing) => existing.findingId !== entry.findingId).map((e) => e.findingId);
  const next = [...entries.filter((existing) => existing.findingId !== entry.findingId), entry];
  const checksum = computeObjectChecksum(next);
  const payload = { schemaVersion: 1, entries: next, checksum };
  await writeContained(root, path.relative(root, filePath), `${JSON.stringify(payload, null, 2)}\n`);
  return { resealed, carriedOver, discarded, ...(backupPath ? { backupPath } : {}) };
}
