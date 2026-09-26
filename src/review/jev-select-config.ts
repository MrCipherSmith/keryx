// review-jev-select — flow 344's opt-in gate: `review.jev.select` in
// `.metaproject/tasks.config.json`, the same shape and same fail-closed
// reading (absent/unparsable -> false, never throws, never defaults on) as
// `src/review/jev-risk-config.ts`'s `readJevRiskEnabled` and
// `src/review/ci-triage.ts`'s `readCiTriageEnabled` read their own sibling
// keys of the same config block.
//
// `select` differs from every other `review.jev.*` gate in one way: an
// UNMEASURED reviewer-selection lever must never reduce reviewer coverage on
// its own account. The opt-in and the skip threshold below are read the same
// fail-closed way (a malformed file degrades to "select is off"/"the default
// threshold"), but the CALLER (`src/commands/review-jev-select.ts`) is the
// one that turns "select is off" into "keep everyone", not this reader.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";
// `lib` is SHARED (`import-zones.ts`) — safe for this CORE module; the
// CLIENT-zone `resolveJevApiKey` is not, so `jevAvailable` below must be
// computed by the caller — see `resolveJevProfileFlag`'s doc in
// `./jev-profile.ts`.
import { resolveExternalSetting } from "../lib/external-switch";
import { resolveJevProfileFlag, type JevProfileFlagResult } from "./jev-profile";

/**
 * Recall-first default: only a candidate scored BELOW this probability is
 * skipped. Low on purpose — `review-jev-risk`'s own measured "top-3 recall
 * 21% vs 30% for largest-diff-first" is the cautionary case this threshold
 * exists to avoid repeating for reviewer selection, which has not been
 * measured at all yet.
 */
export const DEFAULT_SELECT_SKIP_BELOW = 0.15;

async function readReviewJevBlock(cwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return undefined;
    const jev = (review as Record<string, unknown>)["jev"];
    if (typeof jev !== "object" || jev === null) return undefined;
    return jev as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** See `CiTriageEnabledOptions` (`./ci-triage.ts`) — the same shape, for the same reason. */
export interface JevSelectEnabledOptions {
  readonly jevAvailable?: boolean;
  readonly configDir?: string;
}

/**
 * Flow 344's opt-in gate, now resolved through the shared default-on
 * resolver (flow 346, design §4): an explicit `true`/`false` always wins;
 * unset, `select` (one of the three `JEV_DEFAULT_ON_KEYS`) now defaults to
 * `true` when `/external` is on and a Jev credential resolves, `false`
 * otherwise — same fail-closed floor as before for a malformed/absent file.
 */
export async function readJevSelectEnabled(cwd: string, opts?: JevSelectEnabledOptions): Promise<boolean> {
  return (await readJevSelectEnabledDetailed(cwd, opts)).value;
}

/** Same as {@link readJevSelectEnabled}, but returns the full `JevProfileFlagResult` (value + source) — see `readCiTriageEnabledDetailed`'s doc for why. */
export async function readJevSelectEnabledDetailed(cwd: string, opts?: JevSelectEnabledOptions): Promise<JevProfileFlagResult> {
  const jev = await readReviewJevBlock(cwd);
  const raw = jev?.["select"];
  const explicit = typeof raw === "boolean" ? raw : undefined;
  const external = await resolveExternalSetting({ cwd, ...(opts?.configDir !== undefined ? { dir: opts.configDir } : {}) });
  return resolveJevProfileFlag("select", explicit, { externalOn: external.value === "on", jevAvailable: opts?.jevAvailable === true });
}

/**
 * `review.jev.select_skip_below`, clamped to `0..1`. Absent, unparsable, or
 * out of range all fall back to {@link DEFAULT_SELECT_SKIP_BELOW} — a
 * misconfigured threshold must never silently become "skip nothing below
 * infinity" or "skip everything", either of which would be worse than the
 * documented default.
 */
export async function readJevSelectSkipBelow(cwd: string): Promise<number> {
  const jev = await readReviewJevBlock(cwd);
  const raw = jev?.["select_skip_below"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return DEFAULT_SELECT_SKIP_BELOW;
  }
  return raw;
}
