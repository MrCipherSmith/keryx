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
//   · Concurrent ctx runs are serialized by an ATOMIC claim, not by writing the
//     stamp early. V237-02 (flow 237 T13): the previous version read the stamp,
//     tested the interval, then wrote it with a plain `writeFile` — a
//     check-then-act with nothing exclusive anywhere in it. Measured, 802
//     planted over-age entries:
//
//         8 processes released together on a barrier → 8 RAN, 0 skipped
//         the same 8 with staggered starts          → 1 ran, 7 skipped
//
//     Process-start skew was doing the work the mechanism claimed to do, and
//     the commit message that introduced it asserted the serialization as fact.
//     The claim below is `open(…, "wx")`: exactly one process can create the
//     file, so exactly one sweeps and the rest skip (`in-progress`) instead of
//     sweeping the same store at the same time.
//   · The stamp distinguishes STARTED from COMPLETED (V237-04). A mark written
//     before the act and read back as evidence of the act is not evidence: a
//     process killed mid-sweep used to leave `{ lastRunAtMs }` behind, and
//     `keryx retention status` reported it as "Last automatic sweep". Now the
//     start and the completion are separate fields, the status surface says
//     which it has, and the THROTTLE still counts a started-but-unfinished
//     sweep — a crash must not turn into an unthrottled sweep on every write.
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

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultFsDeps, type RetentionFsDeps } from "./fs-deps";
import { gdctxTargets } from "./policy";
import { sweepAll, type SweepReport } from "./sweep";

/** At most one automatic sweep per project per day. */
export const AUTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claim may sit before it is treated as abandoned.
 *
 * A sweep of both gdctx stores is thousands of `stat`s and takes seconds, so
 * this is generous by two orders of magnitude on purpose: breaking a claim that
 * a LIVE process still holds is the one failure this mechanism must not have.
 * A crashed holder costs at most this long, and only for the AUTOMATIC sweep —
 * `keryx retention sweep --apply` never consults the claim.
 */
export const AUTO_SWEEP_CLAIM_STALE_MS = 10 * 60 * 1000;

export const AUTO_SWEEP_ENV = "KERYX_RETENTION_AUTO";

/** Where the "when did an automatic sweep last run" stamp lives. */
export function autoSweepStampPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "retention", "last-auto-sweep.json");
}

/** The exclusive claim taken for the duration of one automatic sweep. */
export function autoSweepClaimPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "retention", "last-auto-sweep.claim");
}

export type AutoSweepOutcome =
  | { ran: false; reason: "disabled" | "throttled" | "stamp-unwritable" | "in-progress" }
  | { ran: true; report: SweepReport };

/**
 * What the stamp records. `startedAtMs` is written before the sweep (so the
 * throttle holds across a crash); `completedAtMs` is written only once the
 * sweep actually returned. A stamp with `completedAtMs: null` says a sweep
 * STARTED and its outcome is unknown — which is all a mark written beforehand
 * has ever been able to say honestly.
 */
export interface AutoSweepStamp {
  startedAtMs: number;
  completedAtMs: number | null;
}

function disabled(env: Record<string, string | undefined>): boolean {
  const raw = env[AUTO_SWEEP_ENV];
  return raw === "0" || raw === "off" || raw === "false";
}

/**
 * The stamp as it stands, or `null` when there is none — or it is unreadable or
 * corrupt, which this path treats identically ("never swept"), because a
 * corrupt stamp must not mean "never sweep again".
 *
 * A LEGACY `{ lastRunAtMs }` stamp is read as started-at with an UNKNOWN
 * completion, not as a completed sweep: that field was written before the sweep
 * ran, so reading it as proof the sweep finished would repeat exactly the claim
 * V237-04 is about. The next completed sweep replaces it.
 */
export async function readAutoSweepStamp(cwd: string): Promise<AutoSweepStamp | null> {
  try {
    const parsed = JSON.parse(await readFile(autoSweepStampPath(cwd), "utf8")) as {
      startedAtMs?: unknown;
      completedAtMs?: unknown;
      lastRunAtMs?: unknown;
    };
    const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
    if (finite(parsed.startedAtMs)) {
      return {
        startedAtMs: parsed.startedAtMs,
        completedAtMs: finite(parsed.completedAtMs) ? parsed.completedAtMs : null,
      };
    }
    if (finite(parsed.lastRunAtMs)) {
      return { startedAtMs: parsed.lastRunAtMs, completedAtMs: null };
    }
    return null;
  } catch {
    return null;
  }
}

/** When an automatic sweep last COMPLETED (epoch ms), or `null` if none has —
 * including the case where one started and never finished. Callers that need to
 * tell those two apart read `readAutoSweepStamp` instead. */
export async function lastAutoSweepAt(cwd: string): Promise<number | null> {
  return (await readAutoSweepStamp(cwd))?.completedAtMs ?? null;
}

/**
 * Take the exclusive claim, or answer `null` because someone else holds it.
 *
 * `flag: "wx"` is the whole mechanism: `open(O_CREAT|O_EXCL)` either creates
 * the file or fails, atomically, in the kernel — there is no window between
 * "does it exist" and "create it" for a second process to fit through. The
 * nonce is the same rule as `src/lib/file-lock.ts`: release only a claim that
 * is still OURS, so a holder whose claim was broken as stale cannot delete its
 * successor's.
 *
 * (`withFileLock` itself is not usable here: its critical section is
 * synchronous by construction, and a sweep is async.)
 */
