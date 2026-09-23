// Flow 300 T5 — the shared seam between the TUI's trigger-shaped sidebar
// sections: flow 300's Triggers (and Governance) section and flow 295's
// Schedules section.
//
// ## Public API
//
// Projection (read once, pure over what is on disk):
//
//   loadTriggerLedgerView(root, opts?) → Promise<TriggerLedgerView>
//       `.metaproject/triggers.json` + `.metaproject/data/trigger/runs.jsonl`,
//       joined per entry. Never throws: a missing config is `config.kind:
//       "absent"`, a file that is not a trigger config is `"broken"` with the
//       loader's problem, an unreadable ledger is `ledger.state: "unreadable"`.
//       `opts.recordsPerEntry` (default 20) caps each entry's `records`.
//   isScheduledEntry(entry) → boolean
//       `entry.fire.kind === "schedule"`. THE partition: flow 300's Triggers
//       section shows only entries for which this is false (plus one
//       "N scheduled" line); flow 295's Schedules section shows only the ones
//       for which it is true. Neither section filters any other way.
//   scheduledEntries(view) / eventEntries(view) → readonly TriggerEntryView[]
//       The two halves of `view.entries`, in file order.
//   findEntry(view, name) → TriggerEntryView | undefined
//
//   TriggerEntryView = { entry, scheduled, records (newest first, capped),
//                        latest (newest record or undefined), runCount }
//   TriggerLedgerView = { root, config, entries, rejected, ledger,
//                         openReservations, spend }
//
// Change detection (one poller per shell, many subscribers):
//
//   createTriggerLedgerWatcher({ root, intervalMs?, interval?, stat? })
//       → TriggerLedgerWatcher { ready, check(), subscribe(fn), onTick(fn), stop() }
//       Fingerprints (mtime + size) the three watched files:
//         "runs"       .metaproject/data/trigger/runs.jsonl
//         "triggers"   .metaproject/triggers.json
//         "governance" .metaproject/data/governance/artifacts/latest.json
//       `ready` resolves once the baseline is taken (no notification for it).
//       Each tick — and each explicit `check()`, which the shell calls after
//       every settled agent turn — notifies subscribers with the SET of
//       sources that changed, and only when that set is non-empty. So an
//       unchanged tick repaints nothing. `interval` is injectable: it receives
//       the tick and the period and returns a cancel function (tests call the
//       tick themselves; production uses an unref'd `setInterval`).
//       `onTick(fn)` runs on EVERY interval tick (changed or not), after its
//       check — for time-based repaints such as row ages.
//   triggerLedgerPaths(root) → Record<LedgerSource, string>
//
// A Schedules panel therefore needs exactly: `watcher.subscribe(changed =>
// changed.has("runs") || changed.has("triggers") ? refresh() : undefined)`,
// then `scheduledEntries(await loadTriggerLedgerView(root))` and each entry's
// `records`/`latest`.

import { stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { governanceDataRoot, readProjectTriggerSpend, type ProjectTriggerSpend } from "../governance/service";
import { loadTriggersConfig, triggersConfigPath, type RejectedTriggerEntry, type TriggerEntry, type TriggersFileProblem } from "../trigger/config";
import { openReservations, readTriggerRuns, triggerRunsPath, type OpenReservation, type TriggerRunRecord, type TriggerRunsRead } from "../trigger/record";

export type TriggerConfigState =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "broken"; readonly path: string; readonly problem: Exclude<TriggersFileProblem, "absent"> }
  | { readonly kind: "ok"; readonly path: string };

export interface TriggerEntryView {
  readonly entry: TriggerEntry;
  /** `isScheduledEntry(entry)`. */
  readonly scheduled: boolean;
  /** This entry's ledger records, NEWEST first, capped at `recordsPerEntry`. */
  readonly records: readonly TriggerRunRecord[];
  /** The newest record, or `undefined` when it never fired. */
  readonly latest: TriggerRunRecord | undefined;
  /** Every record this entry has in the ledger (uncapped count). */
  readonly runCount: number;
}

export interface TriggerLedgerView {
  readonly root: string;
  readonly config: TriggerConfigState;
  /** Valid entries in file order (both halves; see `isScheduledEntry`). */
  readonly entries: readonly TriggerEntryView[];
  readonly rejected: readonly RejectedTriggerEntry[];
  readonly ledger: TriggerRunsRead;
  readonly openReservations: readonly OpenReservation[];
  /** Project trigger spend, as `keryx governance report` computes it. */
  readonly spend: ProjectTriggerSpend;
}

export const DEFAULT_RECORDS_PER_ENTRY = 20;

export function isScheduledEntry(entry: TriggerEntry): boolean {
  return entry.fire.kind === "schedule";
}

