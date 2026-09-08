// Where the retention policy actually RUNS (flow 237 T12, F5).
//
// The measured problem: `src/retention/policy.ts` and `src/retention/sweep.ts`
// are correct, and `sweepProject` had exactly one caller — `keryx retention
// sweep --apply`, typed by a human. Nothing else invoked it: not the ctx write
// path, not a health run, not init. Measured on the keryx checkout the day this
// was written:
//
//     gdctx-raw       — entries: 8126 scanned, 2570 eligible, 0 removed
//                       bytes: 297459192 before, 143970902 eligible, 0 reclaimed
//     gdctx-artifacts — entries: 7473 scanned, 2570 eligible, 0 removed
//
// 2,570 entries and ~137 MiB past the policy, in a store nothing bounds unless
// someone remembers a command they have no reason to know exists. A policy that
// is only ever applied by hand is a policy in the same sense that an unreachable
// verb is a feature.
//
// WHERE the invocation belongs, and why here:
//
//   · The gdctx store grows by exactly one thing: `keryx ctx` writing an
//     artifact pair. The writer that grows a store is the only place that is
//     guaranteed to run as often as the store grows — a health run, an init, or
//     a hook may never run at all on a checkout that ctx-searches all day. This
//     is the same shape as `src/wiki/freshness/queue.ts`, which rotates itself
//     on append rather than waiting for a maintenance verb.
//   · A sweep IS expensive on a hot path — it lists and stats every entry in
//     both directories (~15,600 stats on this checkout), which is far more work
//     than the ctx run that triggered it. So it is THROTTLED, not run per write:
//     a stamp file records when the last automatic sweep ran, and one is
//     attempted at most once per `AUTO_SWEEP_INTERVAL_MS`. The per-write cost in
//     the common case is one `readFile` of a small JSON stamp.
//   · The stamp is written BEFORE the sweep, not after. Two concurrent ctx runs
//     (the race `artifact-id.ts` exists for) would otherwise both see a stale
//     stamp and both sweep; claiming first means the loser skips.
//   · Discovery is skipped deliberately: this path sweeps the two gdctx targets
//     only (`gdctxTargets`), never the workspace conflict sidecars, which would
//     mean walking `.metaproject/workspaces/**` on a ctx write to bound a store
//     ctx does not write. Those stay with the human-invoked
//     `keryx retention sweep`, whose report covers every target.
//   · It NEVER fails or delays the command that triggered it beyond the sweep
//     itself, and it prints nothing: a ctx run's output is its summary, not
//     housekeeping. `keryx retention status` remains the place to see what the
//     policy is doing.
//
// `KERYX_RETENTION_AUTO=0` (or `off`/`false`) disables the automatic sweep for
// callers that want the store to grow untouched until they sweep it themselves.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultFsDeps, type RetentionFsDeps } from "./fs-deps";
import { gdctxTargets } from "./policy";
import { sweepAll, type SweepReport } from "./sweep";

/** At most one automatic sweep per project per day. */
export const AUTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const AUTO_SWEEP_ENV = "KERYX_RETENTION_AUTO";

/** Where the "when did an automatic sweep last run" stamp lives. */
export function autoSweepStampPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "retention", "last-auto-sweep.json");
}

export type AutoSweepOutcome =
  | { ran: false; reason: "disabled" | "throttled" | "stamp-unwritable" }
  | { ran: true; report: SweepReport };

function disabled(env: Record<string, string | undefined>): boolean {
  const raw = env[AUTO_SWEEP_ENV];
  return raw === "0" || raw === "off" || raw === "false";
}

/** When the last automatic sweep ran (epoch ms), or `null` if none ever has —
 * or the stamp is missing/corrupt, which this path treats identically. */
export async function lastAutoSweepAt(cwd: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(autoSweepStampPath(cwd), "utf8")) as { lastRunAtMs?: unknown };
    return typeof parsed.lastRunAtMs === "number" && Number.isFinite(parsed.lastRunAtMs)
      ? parsed.lastRunAtMs
      : null;
  } catch {
    // No stamp, or an unreadable/corrupt one: treat as "never swept". A
    // corrupt stamp must not mean "never sweep again"; the claim below
    // rewrites it.
    return null;
  }
}

/**
 * Apply the retention policy to the two gdctx stores, at most once per
 * interval. Never throws, never prints, and never reports a sweep it did not
 * perform — a caller that wants the outcome gets it back, a caller that does
 * not can ignore it.
 */
export async function maybeAutoSweepGdctx(
  cwd: string,
  options: {
    deps?: RetentionFsDeps;
    now?: number;
    env?: Record<string, string | undefined>;
    intervalMs?: number;
  } = {},
): Promise<AutoSweepOutcome> {
  const env = options.env ?? process.env;
  if (disabled(env)) return { ran: false, reason: "disabled" };

  const now = options.now ?? Date.now();
  const interval = options.intervalMs ?? AUTO_SWEEP_INTERVAL_MS;
  const previous = await lastAutoSweepAt(cwd);
  if (previous !== null && now - previous < interval) {
    return { ran: false, reason: "throttled" };
  }

  // Claim the interval BEFORE sweeping, so a concurrent ctx write skips rather
  // than sweeping the same store at the same time. If the stamp cannot be
  // written, do not sweep at all: an unthrottled sweep on every single ctx
  // write is a worse outcome than a store that keeps growing until someone
  // runs `keryx retention sweep`.
  const stamp = autoSweepStampPath(cwd);
  try {
    await mkdir(path.dirname(stamp), { recursive: true });
    await writeFile(stamp, `${JSON.stringify({ lastRunAtMs: now }, null, 2)}\n`, "utf8");
  } catch {
    return { ran: false, reason: "stamp-unwritable" };
  }

  const report = await sweepAll(gdctxTargets(cwd), options.deps ?? defaultFsDeps, {
    dryRun: false,
    now,
  });
  return { ran: true, report };
}
