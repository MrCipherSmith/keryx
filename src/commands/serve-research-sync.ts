// Flow 404 (AC8): the composition root that lets `keryx serve` run the daily Part 1 materials sync.
//
// The job itself (`../scheduler/research-sync-job.ts`) knows nothing about serve or the catalog's path. This file
// connects it the way `serve-digest.ts` connects the digest: the project roots to look in, the in-process
// `runResearchSync` as the sync, and serve's own notice line as the place a failure is reported. The sync runs
// in this process, not as a child `keryx` (the exit code of serve is never touched), and nothing it does can
// throw out of the tick.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { runResearchSyncPass, type ResearchSyncJobDeps, type ResearchSyncReport } from "../scheduler/research-sync-job";
import { CATALOG_DIR, runResearchSync } from "./research-sync";
import { serveDigestRoots } from "./serve-digest";

/** The day only changes once in 24 hours: a few minutes between looks is plenty, and the first look is immediate. */
export const SERVE_RESEARCH_SYNC_EVERY_MS = 5 * 60_000;

export interface ServeResearchSyncOptions {
  readonly cwd?: string;
  readonly onNotice?: (message: string) => void;
  /** Test seams. Defaults: the real roots, the real sync, a stat of the catalog directory. */
  readonly roots?: () => readonly string[];
  readonly sync?: ResearchSyncJobDeps["sync"];
  readonly hasCatalog?: ResearchSyncJobDeps["hasCatalog"];
  readonly now?: () => Date;
  readonly everyMs?: number;
  readonly arm?: (tick: () => void, everyMs: number) => () => void;
}

export interface ServeResearchSync {
  /** One pass over every project that opted in. Resolves when it is done; never rejects. */
  tick(): Promise<ResearchSyncReport[]>;
  start(): void;
  /** Stop ticking and wait for a pass in progress. */
  stop(): Promise<void>;
}

export function createServeResearchSync(options: ServeResearchSyncOptions = {}): ServeResearchSync {
  const everyMs = options.everyMs ?? SERVE_RESEARCH_SYNC_EVERY_MS;
  let stopTimer: (() => void) | undefined;
  let running: Promise<ResearchSyncReport[]> | undefined;

  const pass = (): Promise<ResearchSyncReport[]> =>
    runResearchSyncPass({
      roots: options.roots ?? (() => serveDigestRoots(options.cwd)),
      sync: options.sync ?? ((root) => runResearchSync({ root })),
      hasCatalog: options.hasCatalog ?? ((root) => pathExists(path.join(root, CATALOG_DIR))),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.onNotice !== undefined ? { onNotice: options.onNotice } : {}),
    });

  const job: ServeResearchSync = {
    tick(): Promise<ResearchSyncReport[]> {
      // One pass at a time: a slow sync must not be started twice by the next interval.
      if (running !== undefined) return running;
      const current = pass()
        .catch((): ResearchSyncReport[] => [])
        .finally(() => {
          running = undefined;
        });
      running = current;
      return current;
    },
    start(): void {
      if (stopTimer !== undefined) return;
      const tick = (): void => {
        void job.tick();
      };
      stopTimer =
        options.arm?.(tick, everyMs) ??
        ((): (() => void) => {
          const timer = setInterval(tick, everyMs);
          timer.unref?.();
          return () => clearInterval(timer);
        })();
      tick();
    },
    async stop(): Promise<void> {
      stopTimer?.();
      stopTimer = undefined;
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
  return job;
}
