// Flow 389 (AC1): the digest schedule fires by itself inside `keryx serve`.
//
// There is no second scheduler. A digest is an ordinary stored `agent-task` schedule (flow 295)
// with a `digest` block; what is different is WHO fires it. Other schedules are fired by an OS
// timer that runs `keryx trigger run`. A digest has no OS timer: `keryx serve` is already a
// long-running process with the project's Telegram path, so serve calls this ticker, which
// finds the due digests and hands each to the same `runTriggerOnce` the timer would have
// called (so the confirmation hash, the lock, the spend rules and the run record are all
// flow 295's).
//
// Exactly once per slot, across restarts. The slot is the most recent cron time at or before
// now. Before a run starts, the slot is CLAIMED in `.metaproject/data/digest/<name>/fired.json`.
// The next tick (or the next serve process) reads that file, sees the slot is claimed, and
// starts nothing. A serve that was down at the cron time starts one run for the newest missed
// slot when it comes back, never one per missed slot. A slot is claimed before the run, so a
// crash in the middle of a run is NOT run a second time; the run record shows the failure.
//
// A digest that was paused does not catch up when it is resumed: a paused tick re-anchors it.
//
// The clock, the project roots, the run and the delivery flush are all injected, so a test
// drives this with a fake clock and a fake `fire` and never starts a timer.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, writeFileAtomic } from "../lib/fs";
import { loadTriggersConfig, type AgentTaskAction, type TriggerEntry } from "../trigger/config";
import { nextCronRuns } from "../trigger/cron";
import { digestScheduleDir, ensureDigestDataIgnored } from "./digest-snapshot";

export interface FiredState {
  readonly version: 1;
  /** ISO time of the last slot that was claimed (or, for a new or resumed digest, the moment it was armed). */
  readonly slot: string;
  /** True when a run was started for `slot`; false when `slot` is only the anchor. */
  readonly fired: boolean;
  /** Set while the digest is paused; the next enabled tick re-anchors instead of catching up. */
  readonly pausedAt?: string;
}

export type TickAction = "fired" | "armed" | "waiting" | "paused" | "skipped";

export interface TickReport {
  readonly root: string;
  readonly name: string;
  readonly action: TickAction;
  /** The slot a run was started for, when `action` is `fired`. */
  readonly slot?: string;
  readonly detail?: string;
}

export interface TickerDeps {
  /** Project roots that may hold digest schedules (serve passes the working directory and the registered projects). */
  readonly roots: () => readonly string[];
  /** Start one run. Serve passes `runTriggerOnce(root, name, overrides, { scheduleOnly: true })`. */
  readonly fire: (root: string, name: string) => Promise<void>;
  /** Send what the run, or an earlier run, left in the delivery queue. Called for every digest on every tick. */
  readonly flush: (root: string, name: string) => Promise<void>;
  readonly now?: () => Date;
  readonly onNotice?: (message: string) => void;
  /** Start the repeating tick; returns the stop function. Default: `setInterval`, unref'd. */
  readonly arm?: (tick: () => void, everyMs: number) => () => void;
  readonly everyMs?: number;
}

export interface DigestTicker {
  /** Check every digest once. Resolves when the runs it started have finished. */
  tick(): Promise<TickReport[]>;
  start(): void;
  /** Stop ticking and wait for a tick in progress. */
  stop(): Promise<void>;
}

export const TICK_EVERY_MS = 30_000;

export type DigestScheduleEntry = TriggerEntry & { action: AgentTaskAction & { digest: NonNullable<AgentTaskAction["digest"]> }; fire: { kind: "schedule"; cron: string } };

/** Every enabled-or-paused stored digest schedule of one project. */
export function digestEntries(projectRoot: string): DigestScheduleEntry[] {
  return loadTriggersConfig(projectRoot).triggers.filter(
    (t): t is DigestScheduleEntry => t.source === "store" && t.action.kind === "agent-task" && t.action.digest !== undefined && t.fire.kind === "schedule",
  );
}

export function firedPath(projectRoot: string, name: string): string {
  return path.join(digestScheduleDir(projectRoot, name), "fired.json");
}

