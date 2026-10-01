// Compose remote control for `keryx serve` (flow 376, block 2).
//
// `openRemoteService` is called by the composition root BEFORE the listener binds,
// because the listener needs the surface; `start` is called AFTER, because the hub
// needs to know where the listener is and must not poll for a listener that never
// came up. Nothing here is fatal to serve: every refusal comes back as a reason
// the caller prints, and the surface then answers 503 with that reason while the
// rest of the listener carries on.
//
//   - No remote config file at all: `disabled`. Serve is a plain serve; no shell
//     token is created, no route answers, nothing is polled.
//   - A config that is present but wrong: `unavailable`, with the reason.
//   - Remote is offered only on a loopback listener: the shell token is a local
//     credential and the shell reaches serve by the address in `endpoint.json`.
//   - One poller per bot token: a lock file refuses a second serve on this
//     machine without it ever calling getUpdates, and a 409 from Telegram (another
//     machine) stops this hub.
//   - A fresh shell token on every start, minted only AFTER the poller lock is held,
//     so a second serve that is about to be refused cannot rotate the token under
//     the one that is running. Until then the surface accepts no shell token.

import { unlinkSync } from "node:fs";
import { isLoopbackAddress } from "../lib/serve-config";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { openRemoteHub, type OpenRemoteHubOptions } from "./bootstrap";
import { loadRemoteConfig } from "./config";
import type { RemoteHub } from "./hub";
import { endpointPath, type RemoteEndpoint } from "./endpoint";
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
  /** Called with a line for the operator. Never carries a secret. */
  onNotice?: (message: string) => void;
  surface?: Pick<RemoteSurfaceOptions, "keepaliveMs" | "ackTimeoutMs" | "approvalIds">;
  lock?: Pick<AcquirePollLockOptions, "pid" | "isAlive"> & { disabled?: boolean };
}

export type RemoteStartResult = { ok: true } | { ok: false; reason: string };

export interface RemoteService {
  /** Hand this to `startServeListener({ remote })`. */
  surface: RemoteHttpSurface;
  /** The hub, once started. */
  hub(): RemoteHub | undefined;
  start(endpoint: { address: string; port: number }): Promise<RemoteStartResult>;
  stop(): Promise<void>;
}

export type OpenRemoteServiceResult =
  | { status: "disabled" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; service: RemoteService };

export function openRemoteService(options: OpenRemoteServiceOptions = {}): OpenRemoteServiceResult {
  const present = readConfigFile(remoteConfigPath(options.dir));
  if (!present.ok && present.reason === "absent") {
    return { status: "disabled" };
  }
  const config = loadRemoteConfig(options.dir);
  if (!config.ok) {
    return { status: "unavailable", reason: config.reason };
  }
  const notice = options.onNotice ?? (() => undefined);
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
  // Set when the poller reports a conflict before `start` has finished attaching the hub.
  let attached = false;
  let conflictWhileStarting: string | undefined;
  let stopping: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      const running = hub;
      hub = undefined;
      surface.detach(reason);
      await surface.close();
      if (running !== undefined) {
        await running.stop();
      }
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
    status: "ready",
    service: {
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
          deliver: surface.consumer.deliver,
          ...(surface.consumer.deliverCallback === undefined ? {} : { deliverCallback: surface.consumer.deliverCallback }),
          onPollerStatus: (status) => {
            if (status.state === "conflict") {
              const reason = status.reason ?? "another poller owns this bot token";
              if (!attached) {
                // The first poll can lose before `start` returns: `start` refuses, so the hub is never attached.
                conflictWhileStarting = reason;
                return;
              }
              // Another poller owns the token. Stop polling here for good, and say so on every route.
              void (async () => {
                surface.detach(reason);
                notice(`remote control is off: ${reason}`);
                await hub?.stop();
              })();
            }
          },
        });
        if (!opened.ok) {
          return refuse(opened.reason);
        }
        hub = opened.hub;
        try {
          await hub.start();
          ensureRemoteDir(options.dir);
          const body: RemoteEndpoint = { address: endpoint.address, port: endpoint.port, pid: process.pid };
          writeOwnerOnlyFileAtomic(endpointPath(options.dir), `${JSON.stringify(body)}\n`);
          endpointWritten = true;
        } catch (error) {
          hub = undefined;
          return refuse(`could not start remote control: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (conflictWhileStarting !== undefined) {
          return refuse(conflictWhileStarting);
        }
        surface.attach(hub);
        attached = true;
        return { ok: true };
      },
      stop,
    },
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
