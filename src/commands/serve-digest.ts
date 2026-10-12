// Flow 389: the composition root that lets `keryx serve` fire scheduled digests.
//
// The ticker itself (`../scheduler/digest-ticker.ts`) knows nothing about serve or Telegram.
// This file connects it: the project roots to look in, the same `runTriggerOnce` an OS timer
// would call, and serve's own Telegram hub as the delivery path. A digest therefore never
// opens a second bot client, and a delivery that serve cannot make yet (the hub is not
// connected) simply waits in the digest's queue for a later tick.

import { listProjects } from "../lib/project-registry";
import type { RemoteHub } from "../remote/hub";
import { flushDeliveries, hubSink, type DigestSink } from "../scheduler/digest-delivery";
import type { DigestDeps } from "../scheduler/digest-run";
import { createDigestTicker, type DigestTicker } from "../scheduler/digest-ticker";
import { runTriggerOnce } from "./trigger";

export interface ServeDigestOptions {
  /** The hub of the running serve; `undefined` while Telegram is not connected. */
  readonly hub: () => RemoteHub | undefined;
  readonly cwd?: string;
  readonly onNotice?: (message: string) => void;
}

/** The directories serve looks in: its own working directory and every registered project that still exists. */
export function serveDigestRoots(cwd: string = process.cwd()): string[] {
  const roots = [cwd];
  try {
    for (const project of listProjects()) {
      if (project.state === "active") roots.push(project.path);
    }
  } catch {
    // an unreadable registry leaves the working directory as the only root
  }
  return roots;
}

/**
 * One scheduled digest run, as serve fires it.
 *
 * `runTriggerOnce` is the CLI path: it sets `process.exitCode = 1` when the run failed so that
 * `keryx trigger run` exits non-zero. Serve is a long-running process: a digest that failed (gh
 * down, a limit hit) is already in the run record, the report and the topic, and must not make
 * serve itself exit non-zero when it is stopped later. The exit code is put back as it was.
 */
export async function fireDigest(root: string, name: string, digest: DigestDeps): Promise<void> {
  const before = process.exitCode;
  try {
    await runTriggerOnce(root, name, { digest }, { scheduleOnly: true });
  } finally {
    process.exitCode = before;
  }
}

/** Build (not start) the ticker serve runs. */
export function createServeDigestTicker(options: ServeDigestOptions): DigestTicker {
  const sinkNow = (): DigestSink | undefined => {
    const hub = options.hub();
    return hub === undefined ? undefined : hubSink(hub);
  };
  return createDigestTicker({
    roots: () => serveDigestRoots(options.cwd),
    fire: async (root, name) => {
      const sink = sinkNow();
      await fireDigest(root, name, sink !== undefined ? { sink } : {});
    },
    flush: async (root, name) => {
      const sink = sinkNow();
      if (sink !== undefined) await flushDeliveries(root, name, sink, () => new Date());
    },
    ...(options.onNotice !== undefined ? { onNotice: options.onNotice } : {}),
  });
}
