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
      await runTriggerOnce(root, name, { digest: sink !== undefined ? { sink } : {} }, { scheduleOnly: true });
    },
    flush: async (root, name) => {
      const sink = sinkNow();
      if (sink !== undefined) await flushDeliveries(root, name, sink, () => new Date());
    },
    ...(options.onNotice !== undefined ? { onNotice: options.onNotice } : {}),
  });
}
