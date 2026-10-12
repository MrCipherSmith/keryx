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
import { loadBotToken, loadRemoteConfig } from "./config";
import { fail, ok } from "./http-surface";
import type { RemoteHub } from "./hub";
import { type OpenPairingResult, Pairing, type PairingOptions } from "./pairing";
import { remoteConfigPath } from "./paths";
import type { ChannelsRendering, ChannelsRoute, TelegramChannelState } from "./protocol";
import { DEFAULT_RENDER_MODE } from "./rendering-mode";

export interface ChannelsHost {
  dir?: string | undefined;
  machine: string;
  hub(): RemoteHub | undefined;
  /** Why the hub is not running, when it is not and something is configured. */
  hubReason(): string | undefined;
  /** (Re)start the hub from the files on disk. */
  startHub(): Promise<{ ok: true } | { ok: false; reason: string }>;
  stopHub(reason: string): Promise<void>;
  /** Resolves once every hub start or stop already in flight has finished. */
  settle(): Promise<void>;
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
  // pair, reload and disconnect run one at a time; any call that changes what the channel is bumps the generation, so work queued or in flight for an older one gives up.
  private generation = 0;
  private pairTickets = 0;
  private latestPair = 0;
  private chain: Promise<unknown> = Promise.resolve();

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
    this.generation += 1;
    await this.dropPairing();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private configured(): boolean {
    const read = readConfigFile(remoteConfigPath(this.host.dir));
    return read.ok || read.reason !== "absent";
  }

  private state(): { state: TelegramChannelState; reason?: string } {
    if (this.host.hub() !== undefined) {
      return { state: "connected" };
    }
    // A pairing that reached `ready` is final but not used up: nothing connected it yet (only an open modal does), so the modal must offer Resume. `reload` consumes it.
    if (this.pairing !== undefined && (!this.pairing.isFinal() || this.pairing.isReady())) {
      return { state: "pairing" };
    }
    if (this.configured()) {
      const reason = this.host.hubReason();
      return { state: "off", ...(reason === undefined ? {} : { reason }) };
    }
    return { state: "not-connected" };
  }

  /** Flow 395: from the running hub when there is one, else the mode saved in the config; nothing when no config exists. */
  private rendering(): ChannelsRendering | undefined {
    const hub = this.host.hub();
    // A hub stand-in without the method (a test double) reports the saved mode like no hub does.
    if (hub !== undefined && typeof hub.renderingStatus === "function") {
      return hub.renderingStatus();
    }
    const config = loadRemoteConfig(this.host.dir);
    return config.ok ? { mode: config.value.rendering ?? DEFAULT_RENDER_MODE } : undefined;
  }

  private status(): Response {
    const { state, reason } = this.state();
    const rendering = this.rendering();
    return ok({
      machine: this.host.machine,
      telegram: {
        state,
        ...(reason === undefined ? {} : { reason }),
        sessions: this.host.hub()?.list().length ?? 0,
        ...(rendering === undefined ? {} : { rendering }),
      },
    });
  }

  private async dropPairing(): Promise<void> {
    const running = this.pairing;
    this.pairing = undefined;
    await running?.cancel();
  }

  private async pair(): Promise<Response> {
    // The generation moves only for a token Telegram accepted: a rejected one must not end a valid start still in flight. Of two valid starts the later one wins.
    const seen = this.generation;
    const ticket = ++this.pairTickets;
    const stale = (): boolean => seen !== this.generation || ticket < this.latestPair;
    const superseded = (): Response => fail(409, "superseded", "Another change to this channel came in while the pairing was starting; start again.");
    const connected = (): Response => fail(409, "already-connected", "Telegram is already connected on this machine; disconnect it first.");
    if (this.host.hub() !== undefined) {
      return connected();
    }
    // Validate the new token before touching the pairing that exists: a mistyped token, or a second shell, must not kill a pairing in progress.
    const api = this.host.openApi();
    if (!api.ok) {
      return fail(422, "no-token", api.reason);
    }
    const opened: OpenPairingResult = await Pairing.prepare({
      api: api.api,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...this.options.pairing,
    });
    if (!opened.ok) {
      return fail(opened.kind === "rejected" ? 422 : 502, opened.kind === "rejected" ? "token-rejected" : "telegram-unreachable", opened.reason);
    }
    if (stale()) {
      return superseded();
    }
    this.latestPair = ticket;
    return this.exclusive(async () => {
      if (stale()) {
        return superseded();
      }
      if (this.host.hub() !== undefined) {
        return connected();
      }
      // Replace the old one only now, and end its poller before the new one starts (one poller per token).
      await this.dropPairing();
      if (stale()) {
        return superseded();
      }
      opened.pairing.begin();
      this.pairing = opened.pairing;
      return ok({ ...opened.pairing.snapshot() });
    });
  }

  private async pairingStatus(): Promise<Response> {
    const current = this.pairing;
    if (current === undefined) {
      return fail(404, "no-pairing", "No pairing is open; start one first.");
    }
    await current.recheck();
    if (this.pairing !== current) {
      return fail(404, "no-pairing", "The pairing was closed while it was being checked; start one again.");
    }
    return ok({ ...current.snapshot() });
  }

  private async cancel(): Promise<Response> {
    this.generation += 1;
    const had = this.pairing !== undefined;
    await this.dropPairing();
    return ok({ cancelled: had });
  }

  private reload(): Promise<Response> {
    this.generation += 1;
    return this.exclusive(async () => {
      // Check the files first: a running hub is only stopped when the new ones can start, so a bad reload leaves the old channel working.
      const config = loadRemoteConfig(this.host.dir);
      const token = loadBotToken(this.host.dir);
      if (!config.ok || !token.ok) {
        // The pairing is left alone too: a second shell holding a stale snapshot must not kill a live pairing with a reload that cannot succeed.
        const reason = !config.ok ? config.reason : !token.ok ? token.reason : "";
        return fail(422, "cannot-connect", this.host.hub() === undefined ? reason : `${reason} The running channel was left as it was.`);
      }
      // Only now is the pairing consumed (connectFinish writes the files first, then reloads), and its poller ends before the hub starts.
      await this.dropPairing();
      if (this.host.hub() !== undefined) {
        await this.host.stopHub("reloading remote control");
      }
      const started = await this.host.startHub();
      if (!started.ok) {
        return fail(422, "cannot-connect", started.reason);
      }
      return ok({ state: "connected" satisfies TelegramChannelState });
    });
  }

  private async test(): Promise<Response> {
    await this.host.settle();
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

  private disconnect(): Promise<Response> {
    this.generation += 1;
    return this.exclusive(async () => {
      await this.dropPairing();
      // A start still in flight would otherwise finish after this and leave a running hub with nothing on disk.
      await this.host.settle();
      const hub = this.host.hub();
      if (hub === undefined) {
        return ok({ deleted: 0, remaining: 0, hubWasRunning: false });
      }
      const result = await hub.deleteAllTopics();
      await this.host.stopHub("Telegram was disconnected");
      return ok({ deleted: result.deleted, remaining: result.remaining, hubWasRunning: true });
    });
  }
}
