// Compose remote control and the channels plane for `keryx serve` (flows 376, 377).
//
// `openRemoteService` is called by the composition root BEFORE the listener binds,
// because the listener needs the surface; `start` is called AFTER, because the hub
// needs to know where the listener is and must not poll for a listener that never
// came up. Nothing here is fatal to serve: every refusal comes back as a reason
// the caller prints, and the surface then answers 503 with that reason while the
// rest of the listener carries on.
//
// Two layers, so that connecting Telegram needs no serve restart:
//
//   - The CHANNELS PLANE is up as soon as serve holds the poller lock and has minted
//     a shell token, whether or not Telegram is configured. The shell uses it to pair,
//     connect, test and disconnect. It survives a conflict or a bad config.
//   - The HUB (the Telegram poller and topics) starts from the files on disk when they
//     exist, and again on a `channels-reload`. A missing config is not an error: it
//     means "not connected yet".
//
// Remote is offered only on a loopback listener: the shell token is a local credential
// and the shell reaches serve by the address in `endpoint.json`. One poller per bot
// token: a lock file refuses a second serve on this machine without it ever calling
// getUpdates, and a 409 from Telegram (another machine) stops this hub. A fresh shell
// token on every start, minted only AFTER the poller lock is held, so a second serve
// that is about to be refused cannot rotate the token under the one that is running.

import { unlinkSync } from "node:fs";
import { isLoopbackAddress } from "../lib/serve-config";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { openBotApi, openRemoteHub, type OpenRemoteHubOptions } from "./bootstrap";
import { ChannelsController, type ChannelsOptions } from "./channels";
import type { RemoteHub } from "./hub";
import { endpointPath, type RemoteEndpoint } from "./endpoint";
import { localMachineName } from "./naming";
import { ensureRemoteDir, remoteConfigPath } from "./paths";
import { acquirePollLock, type AcquirePollLockOptions, type PollLock } from "./poll-lock";
import { RemoteHttpSurface, type RemoteSurfaceOptions } from "./http-surface";
import { createShellTokenVerifier, mintShellToken } from "./shell-token";

export interface OpenRemoteServiceOptions
  extends Pick<
    OpenRemoteHubOptions,
    "api" | "now" | "timers" | "sweepIntervalMs" | "deliverRetryMs" | "pollTimeoutSec" | "pollBackoffMs" | "pollSleep" | "onEvent" | "beforeAck"
  > {
  dir?: string | undefined;
  /** This machine's name in topic names and the Test message. Defaults to the hostname. */
  machine?: string;
  /** Called with a line for the operator. Never carries a secret. */
  onNotice?: (message: string) => void;
  surface?: Pick<RemoteSurfaceOptions, "keepaliveMs" | "ackTimeoutMs" | "approvalIds">;
  lock?: Pick<AcquirePollLockOptions, "pid" | "isAlive"> & { disabled?: boolean };
  /** Test seams for a pairing (code, expiry, poll cadence). */
  pairing?: ChannelsOptions["pairing"];
  /** Test seam: topic names carry the machine name. Serve turns this on; plain tests keep the short names. */
  nameTopicsByMachine?: boolean;
}

/** `notConnected`: nothing is configured yet. The channels plane is up and no notice was printed. */
export type RemoteStartResult = { ok: true } | { ok: false; reason: string; notConnected?: true };

export interface RemoteService {
  /** Hand this to `startServeListener({ remote })`. */
  surface: RemoteHttpSurface;
  /** The hub, while it is running. */
  hub(): RemoteHub | undefined;
  start(endpoint: { address: string; port: number }): Promise<RemoteStartResult>;
  stop(): Promise<void>;
}

