// Shared scaffolding for the src/remote tests: a manual clock that is also the
// hub's timer source, a temp user-global directory, an in-process fake Bot API
// and a recording consumer. Nothing here opens a socket or waits on real time.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_ORPHAN_MS, DEFAULT_RUN_TIMEOUT_MS, type RemoteConfig, REMOTE_CONFIG_SCHEMA_VERSION } from "./config";
import { FakeBotApi } from "./fake-bot-api";
import { type DeliverMeta, type HubTimers, RemoteHub, type RemoteHubOptions } from "./hub";
import { SESSION_LEASE_STALE_MS } from "../session/lease";

export const OWNER_ID = 4242;
export const STRANGER_ID = 666001;
export const FAKE_CHAT_ID = -1001234567890;
export const STALE_MS = SESSION_LEASE_STALE_MS;

interface ScheduledTimer {
  id: number;
  due: number;
  fn: () => void;
  every?: number;
}

/** A clock and a timer source in one: `advance` moves time and fires what is due, in order. */
export class ManualClock implements HubTimers {
  private t: number;
  private seq = 0;
  private timers: ScheduledTimer[] = [];

  constructor(start = 1_800_000_000_000) {
    this.t = start;
  }

  readonly now = (): number => this.t;

  /**
   * Jump the wall clock without firing timers (clock skew). Timers keep their
   * distance from now, as real monotonic timers do, so only `now()` changes.
   */
  set(value: number): void {
    const delta = value - this.t;
    this.t = value;
    for (const timer of this.timers) {
      timer.due += delta;
    }
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, due: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, due: this.t + ms, fn, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /** Advance time, firing every timer that falls due on the way. Lets the event loop breathe between firings. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (next === undefined) {
        break;
      }
      this.t = Math.max(this.t, next.due);
      if (next.every === undefined) {
        this.timers = this.timers.filter((timer) => timer !== next);
      } else {
        next.due += next.every;
      }
      next.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

/** Let promise chains and one macrotask run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function until(check: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function makeRemoteDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-remote-"));
  return dir;
}

export function fileMode(file: string): number {
  return statSync(file).mode & 0o777;
}

/** Every file under `dir`, recursively, as `{ file, text }`. */
export function readTree(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push({ file: full, text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

export function testConfig(overrides: Partial<RemoteConfig> = {}): RemoteConfig {
  return {
    schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION,
    chatId: FAKE_CHAT_ID,
    allowedUserIds: [OWNER_ID],
    orphanMs: DEFAULT_ORPHAN_MS,
    runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    ...overrides,
  };
}

export interface Delivery {
  sessionId: string;
  line: string;
  meta: DeliverMeta;
}

export interface HarnessOptions {
  config?: Partial<RemoteConfig>;
  dir?: string;
  clock?: ManualClock;
  api?: FakeBotApi;
}

export interface Harness {
  dir: string;
  clock: ManualClock;
  api: FakeBotApi;
  config: RemoteConfig;
  deliveries: Delivery[];
  sleeps: number[];
  /** While true, the consumer rejects every delivery. */
  refuseDeliveries: boolean;
  hubs: RemoteHub[];
  /** A hub over this harness's directory, API and clock. Tracked for cleanup. */
  makeHub(overrides?: Partial<RemoteHubOptions>): RemoteHub;
  cleanup(): Promise<void>;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = options.dir ?? makeRemoteDir();
  const clock = options.clock ?? new ManualClock();
  const api = options.api ?? new FakeBotApi({ now: clock.now });
  const config = testConfig(options.config);
  const harness: Harness = {
    dir,
    clock,
    api,
    config,
    deliveries: [],
    sleeps: [],
    refuseDeliveries: false,
    hubs: [],
    makeHub(overrides = {}) {
      const hub = new RemoteHub({
        api,
        config,
        dir,
        now: clock.now,
        timers: clock,
        deliver: async (sessionId, line, meta) => {
          if (harness.refuseDeliveries) {
            throw new Error("consumer is not accepting input");
          }
          harness.deliveries.push({ sessionId, line, meta });
        },
        pollSleep: async (ms) => {
          harness.sleeps.push(ms);
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        },
        pollTimeoutSec: 1,
        ...overrides,
      });
      harness.hubs.push(hub);
      return hub;
    },
    async cleanup() {
      for (const hub of harness.hubs) {
        await hub.stop();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Write a token file the way an operator would: one line, owner-only. */
export function writeTokenFile(dir: string, token: string, mode = 0o600): string {
  const remote = path.join(dir, "remote");
  mkdirSync(remote, { recursive: true });
  const file = path.join(remote, "bot-token");
  writeFileSync(file, `${token}\n`, { mode });
  return file;
}
