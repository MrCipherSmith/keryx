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
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { isLoopbackAddress } from "../lib/serve-config";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { parseRemoteConfig } from "./config";
import { createHttpBotApi } from "./bot-api-http";
import { commitChannelRecord, disconnectChannelRecord, loadChannelRecord, migrateLegacyChannelRecord, type ChannelRecord } from "./channel-record";
import { RemoteHub } from "./hub";
import { openBotApi, openRemoteHub, type OpenRemoteHubOptions } from "./bootstrap";
import { ChannelsController, type ChannelsOptions } from "./channels";
import { endpointPath, type RemoteEndpoint } from "./endpoint";
import { localMachineName } from "./naming";
import { ensureRemoteDir, remoteConfigPath, remoteDirPath } from "./paths";
import { acquirePollLock, type AcquirePollLockOptions, type PollLock } from "./poll-lock";
import { RemoteHttpSurface, type RemoteSurfaceOptions } from "./http-surface";
import { createShellTokenVerifier, mintShellToken, serveResponseProof } from "./shell-token";

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
  surface?: Pick<RemoteSurfaceOptions, "keepaliveMs" | "ackTimeoutMs" | "approvalAckMs" | "approvalIds" | "promptIds" | "reminderMs">;
  lock?: Pick<AcquirePollLockOptions, "pid" | "isAlive"> & { disabled?: boolean };
  /** Test-only opt-in; the production capability remains unavailable. */
  experimentalChannelControl?: boolean;
  /** Test seam for a candidate distinct from the injected active API. */
  candidateApi?: (token: string) => import("./types").BotApi;
  /** Test seam for post-commit failure and competing writers. */
  afterCandidateCommit?: () => Promise<void>;
  /** Test seam for a concurrent mutation after owner revocation. */
  afterBindingRevocation?: () => Promise<void>;
  /** Test seam for the bounded owner acknowledgement wait. */
  revocationTimeoutMs?: number;
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
  let shellToken: string | undefined;
  const surface = new RemoteHttpSurface({
    verifyShellToken: (presented) => verifyShellToken?.(presented) ?? false,
    proveResponse: (nonce, route, status, body) => (shellToken === undefined ? undefined : serveResponseProof(shellToken, nonce, route, status, body)),
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

  const readCommittedConfig = (bindingId: string | undefined, botId: number | undefined) => () => {
    const current = loadChannelRecord(options.dir);
    if (!current.ok || current.value?.state !== "connected" || current.value.bindingId !== bindingId || current.value.bot?.id !== botId) return undefined;
    return current.value.config;
  };

  /** Recover a revoked channel into a new namespace; no old binding is reused. */
  const recoverRetiredChannel = async (previous: Extract<ChannelRecord, { state: "connected" }>, expectedRevision: number, stillActive: () => boolean): Promise<boolean> => {
    if (!stillActive() || hub !== undefined) return false;
    const bindingId = randomBytes(16).toString("hex");
    const stateDir = ensureRemoteDir(options.dir, "channel-state", bindingId);
    const api = options.api ?? createHttpBotApi({ token: previous.token });
    const restored = new RemoteHub({ api, config: previous.config, staged: true, dir: stateDir,
      currentConfig: readCommittedConfig(bindingId, previous.bot?.id),
      ...(options.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: options.pollTimeoutSec }),
      ...(options.pollBackoffMs === undefined ? {} : { pollBackoffMs: options.pollBackoffMs }),
      ...(options.pollSleep === undefined ? {} : { pollSleep: options.pollSleep }),
      onPollerStatus: (status) => {
        if (status.state !== "conflict") return;
        void exclusive(async () => {
          if (hub === restored) await stopHubNow(status.reason ?? "another poller owns this bot token");
        });
      },
      deliver: surface.consumer.deliver,
      ...(surface.consumer.deliverCallback === undefined ? {} : { deliverCallback: surface.consumer.deliverCallback }),
    });
    let restoredRevision: number | undefined;
    try {
      await restored.start();
      if (!await restored.waitForPollerReady(30_000) || !stillActive()) return false;
      const committed = await commitChannelRecord(expectedRevision, { token: previous.token, bot: previous.bot, config: previous.config, bindingId }, options.dir, () => stillActive() && hub === undefined);
      if (!committed.ok) return false;
      restoredRevision = committed.value.revision;
      const current = loadChannelRecord(options.dir);
      if (!current.ok || current.value?.state !== "connected" || current.value.revision !== restoredRevision || current.value.bindingId !== bindingId || !stillActive()) return false;
      await restored.activatePrepared();
      const final = loadChannelRecord(options.dir);
      if (!final.ok || final.value?.state !== "connected" || final.value.revision !== restoredRevision || final.value.bindingId !== bindingId || !stillActive()) return false;
      hub = restored;
      hubReason = undefined;
      surface.attach(restored);
      return true;
    } catch {
      return false;
    } finally {
      if (hub !== restored) {
        await restored.stop().catch(() => undefined);
        if (restoredRevision !== undefined) {
          try { await disconnectChannelRecord(restoredRevision, options.dir); } catch { /* Never overwrite a newer record. */ }
        }
      }
    }
  };

  const startHubNow = async (): Promise<RemoteStartResult> => {
    if (hub !== undefined) {
      return { ok: true };
    }
    let committed = options.experimentalChannelControl === true ? await migrateLegacyChannelRecord(options.dir) : { ok: true as const, value: null };
    if (!committed.ok) return { ok: false, reason: committed.reason };
    if (committed.value?.state === "connected" && committed.value.bot === null) {
      let identity: Awaited<ReturnType<import("./types").BotApi["getMe"]>>;
      try { identity = await (options.api ?? createHttpBotApi({ token: committed.value.token })).getMe(); }
      catch { return { ok: false, reason: "Could not verify the migrated Telegram bot identity." }; }
      const verified = await commitChannelRecord(committed.value.revision, { token: committed.value.token, bot: identity, config: committed.value.config, ...(committed.value.bindingId === undefined ? {} : { bindingId: committed.value.bindingId }) }, options.dir);
      if (!verified.ok) return { ok: false, reason: "Channel changed while verifying the migrated bot; refresh and retry." };
      committed = verified;
    }
    if (committed.value?.state === "disconnected") {
      hubReason = "Telegram is not connected on this machine";
      surface.detach(hubReason);
      return { ok: false, reason: hubReason, notConnected: true };
    }
    const present = readConfigFile(remoteConfigPath(options.dir));
    if (committed.value === null && !present.ok && present.reason === "absent") {
      // Not an error: nothing is connected yet. Stay quiet.
      hubReason = "Telegram is not connected on this machine";
      surface.detach("Telegram is not connected on this machine; connect it from the shell with /channels");
      return { ok: false, reason: hubReason, notConnected: true };
    }
    let started = false;
    let conflictWhileStarting: string | undefined;
    // Read by the poller callback below before it is assigned, so it cannot be a const.
    // eslint-disable-next-line prefer-const
    let mine: RemoteHub | undefined;
    const opened = openRemoteHub({
      ...(committed.value?.state === "connected" ? { committed: { token: committed.value.token, config: committed.value.config }, currentConfig: readCommittedConfig(committed.value.bindingId, committed.value.bot?.id), staged: true } : {}),
      ...(committed.value?.state === "connected" && committed.value.bindingId !== undefined
        ? { dir: path.join(remoteDirPath(options.dir), "channel-state", committed.value.bindingId) }
        : options.dir === undefined ? {} : { dir: options.dir }),
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
      if (committed.value?.state === "connected") {
        const ready = await mine.waitForPollerReady(30_000);
        const current = loadChannelRecord(options.dir);
        if (!ready || !current.ok || current.value?.state !== "connected" || current.value.revision !== committed.value.revision || current.value.bindingId !== committed.value.bindingId) throw new Error("committed channel readiness could not be confirmed");
        await mine.activatePrepared();
      }
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
    ...(options.experimentalChannelControl === true ? { experimentalControl: true } : {}),
    host: {
      dir: options.dir,
      machine,
      hub: () => hub,
      hubReason: () => hubReason,
      startHub: () => exclusive(startHubNow),
      stopHub: (reason) => exclusive(() => stopHubNow(reason)),
      settle: () => exclusive(async () => undefined),
      ...(options.candidateApi !== undefined ? { openCandidate: options.candidateApi } : options.api === undefined ? {} : { openCandidate: () => options.api! }),
      updateConfig: (expectedRevision, patch) => exclusive(async () => {
        const current = loadChannelRecord(options.dir);
        if (!current.ok) return { ok: false, code: "unavailable" as const, reason: current.reason };
        if ((current.value?.revision ?? null) !== expectedRevision) return { ok: false, code: "conflict" as const, reason: "Channel revision changed; refresh and retry." };
        if (current.value?.state !== "connected") return { ok: false, code: "unavailable" as const, reason: "Telegram is not connected." };
        const config = parseRemoteConfig({ ...current.value.config, ...patch });
        if (!config.ok) return { ok: false, code: "invalid" as const, reason: config.reason };
        const record = await commitChannelRecord(expectedRevision, { token: current.value.token, bot: current.value.bot, config: config.value, ...(current.value.bindingId === undefined ? {} : { bindingId: current.value.bindingId }) }, options.dir);
        if (!record.ok) return { ok: false, code: "conflict" as const, reason: record.reason };
        return { ok: true, revision: record.value.revision, config: config.value };
      }),
      channelAction: (action, expectedRevision) => exclusive(async () => {
        const current = loadChannelRecord(options.dir);
        if (!current.ok) return { ok: false, code: "unavailable" as const, reason: current.reason };
        if ((current.value?.revision ?? null) !== expectedRevision) return { ok: false, code: "conflict" as const, reason: "Channel revision changed; refresh and retry." };
        const active = hub;
        if (current.value?.state !== "connected") return { ok: false, code: "unavailable" as const, reason: "Telegram is not connected." };
        if (action === "test") {
          if (active === undefined) return { ok: false, code: "unavailable" as const, reason: "Telegram is not connected." };
          try { await active.sendGeneral(`Keryx test message from ${machine}: Telegram is connected.`); }
          catch { return { ok: false, code: "unavailable" as const, reason: "Telegram did not accept the test message." }; }
          return { ok: true, body: { delivered: true, machine, revision: current.value.revision } };
        }
        if (active !== undefined) {
          if (!surface.canRevokeChannelBindings(active, true)) return { ok: false, code: "unavailable" as const, reason: "A Desktop binding owner is unavailable; disconnect was not started." };
          if (!await active.pauseForCutover()) return { ok: false, code: "unavailable" as const, reason: "Telegram admission could not be paused." };
          if (!await surface.revokeChannelBindings(active, randomUUID(), options.revocationTimeoutMs ?? 5_000, true)) {
            try { await disconnectChannelRecord(expectedRevision, options.dir); } catch { /* A newer record must not be overwritten. */ }
            await stopHubNow("Telegram disconnect could not be confirmed");
            return { ok: false, code: "unavailable" as const, reason: "Disconnect outcome is uncertain; refresh status." };
          }
        }
        const removed = await disconnectChannelRecord(expectedRevision, options.dir);
        if (!removed.ok) {
          if (active !== undefined) await stopHubNow("Telegram disconnect revision changed");
          return { ok: false, code: "conflict" as const, reason: removed.reason };
        }
        surface.detach("Telegram was disconnected");
        if (active === undefined) return { ok: true, body: { deleted: 0, remaining: 0, hubWasRunning: false, revision: removed.value.revision } };
        active.allowCutoverCleanup();
        let result: { deleted: number; remaining: number };
        try { result = await active.deleteAllTopics(); }
        catch { return { ok: false, code: "unavailable" as const, reason: "Channel was disconnected, but topic cleanup could not be confirmed; refresh status." }; }
        finally { await stopHubNow("Telegram was disconnected"); }
        return { ok: true, body: { ...result, hubWasRunning: true, revision: removed.value.revision } };
      }),
      activateCandidate: (candidate) => exclusive(async () => {
        const running = hub;
        if (running !== undefined) {
          const current = loadChannelRecord(options.dir);
          if (!current.ok || current.value?.state !== "connected" || current.value.revision !== candidate.expectedRevision || current.value.bot === null || !candidate.stillOwned()) return { ok: false, reason: "Channel changed during activation." };
          if (current.value.bot.id !== candidate.bot.id) {
            const bindingId = randomBytes(16).toString("hex");
            const stateDir = ensureRemoteDir(options.dir, "channel-state", bindingId);
            const staged = new RemoteHub({ api: candidate.api, config: candidate.config, staged: true, dir: stateDir,
              currentConfig: readCommittedConfig(bindingId, candidate.bot.id),
              ...(options.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: options.pollTimeoutSec }),
              ...(options.pollBackoffMs === undefined ? {} : { pollBackoffMs: options.pollBackoffMs }),
              ...(options.pollSleep === undefined ? {} : { pollSleep: options.pollSleep }),
              deliver: surface.consumer.deliver,
              ...(surface.consumer.deliverCallback === undefined ? {} : { deliverCallback: surface.consumer.deliverCallback }),
              onPollerStatus: (status) => {
                if (status.state !== "conflict") return;
                void exclusive(async () => {
                  if (hub === staged) await stopHubNow(status.reason ?? "another poller owns this bot token");
                });
              },
            });
            let paused = false;
            let revocationAttempted = false;
            let committedRevision: number | undefined;
            try {
              await staged.start();
              if (!await staged.waitForPollerReady(30_000) || !candidate.stillOwned() || hub !== running) throw new Error("candidate not ready");
              if (!surface.canRevokeChannelBindings(running)) throw new Error("binding owner unavailable");
              paused = await running.pauseForCutover();
              if (!paused || !candidate.stillOwned() || hub !== running) throw new Error("old channel changed");
              revocationAttempted = true;
              const revoked = await surface.revokeChannelBindings(running, randomUUID(), options.revocationTimeoutMs ?? 5_000);
              if (!revoked) throw new Error("revocation unconfirmed");
              await options.afterBindingRevocation?.();
              const committed = await commitChannelRecord(candidate.expectedRevision, { token: candidate.token, bot: candidate.bot, config: candidate.config, bindingId }, options.dir, () => hub === running && candidate.stillOwned());
              if (!committed.ok) throw new Error("revision changed");
              committedRevision = committed.value.revision;
              surface.detach("Telegram channel changed");
              await running.retireCutoverBindings();
              await stopHubNow("Telegram channel changed");
              const beforePublish = loadChannelRecord(options.dir);
              if (!beforePublish.ok || beforePublish.value?.state !== "connected" || beforePublish.value.revision !== committedRevision || beforePublish.value.bindingId !== bindingId || !candidate.stillActive()) throw new Error("channel changed after commit");
              await staged.activatePrepared();
              const final = loadChannelRecord(options.dir);
              if (!final.ok || final.value?.state !== "connected" || final.value.revision !== committedRevision || final.value.bindingId !== bindingId || !candidate.stillActive()) throw new Error("channel changed before publish");
              hub = staged;
              hubReason = undefined;
              surface.attach(staged);
              return { ok: true, revision: committedRevision };
            } catch {
              await staged.stop().catch(() => undefined);
              if (paused && hub === running && !revocationAttempted) {
                const latest = loadChannelRecord(options.dir);
                const mayRecover = latest.ok && latest.value?.state === "connected" && latest.value.revision === candidate.expectedRevision;
                if (mayRecover && await running.recoverCutover(30_000)) surface.attach(running);
                else await stopHubNow("Telegram cutover could not be confirmed");
              } else if (revocationAttempted) {
                if (hub === running) {
                  surface.detach("Telegram channel recovery in progress");
                  await running.retireCutoverBindings().catch(() => undefined);
                  await stopHubNow("Telegram channel recovery in progress");
                }
                const expected = committedRevision ?? candidate.expectedRevision;
                if (expected !== null) await recoverRetiredChannel(current.value, expected, candidate.stillActive);
              }
              return { ok: false, reason: "Channel cutover could not be confirmed; refresh status." };
            }
          }
          const previousConfig = current.value.config;
          const bindingId = current.value.bindingId;
          surface.invalidateTelegramProjections();
          let committedRevision: number | undefined;
          const result = await running.handoffPoller(candidate.api, 30_000, async () => {
            const committed = await commitChannelRecord(candidate.expectedRevision, { token: candidate.token, bot: candidate.bot, config: previousConfig, ...(bindingId === undefined ? {} : { bindingId }) }, options.dir, () => {
              const actual = loadChannelRecord(options.dir);
              return hub === running && candidate.stillOwned() && actual.ok && actual.value?.state === "connected" && actual.value.bot?.id === candidate.bot.id;
            });
            if (!committed.ok) return false;
            committedRevision = committed.value.revision;
            return true;
          });
          if (result.ok && committedRevision !== undefined) {
            surface.attach(running);
            return { ok: true, revision: committedRevision };
          }
          if (!result.ok && result.recovered && hub === running) surface.attach(running);
          else if (hub === running) await stopHubNow("Telegram recovery could not be confirmed");
          return { ok: false, reason: committedRevision === undefined ? "Candidate activation failed." : "Channel outcome is uncertain; refresh its revision." };
        }
        const prior = loadChannelRecord(options.dir);
        const legacy = readConfigFile(remoteConfigPath(options.dir));
        const firstSetup = prior.ok && prior.value === null && candidate.expectedRevision === null && !legacy.ok && legacy.reason === "absent";
        const reconnect = prior.ok && prior.value?.state === "disconnected" && prior.value.revision === candidate.expectedRevision;
        const offlineReplacement = prior.ok && prior.value?.state === "connected" && prior.value.revision === candidate.expectedRevision;
        if ((!firstSetup && !reconnect && !offlineReplacement) || !candidate.stillOwned()) return { ok: false, reason: "The channel changed during setup." };
        const bindingId = randomBytes(16).toString("hex");
        const stateDir = ensureRemoteDir(options.dir, "channel-state", bindingId);
        let committedRevision: number | undefined;
        const staged = new RemoteHub({
          api: candidate.api, config: candidate.config, staged: true,
          currentConfig: readCommittedConfig(bindingId, candidate.bot.id),
          dir: stateDir,
          ...(options.pollTimeoutSec === undefined ? {} : { pollTimeoutSec: options.pollTimeoutSec }),
          ...(options.pollBackoffMs === undefined ? {} : { pollBackoffMs: options.pollBackoffMs }),
          ...(options.pollSleep === undefined ? {} : { pollSleep: options.pollSleep }),
          deliver: surface.consumer.deliver,
          ...(surface.consumer.deliverCallback === undefined ? {} : { deliverCallback: surface.consumer.deliverCallback }),
          onPollerStatus: (status) => {
            if (status.state !== "conflict") return;
            void exclusive(async () => {
              if (hub === staged) await stopHubNow(status.reason ?? "another poller owns this bot token");
            });
          },
        });
        try {
          await staged.start();
          if (!await staged.waitForPollerReady(30_000) || !candidate.stillOwned()) {
            if (offlineReplacement) throw new Error("candidate readiness unavailable");
            await staged.stop();
            return { ok: false, reason: "Candidate poller readiness could not be confirmed." };
          }
          const committed = await commitChannelRecord(candidate.expectedRevision, { token: candidate.token, bot: candidate.bot, config: candidate.config, bindingId }, options.dir, candidate.stillOwned);
          if (!committed.ok) { await staged.stop(); return { ok: false, reason: committed.reason }; }
          committedRevision = committed.value.revision;
          await options.afterCandidateCommit?.();
          const beforeActivation = loadChannelRecord(options.dir);
          if (!beforeActivation.ok || beforeActivation.value?.state !== "connected" || beforeActivation.value.revision !== committedRevision || beforeActivation.value.bindingId !== bindingId || !candidate.stillActive()) throw new Error("channel changed after commit");
          await staged.activatePrepared();
          const beforePublish = loadChannelRecord(options.dir);
          if (!beforePublish.ok || beforePublish.value?.state !== "connected" || beforePublish.value.revision !== committedRevision || beforePublish.value.bindingId !== bindingId || !candidate.stillActive()) throw new Error("channel changed during activation");
          hub = staged;
          hubReason = undefined;
          surface.attach(staged);
          return { ok: true, revision: committed.value.revision };
        } catch {
          await staged.stop().catch(() => undefined);
          if (prior.ok && prior.value?.state === "connected") {
            const expected = committedRevision ?? prior.value.revision;
            if (await recoverRetiredChannel(prior.value, expected, candidate.stillActive)) return { ok: false, reason: "Candidate activation failed; the previous channel recovered with fresh bindings." };
          }
          if (committedRevision !== undefined) {
            try {
              const rollback = await disconnectChannelRecord(committedRevision, options.dir);
              if (!rollback.ok) return { ok: false, reason: "Channel outcome is uncertain; refresh its revision." };
            } catch {
              return { ok: false, reason: "Channel outcome is uncertain; refresh its revision." };
            }
          }
          return { ok: false, reason: "Candidate activation failed." };
        }
      }),
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
      // The previous serve's endpoint goes before the new token exists: a shell reads the token and then the
      // endpoint, so it can never hold the new token while the endpoint still names an old (possibly squatted) port.
      try {
        unlinkSync(endpointPath(options.dir));
      } catch {
        // Nothing left over.
      }
      // Every start rotates the token: whatever an earlier serve handed out stops working here.
      const token = mintShellToken(options.dir);
      if (!token.ok) {
        return refuse(token.reason);
      }
      verifyShellToken = createShellTokenVerifier(token.value);
      shellToken = token.value;
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