export async function readFired(projectRoot: string, name: string): Promise<FiredState | undefined> {
  try {
    const raw = JSON.parse(await readFile(firedPath(projectRoot, name), "utf8")) as Record<string, unknown> | null;
    if (raw !== null && typeof raw["slot"] === "string" && typeof raw["fired"] === "boolean") {
      return { version: 1, slot: raw["slot"], fired: raw["fired"], ...(typeof raw["pausedAt"] === "string" ? { pausedAt: raw["pausedAt"] } : {}) };
    }
    return undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
}

async function writeFired(projectRoot: string, name: string, state: FiredState): Promise<void> {
  await ensureDigestDataIgnored(projectRoot);
  await writeFileAtomic(firedPath(projectRoot, name), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The newest cron slot after `anchor` that is at or before `now`, or undefined when none is due.
 * Several missed slots collapse into the newest one.
 */
export function dueSlot(cron: string, anchor: Date, now: Date): Date | undefined {
  let newest: Date | undefined;
  let from = anchor;
  // Bounded: a minutely cron missed for a week is ~10k slots; a thousand per pass is plenty, and the loop continues from the last one found.
  for (let pass = 0; pass < 20; pass += 1) {
    const slots = nextCronRuns(cron, from, 1000);
    if (slots.length === 0) break;
    for (const s of slots) {
      if (s.getTime() <= now.getTime()) newest = s;
    }
    const last = slots[slots.length - 1]!;
    if (last.getTime() > now.getTime() || slots.length < 1000) break;
    from = last;
  }
  return newest;
}

function minuteFloor(d: Date): Date {
  const t = new Date(d.getTime());
  t.setSeconds(0, 0);
  return t;
}

export function createDigestTicker(deps: TickerDeps): DigestTicker {
  const now = deps.now ?? (() => new Date());
  let stopTimer: (() => void) | undefined;
  let running: Promise<TickReport[]> | undefined;

  async function tickOne(root: string, entry: DigestScheduleEntry): Promise<TickReport> {
    const name = entry.name;
    const at = now();
    const state = await readFired(root, name);

    if (!entry.enabled) {
      if (state === undefined || state.pausedAt === undefined) {
        await writeFired(root, name, { version: 1, slot: (state?.slot ?? minuteFloor(at).toISOString()), fired: state?.fired ?? false, pausedAt: at.toISOString() });
      }
      return { root, name, action: "paused" };
    }

    // New digest, or one just resumed: nothing is owed for the time before now.
    if (state === undefined || state.pausedAt !== undefined) {
      await writeFired(root, name, { version: 1, slot: minuteFloor(at).toISOString(), fired: false });
      return { root, name, action: "armed", detail: "armed; the first run is at the next cron time" };
    }

    const slot = dueSlot(entry.fire.cron, new Date(state.slot), at);
    if (slot === undefined) return { root, name, action: "waiting" };

    // Claim the slot BEFORE the run: a second tick, or a restarted serve, now sees it taken.
    await writeFired(root, name, { version: 1, slot: slot.toISOString(), fired: true });
    try {
      await deps.fire(root, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.onNotice?.(`digest "${name}" could not run: ${message}`);
      return { root, name, action: "fired", slot: slot.toISOString(), detail: `run threw: ${message}` };
    }
    return { root, name, action: "fired", slot: slot.toISOString() };
  }

  async function runTick(): Promise<TickReport[]> {
    const reports: TickReport[] = [];
    const seen = new Set<string>();
    for (const rootRaw of deps.roots()) {
      const root = path.resolve(rootRaw);
      if (seen.has(root)) continue;
      seen.add(root);
      let entries: DigestScheduleEntry[];
      try {
        entries = digestEntries(root);
      } catch (error) {
        deps.onNotice?.(`digest schedules of ${root} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const entry of entries) {
        try {
          reports.push(await tickOne(root, entry));
        } catch (error) {
          reports.push({ root, name: entry.name, action: "skipped", detail: error instanceof Error ? error.message : String(error) });
          deps.onNotice?.(`digest "${entry.name}" skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Delivery is retried on every tick, also while the digest is paused: a message already queued is still owed.
        try {
          await deps.flush(root, entry.name);
        } catch (error) {
          deps.onNotice?.(`digest "${entry.name}" delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return reports;
  }

  const ticker: DigestTicker = {
    tick(): Promise<TickReport[]> {
      // One tick at a time: a slow digest must not be started twice by the next interval.
      if (running !== undefined) return running;
      const current = runTick().finally(() => {
        running = undefined;
      });
      running = current;
      return current;
    },
    start(): void {
      if (stopTimer !== undefined) return;
      const every = deps.everyMs ?? TICK_EVERY_MS;
      const tick = (): void => {
        void ticker.tick();
      };
      stopTimer =
        deps.arm?.(tick, every) ??
        ((): (() => void) => {
          const timer = setInterval(tick, every);
          timer.unref?.();
          return () => clearInterval(timer);
        })();
      // The first check is immediate: a slot missed while serve was down is caught up at once.
      tick();
    },
    async stop(): Promise<void> {
      stopTimer?.();
      stopTimer = undefined;
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
  return ticker;
}