export function openRemoteService(options: OpenRemoteServiceOptions = {}): RemoteService {
  const notice = options.onNotice ?? (() => undefined);
  const machine = options.machine ?? localMachineName();
  // Set by `start`, once the poller lock is ours and a fresh token has been minted.
  let verifyShellToken: ((presented: string) => boolean) | undefined;
  const surface = new RemoteHttpSurface({
    verifyShellToken: (presented) => verifyShellToken?.(presented) ?? false,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...options.surface,
  });
  // Until the hub is up the surface answers 503 with the reason. Replaced on start.
  surface.detach("remote control has not started yet");

  let hub: RemoteHub | undefined;
  let lock: PollLock | undefined;
  let endpointWritten = false;
  let hubReason: string | undefined = "remote control has not started yet";
  let stopping: Promise<void> | undefined;
  // Serialises startHub / stopHub: a reload must not interleave with a conflict handler.
  let hubChain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = hubChain.then(work, work);
    hubChain = next.catch(() => undefined);
    return next;
  };

  const stopHubNow = async (reason: string): Promise<void> => {
    const running = hub;
    hub = undefined;
    hubReason = reason;
    surface.detach(reason);
    if (running !== undefined) {
      await running.stop();
    }
  };

  const startHubNow = async (): Promise<RemoteStartResult> => {
    if (hub !== undefined) {
      return { ok: true };
    }
    const present = readConfigFile(remoteConfigPath(options.dir));
    if (!present.ok && present.reason === "absent") {
      // Not an error: nothing is connected yet. Stay quiet.
      hubReason = "Telegram is not connected on this machine";
      surface.detach("Telegram is not connected on this machine; connect it from the shell with /channels");
      return { ok: false, reason: hubReason, notConnected: true };
    }
    let started = false;
    let conflictWhileStarting: string | undefined;
    let mine: RemoteHub | undefined;
    const opened = openRemoteHub({
      ...(options.dir === undefined ? {} : { dir: options.dir }),
      ...(options.api === undefined ? {} : { api: options.api }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
      ...(options.deliverRetryMs === undefined ? {} : { deliverRetryMs: options.deliverRetryMs }),
      ...(options.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: options.pollTimeoutSec }),
      ...(options.pollBackoffMs === undefined ? {} : { pollBackoffMs: options.pollBackoffMs }),
      ...(options.pollSleep === undefined ? {} : { pollSleep: options.pollSleep }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.beforeAck === undefined ? {} : { beforeAck: options.beforeAck }),
      ...(options.nameTopicsByMachine === true ? { machine } : {}),
      deliver: surface.consumer.deliver,
      ...(surface.consumer.deliverCallback === undefined ? {} : { deliverCallback: surface.consumer.deliverCallback }),
      onPollerStatus: (status) => {
        if (status.state !== "conflict") {
          return;
        }
        const reason = status.reason ?? "another poller owns this bot token";
        if (!started) {
          // The first poll can lose before `startHub` returns.
          conflictWhileStarting = reason;
          return;
        }
        // Another poller owns the token. Stop polling here for good, and say so on every route.
        void exclusive(async () => {
          if (hub !== mine) {
            return;
          }
          notice(`remote control is off: ${reason}`);
          await stopHubNow(reason);
        });
      },
    });
    if (!opened.ok) {
      notice(`remote control is off: ${opened.reason}`);
      hubReason = opened.reason;
      surface.detach(opened.reason);
      return { ok: false, reason: opened.reason };
    }
    mine = opened.hub;
    try {
      await mine.start();
    } catch (error) {
      const reason = `could not start remote control: ${error instanceof Error ? error.message : String(error)}`;
      await mine.stop().catch(() => undefined);
      notice(`remote control is off: ${reason}`);
      hubReason = reason;
      surface.detach(reason);
      return { ok: false, reason };
    }
    if (conflictWhileStarting !== undefined) {
      await mine.stop().catch(() => undefined);
      notice(`remote control is off: ${conflictWhileStarting}`);
      hubReason = conflictWhileStarting;
      surface.detach(conflictWhileStarting);
      return { ok: false, reason: conflictWhileStarting };
    }
    hub = mine;
    hubReason = undefined;
    surface.attach(mine);
    started = true;
    return { ok: true };
  };

  const controller = new ChannelsController({
    host: {
      dir: options.dir,
      machine,
      hub: () => hub,
      hubReason: () => hubReason,
      startHub: () => exclusive(startHubNow),
      stopHub: (reason) => exclusive(() => stopHubNow(reason)),
      openApi: () =>
        openBotApi({ ...(options.api === undefined ? {} : { api: options.api }), ...(options.dir === undefined ? {} : { dir: options.dir }) }),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    pairing: {
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: options.pollTimeoutSec }),
      ...(options.pollBackoffMs === undefined ? {} : { pollBackoffMs: options.pollBackoffMs }),
      ...(options.pollSleep === undefined ? {} : { pollSleep: options.pollSleep }),
      ...options.pairing,
    },
  });

  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      surface.detach(reason);
      await surface.close();
      await controller.stop();
      await exclusive(() => stopHubNow(reason));
      if (endpointWritten) {
        endpointWritten = false;
        removeEndpointIfOurs(options.dir);
      }
      if (lock?.ok) {
        lock.release();
      }
      lock = undefined;
    })();
    return stopping;
  };
  const stop = (): Promise<void> => shutdown("remote control has stopped");

  const refuse = async (reason: string): Promise<RemoteStartResult> => {
    notice(`remote control is off: ${reason}`);
    await shutdown(reason);
    return { ok: false, reason };
  };

  return {
    surface,
    hub: () => hub,
    async start(endpoint) {
      if (!isLoopbackAddress(endpoint.address)) {
        return refuse(
          `serve is bound to ${endpoint.address}, which is not a loopback address. Remote control is local-only; bind serve to 127.0.0.1 or ::1 to use it.`,
        );
      }
      if (options.lock?.disabled !== true) {
        lock = acquirePollLock({ dir: options.dir, ...options.lock });
        if (!lock.ok) {
          return refuse(lock.reason);
        }
      }
      // Every start rotates the token: whatever an earlier serve handed out stops working here.
      const token = mintShellToken(options.dir);
      if (!token.ok) {
        return refuse(token.reason);
      }
      verifyShellToken = createShellTokenVerifier(token.value);
      try {
        ensureRemoteDir(options.dir);
        const body: RemoteEndpoint = { address: endpoint.address, port: endpoint.port, pid: process.pid };
        writeOwnerOnlyFileAtomic(endpointPath(options.dir), `${JSON.stringify(body)}\n`);
        endpointWritten = true;
      } catch (error) {
        return refuse(`could not publish the local endpoint: ${error instanceof Error ? error.message : String(error)}`);
      }
      surface.setChannels((route, request) => controller.handle(route, request));
      // The plane is up. Whether the hub starts depends on the files on disk, and is reported, not fatal.
      return exclusive(startHubNow);
    },
    stop,
  };
}

function removeEndpointIfOurs(dir?: string): void {
  const file = endpointPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) {
    return;
  }
  try {
    const parsed = JSON.parse(read.text) as Partial<RemoteEndpoint>;
    if (parsed.pid === process.pid) {
      unlinkSync(file);
    }
  } catch {
    // Unreadable or already gone: nothing of ours to remove.
  }
}
