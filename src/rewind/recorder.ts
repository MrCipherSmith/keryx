import { loadManifest, saveManifest, type RewindEntry, type RewindManifest } from "./manifest";
import { restoreTree, type RestoreResult } from "./restore";
import { enforceRetention, REWIND_MAX_SNAPSHOTS } from "./retention";
import { initShadow, shadowRepo, type ShadowRepo } from "./shadow";
import { captureTree, changedFiles, writeSnapshotRef } from "./snapshot";

const PROMPT_LIMIT = 200;

export interface RewindRecorderOptions {
  workTree: string;
  /** The current session's rewind directory; undefined while there is no persisted session. */
  dir: () => string | undefined;
  enabled?: () => boolean;
  maxSnapshots?: number;
  now?: () => Date;
  onError?: (message: string) => void;
}

export interface RewindListing {
  seq: number;
  kind: RewindEntry["kind"];
  at: string;
  prompt: string;
  archiveIndex: number | null;
  files: number;
  changed: string[];
  skipped: string[];
}

export type RewindFilesOutcome = ({ ok: true; preRewindSeq: number } & RestoreResult) | { ok: false; reason: string };

export interface RewindRecorder {
  beginTurn(input: { archiveIndex: number | null; prompt: string }): void;
  /** Snapshot the work tree once per turn, right before the first mutating tool call. Never throws. */
  beforeMutation(): Promise<void>;
  snapshotCount(): number;
  entries(): RewindEntry[];
  describe(): Promise<RewindListing[]>;
  restoreFiles(seq: number): Promise<RewindFilesOutcome>;
  enabled(): boolean;
}

export function rewindDisabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  return (env.KERYX_REWIND ?? "").trim().toLowerCase() === "off";
}

interface TurnState {
  archiveIndex: number | null;
  prompt: string;
  taken?: { dir: string; done: Promise<void> };
}

export function createRewindRecorder(options: RewindRecorderOptions): RewindRecorder {
  const enabled = options.enabled ?? ((): boolean => !rewindDisabledByEnv());
  const max = options.maxSnapshots ?? REWIND_MAX_SNAPSHOTS;
  const now = options.now ?? ((): Date => new Date());
  let turn: TurnState = { archiveIndex: null, prompt: "" };
  let cache: { dir: string; manifest: RewindManifest } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let reported = false;
  const ready = new Set<string>();
  const diffCache = new Map<string, string[]>();

  const report = (error: unknown): void => {
    if (reported) return;
    reported = true;
    options.onError?.(`rewind: ${error instanceof Error ? error.message : String(error)}`);
  };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const manifestFor = (dir: string): RewindManifest => {
    if (cache?.dir !== dir) cache = { dir, manifest: loadManifest(dir) };
    return cache.manifest;
  };
  const repoFor = async (dir: string): Promise<ShadowRepo> => {
    const repo = shadowRepo(dir, options.workTree);
    if (!ready.has(repo.gitDir)) {
      await initShadow(repo);
      ready.add(repo.gitDir);
    }
    return repo;
  };
  const applyRetention = async (dir: string, repo: ShadowRepo): Promise<void> => {
    const manifest = manifestFor(dir);
    manifest.entries = (await enforceRetention(repo, manifest.entries, max)).keep;
    await saveManifest(dir, manifest);
  };
  const record = async (dir: string, kind: RewindEntry["kind"], archiveIndex: number | null, prompt: string, prune = true): Promise<RewindEntry> => {
    const repo = await repoFor(dir);
    const manifest = manifestFor(dir);
    const captured = await captureTree(repo);
    const entry: RewindEntry = {
      seq: manifest.nextSeq,
      kind,
      tree: captured.tree,
      at: now().toISOString(),
      archiveIndex,
      prompt: prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_LIMIT),
      skipped: captured.skipped,
    };
    await writeSnapshotRef(repo, entry.seq, entry.tree);
    manifest.nextSeq += 1;
    manifest.entries.push(entry);
    if (prune) await applyRetention(dir, repo);
    else await saveManifest(dir, manifest);
    return entry;
  };

  return {
    enabled,
    beginTurn(input) {
      turn = { archiveIndex: input.archiveIndex, prompt: input.prompt };
    },
    beforeMutation() {
      if (!enabled()) return Promise.resolve();
      const dir = options.dir();
      if (dir === undefined) return Promise.resolve();
      const current = turn;
      if (current.taken?.dir === dir) return current.taken.done;
      const done = serial(() => record(dir, "turn", current.archiveIndex, current.prompt)).then(
        () => undefined,
        (error: unknown) => {
          report(error);
        },
      );
      current.taken = { dir, done };
      return done;
    },
    snapshotCount() {
      const dir = options.dir();
      if (dir === undefined || !enabled()) return 0;
      return manifestFor(dir).entries.length;
    },
    entries() {
      const dir = options.dir();
      if (dir === undefined) return [];
      return [...manifestFor(dir).entries];
    },
    async describe() {
      const dir = options.dir();
      if (dir === undefined) return [];
      const entries = [...manifestFor(dir).entries];
      if (entries.length === 0) return [];
      return serial(async () => {
        const repo = await repoFor(dir);
        let liveTree: string | undefined;
        const listings: RewindListing[] = [];
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i]!;
          let next = entries[i + 1]?.tree;
          if (next === undefined) {
            liveTree ??= (await captureTree(repo)).tree;
            next = liveTree;
          }
          const key = `${entry.tree}:${next}`;
          let changed = diffCache.get(key);
          if (changed === undefined) {
            changed = await changedFiles(repo, entry.tree, next);
            if (entries[i + 1] !== undefined) diffCache.set(key, changed);
          }
          listings.push({ seq: entry.seq, kind: entry.kind, at: entry.at, prompt: entry.prompt, archiveIndex: entry.archiveIndex, files: changed.length, changed, skipped: entry.skipped });
        }
        return listings.reverse();
      });
    },
    async restoreFiles(seq) {
      const dir = options.dir();
      if (!enabled() || dir === undefined) return { ok: false, reason: "File snapshots are not recorded for this session." };
      const target = manifestFor(dir).entries.find((entry) => entry.seq === seq);
      if (target === undefined) return { ok: false, reason: `Snapshot ${seq} no longer exists.` };
      try {
        return await serial(async () => {
          const before = await record(dir, "pre-rewind", null, `Before rewind to snapshot ${seq}`, false);
          const repo = await repoFor(dir);
          const result = await restoreTree(repo, target.tree);
          await applyRetention(dir, repo);
          return { ok: true as const, preRewindSeq: before.seq, ...result };
        });
      } catch (error) {
        return { ok: false, reason: `Could not restore files: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