/**
 * Whether a sweep is running RIGHT NOW, asked of the operating system.
 *
 * A claim file's age cannot answer this. A process killed mid-sweep leaves its
 * claim behind, and for the whole stale window that file is indistinguishable
 * from one held by a living process — so timing alone would report a dead
 * sweep as in progress, which is precisely the kind of confident wrong answer
 * this module exists to stop making.
 *
 * The claim carries the holder's pid, so the question is answerable rather
 * than guessable: signal 0 checks for the process without touching it. An
 * unparseable or foreign-looking claim returns true, because "I cannot tell"
 * must not be rendered as "nobody is there" — that reading would let a second
 * sweep start beside a live one.
 *
 * Read-only on purpose: the caller is not going to sweep either way, so this
 * must not create, break or touch the claim.
 */
async function claimIsLive(cwd: string, staleMs: number): Promise<boolean> {
  const claimPath = autoSweepClaimPath(cwd);
  const held = await stat(claimPath).catch(() => null);
  if (held === null || Date.now() - held.mtimeMs > staleMs) {
    return false;
  }
  const nonce = await readFile(claimPath, "utf8").catch(() => null);
  const pid = Number(nonce?.split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process — the holder is gone. EPERM: it exists and is
    // someone else's, which still means a process is there.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireClaim(
  claimPath: string,
  staleMs: number,
): Promise<{ release: () => Promise<void> } | null> {
  const nonce = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(claimPath, nonce, { flag: "wx", mode: 0o600 });
      return {
        release: async () => {
          try {
            if ((await readFile(claimPath, "utf8")) === nonce) {
              await rm(claimPath, { force: true });
            }
          } catch {
            // Gone already, or unreadable; a leftover goes stale and is broken
            // by the next caller.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Unwritable directory, read-only filesystem: not a contended claim.
        return null;
      }
      // Held. Break it only if it was abandoned — measured against the wall
      // clock, never against an injected `now`, because how long a FILE has
      // been sitting there is a real-time fact.
      const held = await stat(claimPath).catch(() => null);
      if (held !== null && Date.now() - held.mtimeMs > staleMs) {
        await rm(claimPath, { force: true }).catch(() => undefined);
        continue;
      }
      return null;
    }
  }
  return null;
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
    /** Test seam for the abandoned-claim window; see AUTO_SWEEP_CLAIM_STALE_MS. */
    claimStaleMs?: number;
  } = {},
): Promise<AutoSweepOutcome> {
  const env = options.env ?? process.env;
  if (disabled(env)) return { ran: false, reason: "disabled" };

  const now = options.now ?? Date.now();
  const interval = options.intervalMs ?? AUTO_SWEEP_INTERVAL_MS;
  const withinInterval = (stamp: AutoSweepStamp | null): boolean =>
    stamp !== null && now - stamp.startedAtMs < interval;

  // A STARTED sweep counts, finished or not: a process killed mid-sweep must
  // not turn the throttle off and put an unbounded sweep on every ctx write.
  //
  // But "we swept recently and finished" and "someone is sweeping RIGHT NOW"
  // are different facts, and collapsing them is the defect this whole module
  // was rewritten to remove. A completed stamp answers on its own, which keeps
  // the common path a single read with no write. An unfinished one is
  // ambiguous — a live sweep, or one that died — so it costs a stat of the
  // claim to say which.
  const seen = await readAutoSweepStamp(cwd);
  if (withinInterval(seen)) {
    if (seen?.completedAtMs != null) {
      return { ran: false, reason: "throttled" };
    }
    return { ran: false, reason: (await claimIsLive(cwd, options.claimStaleMs ?? AUTO_SWEEP_CLAIM_STALE_MS)) ? "in-progress" : "throttled" };
  }

  const stamp = autoSweepStampPath(cwd);
  try {
    await mkdir(path.dirname(stamp), { recursive: true });
  } catch {
    return { ran: false, reason: "stamp-unwritable" };
  }

  // Exactly one process gets past this line at a time.
  const claim = await acquireClaim(autoSweepClaimPath(cwd), options.claimStaleMs ?? AUTO_SWEEP_CLAIM_STALE_MS);
  if (claim === null) {
    return { ran: false, reason: "in-progress" };
  }

  try {
    // Re-read UNDER the claim: between our first read and the claim, the
    // previous holder may have finished and stamped. Without this the second
    // process through the door sweeps a store the first one just swept.
    if (withinInterval(await readAutoSweepStamp(cwd))) {
      return { ran: false, reason: "throttled" };
    }

    // Marked as started, and only as started. If this process dies here, the
    // stamp says a sweep began and never says it finished.
    try {
      await writeFile(stamp, `${JSON.stringify({ startedAtMs: now, completedAtMs: null }, null, 2)}\n`, "utf8");
    } catch {
      // An unthrottled sweep on every single ctx write is a worse outcome than
      // a store that keeps growing until someone runs `keryx retention sweep`.
      return { ran: false, reason: "stamp-unwritable" };
    }

    const report = await sweepAll(gdctxTargets(cwd), options.deps ?? defaultFsDeps, {
      dryRun: false,
      now,
    });

    // Completion is recorded only now, by the process that did the work.
    // `lastRunAtMs` is written alongside for any reader still on the old field
    // — and only here, so it never names a sweep that did not happen.
    const completedAtMs = options.now ?? Date.now();
    await writeFile(
      stamp,
      `${JSON.stringify({ startedAtMs: now, completedAtMs, lastRunAtMs: completedAtMs }, null, 2)}\n`,
      "utf8",
    ).catch(() => undefined);
    return { ran: true, report };
  } finally {
    await claim.release();
  }
}
