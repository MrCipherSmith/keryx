// The channels controller inside `keryx serve` (flow 377).
//
// What the shell's /channels modal talks to. It answers the `channels-*` routes of
// the loopback shell-token plane and owns the two things that exist only while a
// channel is being connected or torn down: a pairing, and the call that deletes
// every topic.
//
// The bot token never reaches this file over HTTP. The shell wrote it (and, after a
// pairing, the config) to the user-global directory itself; `host.openApi` reads it
// from there, exactly as the hub does. Responses carry no secret: a state, a
// pairing code, ids, a machine name and plain-language reasons.

import { redactSensitiveText } from "../security/service";
import { readConfigFile } from "../lib/config-dir";
import type { OpenBotApiResult } from "./bootstrap";
import { fail, ok } from "./http-surface";
import type { RemoteHub } from "./hub";
import { type OpenPairingResult, Pairing, type PairingOptions } from "./pairing";
import { remoteConfigPath } from "./paths";
import type { ChannelsRoute, TelegramChannelState } from "./protocol";

export interface ChannelsHost {
  dir?: string | undefined;
  machine: string;
  hub(): RemoteHub | undefined;
  /** Why the hub is not running, when it is not and something is configured. */
  hubReason(): string | undefined;
  /** (Re)start the hub from the files on disk. */
  startHub(): Promise<{ ok: true } | { ok: false; reason: string }>;
  stopHub(reason: string): Promise<void>;
  openApi(): OpenBotApiResult;
}

export interface ChannelsOptions {
  host: ChannelsHost;
  now?: () => number;
  pairing?: Pick<PairingOptions, "ttlMs" | "code" | "timers" | "pollTimeoutSec" | "pollBackoffMs" | "pollSleep">;
}

function describe(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export class ChannelsController {
  private pairing: Pairing | undefined;

  constructor(private readonly options: ChannelsOptions) {}

  private get host(): ChannelsHost {
    return this.options.host;
  }

  handle(route: ChannelsRoute, _request: Request): Promise<Response> {
    switch (route) {
      case "channels-status":
        return Promise.resolve(this.status());
      case "channels-pair":
        return this.pair();
      case "channels-pairing":
        return this.pairingStatus();
      case "channels-cancel":
        return this.cancel();
      case "channels-reload":
        return this.reload();
      case "channels-test":
        return this.test();
      case "channels-disconnect":
        return this.disconnect();
    }
  }

  /** Serve is stopping: nothing may keep polling. */
  async stop(): Promise<void> {
    await this.dropPairing();
  }

  private configured(): boolean {
    const read = readConfigFile(remoteConfigPath(this.host.dir));
    return read.ok || read.reason !== "absent";
  }

  private state(): { state: TelegramChannelState; reason?: string } {
    if (this.host.hub() !== undefined) {
      return { state: "connected" };
    }
    if (this.pairing !== undefined && !this.pairing.isFinal()) {
      return { state: "pairing" };
    }
    if (this.configured()) {
      const reason = this.host.hubReason();
      return { state: "off", ...(reason === undefined ? {} : { reason }) };
    }
    return { state: "not-connected" };
  }

  private status(): Response {
    const { state, reason } = this.state();
    return ok({
      machine: this.host.machine,
      telegram: { state, ...(reason === undefined ? {} : { reason }), sessions: this.host.hub()?.list().length ?? 0 },
    });
  }

  private async dropPairing(): Promise<void> {
    const running = this.pairing;
    this.pairing = undefined;
    await running?.cancel();
  }

  private async pair(): Promise<Response> {
    if (this.host.hub() !== undefined) {
      return fail(409, "already-connected", "Telegram is already connected on this machine; disconnect it first.");
    }
    await this.dropPairing();
    const api = this.host.openApi();
    if (!api.ok) {
      return fail(422, "no-token", api.reason);
    }
    const opened: OpenPairingResult = await Pairing.open({
      api: api.api,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...this.options.pairing,
    });
    if (!opened.ok) {
      return fail(opened.kind === "rejected" ? 422 : 502, opened.kind === "rejected" ? "token-rejected" : "telegram-unreachable", opened.reason);
    }
    this.pairing = opened.pairing;
    return ok({ ...opened.pairing.snapshot() });
  }

  private async pairingStatus(): Promise<Response> {
    const current = this.pairing;
    if (current === undefined) {
      return fail(404, "no-pairing", "No pairing is open; start one first.");
    }
    await current.recheck();
    return ok({ ...current.snapshot() });
  }

  private async cancel(): Promise<Response> {
    const had = this.pairing !== undefined;
    await this.dropPairing();
    return ok({ cancelled: had });
  }

  private async reload(): Promise<Response> {
    await this.dropPairing();
    if (this.host.hub() !== undefined) {
      await this.host.stopHub("reloading remote control");
    }
    const started = await this.host.startHub();
    if (!started.ok) {
      return fail(422, "cannot-connect", started.reason);
    }
    return ok({ state: "connected" satisfies TelegramChannelState });
  }

  private async test(): Promise<Response> {
    const hub = this.host.hub();
    if (hub === undefined) {
      const reason = this.host.hubReason();
      return fail(409, "not-connected", reason ?? "Telegram is not connected on this machine.");
    }
    try {
      await hub.sendGeneral(`Keryx test message from ${this.host.machine}: Telegram is connected.`);
    } catch (error) {
      return fail(502, "send-failed", `Telegram did not accept the test message: ${describe(error)}`);
    }
    return ok({ delivered: true, machine: this.host.machine });
  }

  private async disconnect(): Promise<Response> {
    await this.dropPairing();
    const hub = this.host.hub();
    if (hub === undefined) {
      return ok({ deleted: 0, remaining: 0, hubWasRunning: false });
    }
    const result = await hub.deleteAllTopics();
    await this.host.stopHub("Telegram was disconnected");
    return ok({ deleted: result.deleted, remaining: result.remaining, hubWasRunning: true });
  }
}
