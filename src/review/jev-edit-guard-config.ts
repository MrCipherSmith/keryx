// Jev EDIT GUARD — flow 343: the opt-in gate and its two knobs, all read
// from `.metaproject/tasks.config.json`'s `review.jev` block, the exact same
// block `review.jev.rules` (`./jev-rules-config.ts`) already lives in:
//
//   { "review": { "jev": {
//     "edit_guard": true,
//     "edit_guard_threshold": 0.5,
//     "edit_guard_max_calls": 24
//   } } }
//
// Reads are fail-closed and never throw (absent/unparsable -> the documented
// default, exactly like `readJevRulesEnabled`'s own reading of its sibling
// key) — a hook that could not parse its own config must still fail OPEN
// (silent, exit 0), never crash the coding agent's tool call.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";
// `lib` is SHARED (`import-zones.ts`) — safe for this CORE module; the
// CLIENT-zone `resolveJevApiKey` is not, so `jevAvailable` below must be
// computed by the caller — see `resolveJevProfileFlag`'s doc in
// `./jev-profile.ts`.
import { resolveExternalSetting } from "../lib/external-switch";
import { resolveJevProfileFlag, type JevProfileFlagResult } from "./jev-profile";
import { DEFAULT_EDIT_GUARD_MAX_CALLS, DEFAULT_EDIT_GUARD_THRESHOLD } from "./jev-edit-guard";

async function readReviewJevBlock(cwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return undefined;
    const jev = (review as Record<string, unknown>)["jev"];
    return typeof jev === "object" && jev !== null ? (jev as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** See `CiTriageEnabledOptions` (`./ci-triage.ts`) — the same shape, for the same reason. */
export interface JevEditGuardEnabledOptions {
  readonly jevAvailable?: boolean;
  readonly configDir?: string;
}

/**
 * Flow 343's opt-in gate, now resolved through the shared default-on
 * resolver (flow 346, design §4): an explicit `true`/`false` always wins;
 * unset, `edit_guard` (one of the three `JEV_DEFAULT_ON_KEYS`) now defaults
 * to `true` when `/external` is on and a Jev credential resolves, `false`
 * otherwise — same fail-closed floor as before for a malformed/absent file.
 */
export async function readJevEditGuardEnabled(cwd: string, opts?: JevEditGuardEnabledOptions): Promise<boolean> {
  return (await readJevEditGuardEnabledDetailed(cwd, opts)).value;
}

/** Same as {@link readJevEditGuardEnabled}, but returns the full `JevProfileFlagResult` (value + source) — see `readCiTriageEnabledDetailed`'s doc (`./ci-triage.ts`) for why. */
export async function readJevEditGuardEnabledDetailed(cwd: string, opts?: JevEditGuardEnabledOptions): Promise<JevProfileFlagResult> {
  const jev = await readReviewJevBlock(cwd);
  const raw = jev?.["edit_guard"];
  const explicit = typeof raw === "boolean" ? raw : undefined;
  const external = await resolveExternalSetting({ cwd, ...(opts?.configDir !== undefined ? { dir: opts.configDir } : {}) });
  return resolveJevProfileFlag("edit_guard", explicit, { externalOn: external.value === "on", jevAvailable: opts?.jevAvailable === true });
}

/** Clamped to `0..1`; an out-of-range or non-numeric value reads as the default rather than as a broken threshold. */
export async function readJevEditGuardThreshold(cwd: string): Promise<number> {
  const jev = await readReviewJevBlock(cwd);
  const raw = jev?.["edit_guard_threshold"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return DEFAULT_EDIT_GUARD_THRESHOLD;
  return raw;
}

/** The per-run `(hunk, rule-clause)` pair budget — doubles as the cost cap (spec item 2). Non-positive/non-integer/absent reads as the default. */
export async function readJevEditGuardMaxCalls(cwd: string): Promise<number> {
  const jev = await readReviewJevBlock(cwd);
  const raw = jev?.["edit_guard_max_calls"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_EDIT_GUARD_MAX_CALLS;
  return Math.trunc(raw);
}

export interface EditGuardConfigSnapshot {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly maxCalls: number;
}

export async function readJevEditGuardConfig(cwd: string, opts?: JevEditGuardEnabledOptions): Promise<EditGuardConfigSnapshot> {
  const [enabled, threshold, maxCalls] = await Promise.all([
    readJevEditGuardEnabled(cwd, opts),
    readJevEditGuardThreshold(cwd),
    readJevEditGuardMaxCalls(cwd),
  ]);
  return { enabled, threshold, maxCalls };
}

/**
 * Flip `review.jev.edit_guard` on/off, preserving every other key of
 * `tasks.config.json` — the TUI's `/editguard` toggle and the CLI's
 * `install`/`uninstall` subcommands both go through this rather than
 * hand-rolling a read-modify-write. A missing or unparsable file is treated
 * as `{}` (a fresh file is written, not a merge failure) — the reads above
 * already treat that same state as "disabled", so writing `{}` as the
 * starting point never contradicts what a caller just read.
 */
export async function writeJevEditGuardEnabled(cwd: string, enabled: boolean): Promise<void> {
  const file = path.join(cwd, REVIEW_GATE_CONFIG_PATH);
  let root: Record<string, unknown> = {};
  if (await pathExists(file)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // An unparsable existing file is not safe to merge into — starting
      // fresh here would silently discard whatever else it held. Refuse
      // rather than guess.
      throw new Error(`${REVIEW_GATE_CONFIG_PATH} exists but is not valid JSON — refusing to overwrite it.`);
    }
  }
  const review = typeof root["review"] === "object" && root["review"] !== null ? { ...(root["review"] as Record<string, unknown>) } : {};
  const jev = typeof review["jev"] === "object" && review["jev"] !== null ? { ...(review["jev"] as Record<string, unknown>) } : {};
  jev["edit_guard"] = enabled;
  review["jev"] = jev;
  root["review"] = review;
  await writeFileAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
}
