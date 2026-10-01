// The single getUpdates loop (flow 376, AC5).
//
// Telegram allows ONE long-poll consumer per bot token and answers a second one
// with 409 Conflict. So exactly one `keryx serve` may poll a token, and a serve
// that learns it is not that one must stop and say why, rather than retry and
// fight the owner for updates. A 409 here is therefore terminal: the poller
// goes to state `conflict`, makes no further call, and exposes a reason that
// names the conflict (never the token).
//
// The loop only moves data: it asks for updates, hands them to the sink and, once
// the sink has made them durable, asks again with an offset that confirms them to
// Telegram. All persistence is the sink's job.
//
// The offset is never a stored number. `update_id` is not a monotonic key we may
// trust across time: Telegram can restart its numbering (a reset of the bot's
// update queue), and a persisted high-water mark would then make a healthy bot
// look dead, silently dropping every message. So the first call after a start
// carries NO offset (Telegram re-serves whatever it has not yet been told we hold,
// and the sink drops repeats by exact id), and an offset is sent only to confirm a
// batch the sink has just accepted.

import { redactSensitiveText } from "../security/service";
import { type BotApi, type BotUpdate, isBotApiError } from "./types";

export interface UpdateSink {
  /** Persist the updates. Throw to have them re-served. A repeat of an id already held must be dropped by the sink. */
  accept(updates: BotUpdate[]): Promise<void>;
}

export type PollerStateName = "idle" | "running" | "stopped" | "conflict";

export interface PollerStatus {
  state: PollerStateName;
  /** Why the poller is not running (conflict) or why the last cycle failed. */
  reason?: string;
}

export const POLLER_CONFLICT_REASON =
  "another getUpdates poller already owns this bot token (HTTP 409 Conflict); only one `keryx serve` may poll a token, so this one will not poll. Stop the other instance or use a different bot.";

const SHORT_POLL_PAUSE_MS = 1_000;

export interface UpdatePollerOptions {
  api: BotApi;
  sink: UpdateSink;
  /** Long-poll seconds per call. Default 25. */
  timeoutSec?: number;
  /** Abortable sleep. Injectable so tests never wait on a real clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Delays between retries after a failed cycle; the last one repeats. */
  backoffMs?: number[];
  /** Called when the status changes. */
  onStatus?: (status: PollerStatus) => void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class UpdatePoller {
  private readonly api: BotApi;
  private readonly sink: UpdateSink;
  private readonly timeoutSec: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly backoffMs: number[];
  private readonly onStatus: (status: PollerStatus) => void;
  private current: PollerStatus = { state: "idle" };
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: UpdatePollerOptions) {
    this.api = options.api;
    this.sink = options.sink;
    this.timeoutSec = options.timeoutSec ?? 25;
    this.sleep = options.sleep ?? defaultSleep;
    this.backoffMs = options.backoffMs !== undefined && options.backoffMs.length > 0 ? options.backoffMs : [1_000, 2_000, 5_000, 15_000, 30_000];
    this.onStatus = options.onStatus ?? (() => undefined);
  }

  status(): PollerStatus {
    return { ...this.current };
  }

  /** Begin polling. A poller that stopped on conflict stays stopped. */
  start(): void {
    if (this.loop !== undefined || this.current.state === "conflict") {
      return;
    }
    this.controller = new AbortController();
    this.set({ state: "running" });
    this.loop = this.run(this.controller.signal);
  }

  /** Stop and wait for the loop to end. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    this.loop = undefined;
    if (this.current.state === "running") {
      this.set({ state: "stopped" });
    }
  }

  /** Resolves when the loop has ended on its own (conflict) or by `stop`. */
  async whenStopped(): Promise<void> {
    await this.loop;
  }

  private set(status: PollerStatus): void {
    this.current = status;
    this.onStatus({ ...status });
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    // The offset that confirms the batch the sink last accepted; set only for the next call.
    let confirm: number | undefined;
    while (!signal.aborted) {
      let updates: BotUpdate[];
      try {
        updates = await this.api.getUpdates({
          ...(confirm === undefined ? {} : { offset: confirm }),
          timeoutSec: this.timeoutSec,
          signal,
        });
        // That call carried the confirmation (or had none to carry).
        confirm = undefined;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (isBotApiError(error) && error.kind === "conflict") {
          this.set({ state: "conflict", reason: POLLER_CONFLICT_REASON });
          return;
        }
        if (isBotApiError(error) && error.kind === "rate-limited") {
          await this.sleep(Math.max(1, error.retryAfterSec ?? 1) * 1000, signal);
          continue;
        }
        failures += 1;
        this.set({ state: "running", reason: describe(error) });
        await this.sleep(this.backoffMs[Math.min(failures, this.backoffMs.length) - 1] ?? 1_000, signal);
        continue;
      }
      if (updates.length === 0) {
        failures = 0;
        if (this.timeoutSec <= 0) {
          // A short poll answers at once: without a pause this would spin.
          await this.sleep(SHORT_POLL_PAUSE_MS, signal);
        }
        continue;
      }
      try {
        await this.sink.accept(updates);
        confirm = Math.max(...updates.map((update) => update.update_id)) + 1;
        failures = 0;
        if (this.current.reason !== undefined) {
          this.set({ state: "running" });
        }
      } catch (error) {
        // Not persisted, so they are not confirmed: Telegram serves them again.
        failures += 1;
        this.set({ state: "running", reason: describe(error) });
        await this.sleep(this.backoffMs[Math.min(failures, this.backoffMs.length) - 1] ?? 1_000, signal);
      }
    }
  }
}

function describe(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