export async function loadTriggerLedgerView(
  root: string,
  opts: { recordsPerEntry?: number } = {},
): Promise<TriggerLedgerView> {
  const limit = Math.max(1, opts.recordsPerEntry ?? DEFAULT_RECORDS_PER_ENTRY);
  const loaded = loadTriggersConfig(root);
  const configPath = triggersConfigPath(root);
  const config: TriggerConfigState =
    loaded.fileProblem === undefined
      ? { kind: "ok", path: configPath }
      : loaded.fileProblem === "absent"
        ? { kind: "absent", path: configPath }
        : { kind: "broken", path: configPath, problem: loaded.fileProblem };
  const [ledger, spend] = await Promise.all([readTriggerRuns(root), readProjectTriggerSpend(root)]);
  const records = ledger.state === "present" ? ledger.records : [];
  const byName = new Map<string, TriggerRunRecord[]>();
  for (const record of records) {
    const list = byName.get(record.trigger);
    if (list === undefined) byName.set(record.trigger, [record]);
    else list.push(record);
  }
  const entries = loaded.triggers.map((entry): TriggerEntryView => {
    const all = byName.get(entry.name) ?? [];
    const newestFirst = all.slice(-limit).reverse();
    return {
      entry,
      scheduled: isScheduledEntry(entry),
      records: newestFirst,
      latest: newestFirst[0],
      runCount: all.length,
    };
  });
  return {
    root,
    config,
    entries,
    rejected: loaded.rejected,
    ledger,
    openReservations: openReservations(records),
    spend,
  };
}

export function scheduledEntries(view: TriggerLedgerView): readonly TriggerEntryView[] {
  return view.entries.filter((e) => e.scheduled);
}

export function eventEntries(view: TriggerLedgerView): readonly TriggerEntryView[] {
  return view.entries.filter((e) => !e.scheduled);
}

export function findEntry(view: TriggerLedgerView, name: string): TriggerEntryView | undefined {
  return view.entries.find((e) => e.entry.name === name);
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export type LedgerSource = "runs" | "triggers" | "governance";

export const LEDGER_SOURCES: readonly LedgerSource[] = ["runs", "triggers", "governance"];

export function triggerLedgerPaths(root: string): Record<LedgerSource, string> {
  return {
    runs: triggerRunsPath(root),
    triggers: triggersConfigPath(root),
    governance: path.join(governanceDataRoot(root), "artifacts", "latest.json"),
  };
}

export type LedgerStat = (file: string) => Promise<{ mtimeMs: number; size: number } | undefined>;

/** Schedules `tick` every `ms`; returns the cancel function. */
export type LedgerInterval = (tick: () => Promise<void>, ms: number) => () => void;

export interface TriggerLedgerWatcher {
  /** Resolves once the baseline fingerprints are taken. */
  readonly ready: Promise<void>;
  /** Compare now; notify subscribers when anything changed. Returns what changed. */
  check(): Promise<ReadonlySet<LedgerSource>>;
  subscribe(listener: (changed: ReadonlySet<LedgerSource>) => void): () => void;
  /** Called on EVERY interval tick, changed or not, after its check — for time-based repaints (row ages). */
  onTick(listener: () => void): () => void;
  stop(): void;
}

export const DEFAULT_LEDGER_POLL_MS = 3000;

const defaultStat: LedgerStat = async (file) => {
  try {
    const s = await fsStat(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
};

const defaultInterval: LedgerInterval = (tick, ms) => {
  const handle = setInterval(() => {
    void tick();
  }, ms);
  (handle as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
};

export function createTriggerLedgerWatcher(opts: {
  root: string;
  intervalMs?: number;
  interval?: LedgerInterval;
  stat?: LedgerStat;
}): TriggerLedgerWatcher {
  const paths = triggerLedgerPaths(opts.root);
  const statFile = opts.stat ?? defaultStat;
  const listeners = new Set<(changed: ReadonlySet<LedgerSource>) => void>();
  const tickListeners = new Set<() => void>();
  let baseline: Map<LedgerSource, string> | undefined;
  let inFlight: Promise<ReadonlySet<LedgerSource>> | undefined;
  let stopped = false;

  const fingerprint = async (): Promise<Map<LedgerSource, string>> => {
    const out = new Map<LedgerSource, string>();
    await Promise.all(
      LEDGER_SOURCES.map(async (source) => {
        const s = await statFile(paths[source]);
        out.set(source, s === undefined ? "absent" : `${s.mtimeMs}:${s.size}`);
      }),
    );
    return out;
  };

  const runCheck = async (): Promise<ReadonlySet<LedgerSource>> => {
    const now = await fingerprint();
    const changed = new Set<LedgerSource>();
    if (baseline !== undefined) {
      for (const source of LEDGER_SOURCES) {
        if (baseline.get(source) !== now.get(source)) changed.add(source);
      }
    }
    baseline = now;
    if (changed.size > 0 && !stopped) {
      for (const listener of [...listeners]) {
        try {
          listener(changed);
        } catch {
          // one broken subscriber must not starve the others
        }
      }
    }
    return changed;
  };

  // Serialized: a tick landing while a check is in flight waits for it and
  // then runs its own, so two overlapping stats never race the baseline.
  const check = (): Promise<ReadonlySet<LedgerSource>> => {
    const next = (inFlight ?? Promise.resolve(new Set<LedgerSource>())).then(runCheck, runCheck);
    inFlight = next;
    return next;
  };

  const ready = check().then(() => undefined);
  const cancel = (opts.interval ?? defaultInterval)(async () => {
    if (stopped) return;
    await check();
    for (const listener of [...tickListeners]) {
      try {
        listener();
      } catch {
        // a broken tick subscriber must not stop the poller
      }
    }
  }, opts.intervalMs ?? DEFAULT_LEDGER_POLL_MS);

  return {
    ready,
    check,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onTick(listener) {
      tickListeners.add(listener);
      return () => {
        tickListeners.delete(listener);
      };
    },
    stop() {
      stopped = true;
      listeners.clear();
      tickListeners.clear();
      cancel();
    },
  };
}
