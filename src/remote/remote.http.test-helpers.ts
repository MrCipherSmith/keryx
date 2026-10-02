// Scaffolding for the tests that run the shell channel over a REAL socket
// (flow 376, block 2): a real `startServeListener` on 127.0.0.1 port 0, the real
// `RemoteHttpSurface` and hub behind it, the in-process fake Bot API in front of
// Telegram, and the real `RemoteClient` on the other end. The only things
// replaced are the ones that would leave the machine: Telegram, and the turn
// runner (nothing here runs a turn).
//
// Loopback only. Nothing in here names an outside host.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultServeConfig } from "../lib/serve-config";
import { issueServeToken } from "../lib/serve-credential";
import { type ServeListener, startServeListener } from "../lib/serve-server";
import { RemoteClient, type RemoteClientOptions } from "./client";
import { type RemoteConfig, saveRemoteConfig } from "./config";
import { FakeBotApi } from "./fake-bot-api";
import type { RemoteEvent } from "./hub";
import { type OpenRemoteServiceOptions, openRemoteService, type RemoteService } from "./service";
import { readShellToken } from "./shell-token";
import { type ParsedSseFrame, SseParser } from "./protocol";
import type { BotApi } from "./types";
import { FAKE_CHAT_ID, testConfig, until } from "./remote.test-helpers";

export interface ServeInstance {
  origin: string;
  port: number;
  /** The serve bearer: it reaches every route except `/v1/remote/*`. */
  serveToken: string;
  /** The local shell token: it reaches `/v1/remote/*` and nothing else. */
  shellToken: string;
  service: RemoteService;
  listener: ServeListener;
  /** Drain the listener and stop the remote service, as `keryx serve` does on SIGTERM. */
  stop(): Promise<void>;
}

export interface ServeOptions {
  service?: Omit<OpenRemoteServiceOptions, "dir" | "api" | "onNotice">;
  /** Replace the remote service result entirely (a plain serve passes `remote: false`). */
  remote?: boolean;
  /** Another client over the same fake Telegram: a second serve on the same bot token. */
  api?: BotApi;
}

export interface Rig {
  /** The user-global directory this rig's serve and shells share. */
  dir: string;
  api: FakeBotApi;
  notices: string[];
  events: RemoteEvent[];
  serveTokenFor(): string;
  startServe(options?: ServeOptions): Promise<ServeInstance>;
  makeClient(options: Omit<RemoteClientOptions, "dir">): RemoteClient;
  cleanup(): Promise<void>;
}

const FAST_SLEEP = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 1));

export interface RigOptions {
  /** False: no remote config is written, as on a machine where Telegram was never connected. Default true. */
  configured?: boolean;
  /** Fields of the remote config to set (the rest is `testConfig`'s). */
  config?: Partial<RemoteConfig>;
}

export function makeRig(rigOptions: RigOptions = {}): Rig {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-remote-http-")));
  const dir = path.join(base, "config");
  mkdirSync(dir, { recursive: true });
  const issued = issueServeToken(dir);
  if (!issued.ok) {
    throw new Error("fixture could not issue a serve token");
  }
  if (rigOptions.configured !== false) {
    const saved = saveRemoteConfig(testConfig({ chatId: FAKE_CHAT_ID, ...rigOptions.config }), dir);
    if (!saved.ok) {
      throw new Error(`fixture could not save the remote config: ${saved.reason}`);
    }
  }
  const api = new FakeBotApi();
  const notices: string[] = [];
  const events: RemoteEvent[] = [];
  const instances: ServeInstance[] = [];
  const clients: RemoteClient[] = [];

  const rig: Rig = {
    dir,
    api,
    notices,
    events,
    serveTokenFor: () => issued.token,
    async startServe(options = {}) {
      const service = options.remote === false ? undefined : openRemoteService({
        dir,
        api: options.api ?? api,
        pollTimeoutSec: 1,
        pollSleep: FAST_SLEEP,
        deliverRetryMs: 20,
        onNotice: (message) => notices.push(message),
        onEvent: (event) => events.push(event),
        ...options.service,
      });
      const outcome = await startServeListener({
        config: defaultServeConfig(issued.record.id, { port: 0, profile: "remote-read-only" }),
        credential: { status: "ok", record: issued.record },
        dir,
        // No turn runs in these tests; reaching it is a failure of the test, not of the route.
        makeSubmitTurn: () => async () => {
          throw new Error("a turn was submitted in a remote-control test");
        },
        ...(service === undefined ? {} : { remote: service.surface }),
      });
      if (!outcome.ok) {
        throw new Error(`listener refused to start: ${outcome.message}`);
      }
      const listener = outcome.listener;
      if (service !== undefined) {
        // A refusal is not thrown: the listener keeps serving, and the caller reads `notices` and the 503.
        await service.start({ address: listener.address, port: listener.port });
      }
      const shell = readShellToken(dir);
      const instance: ServeInstance = {
        origin: `http://127.0.0.1:${listener.port}`,
        port: listener.port,
        serveToken: issued.token,
        shellToken: shell.ok ? shell.value : "",
        service: service as RemoteService,
        listener,
        async stop() {
          await listener.drain();
          await service?.stop();
        },
      };
      instances.push(instance);
      return instance;
    },
    makeClient(options) {
      const client = new RemoteClient({
        dir,
        heartbeatMs: 60_000,
        backoff: { initialMs: 5, maxMs: 25 },
        ...options,
      });
      clients.push(client);
      return client;
    },
    async cleanup() {
      for (const client of clients) {
        await client.drop();
      }
      for (const instance of instances) {
        await instance.stop();
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
  return rig;
}

/** A raw request to a serve, bearer chosen by the caller. */
export async function call(
  origin: string,
  token: string | undefined,
  method: string,
  pathAndQuery: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${origin}${pathAndQuery}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export interface RawStream {
  frames: ParsedSseFrame[];
  /** Raw text received, comments included. */
  text(): string;
  status: number;
  ended(): boolean;
  close(): void;
}

/** Open `GET /v1/remote/stream` and collect what arrives. */
export async function openRawStream(
  origin: string,
  token: string,
  sessionId: string,
  headers: Record<string, string> = {},
): Promise<RawStream> {
  const abort = new AbortController();
  const response = await fetch(`${origin}/v1/remote/stream?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", ...headers },
    signal: abort.signal,
  });
  const frames: ParsedSseFrame[] = [];
  let raw = "";
  let ended = false;
  if (response.body !== null && response.ok) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;
          frames.push(...parser.push(chunk));
        }
      } catch {
        // Aborted by the test.
      }
      ended = true;
    })();
  } else {
    ended = true;
    raw = await response.text();
  }
  return {
    frames,
    text: () => raw,
    status: response.status,
    ended: () => ended,
    close: () => abort.abort(),
  };
}

export async function untilFrame(stream: RawStream, event: string, what = `a ${event} frame`): Promise<ParsedSseFrame> {
  await until(() => stream.frames.some((frame) => frame.event === event), what);
  return stream.frames.find((frame) => frame.event === event) as ParsedSseFrame;
}
