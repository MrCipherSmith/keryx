// AC9 invariant: the bot token appears nowhere it should not. A recognizable
// fake token is pushed through every code path, failures included, while
// console output, thrown errors, hub events and every file on disk are captured
// and searched for it. The only place it may exist is the token file the
// operator wrote, and that file must be owner-only.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { openRemoteHub } from "./bootstrap";
import { createHttpBotApi } from "./bot-api-http";
import { loadBotToken, saveRemoteConfig } from "./config";
import type { RemoteEvent } from "./hub";
import { botTokenPath } from "./paths";
import { type Harness, makeRemoteDir, makeHarness, OWNER_ID, readTree, STALE_MS, until, writeTokenFile } from "./remote.test-helpers";
import { rmSync } from "node:fs";
import { BotApiError } from "./types";

const SECRET = "SecretSecretSecretSecret_zz9";
const TOKEN = `7123456789:AAH${SECRET}`;
const NEEDLES = [TOKEN, encodeURIComponent(TOKEN), SECRET, `bot${TOKEN}`];

function expectNoToken(text: string, where: string): void {
  for (const needle of NEEDLES) {
    if (text.includes(needle)) {
      throw new Error(`the bot token leaked into ${where}`);
    }
  }
}

interface Capture {
  text(): string;
  restore(): void;
}

function captureOutput(): Capture {
  const out: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      out.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  }
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => out.join("\n"),
    restore() {
      methods.forEach((method, index) => {
        console[method] = saved[index] as never;
      });
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    },
  };
}

/** Everything an error can show a reader. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return [error.name, error.message, error.stack ?? "", String(error), JSON.stringify(error), String((error as { cause?: unknown }).cause ?? "")].join("\n");
}

type Responder = (url: string, method: string) => Response | Error;

/** A stand-in for the network: sees the real URL (token included), returns whatever the test wants. */
function stubFetch(respond: Responder): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    const result = respond(url, url.split("/").pop() ?? "");
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.cleanup();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the token file", () => {
  test("a good file loads and its mode is owner-only", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const file = writeTokenFile(dir, TOKEN);
    const loaded = loadBotToken(dir);
    expect(loaded.ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a file readable by others is refused, the fix is named, the token is not echoed", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const file = writeTokenFile(dir, TOKEN);
    chmodSync(file, 0o644);
    const loaded = loadBotToken(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toContain(`chmod 600 ${file}`);
      expectNoToken(loaded.reason, "the refusal reason");
    }
  });

  test("a group-readable file is refused too", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const file = writeTokenFile(dir, TOKEN);
    chmodSync(file, 0o640);
    expect(loadBotToken(dir).ok).toBe(false);
  });

  test("a missing file and a malformed file are refused without printing contents", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const missing = loadBotToken(dir);
    expect(missing.ok).toBe(false);
    writeTokenFile(dir, `not a token but it holds ${SECRET}`);
    const malformed = loadBotToken(dir);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expectNoToken(malformed.reason, "the malformed-file reason");
      expect(malformed.reason).toContain(botTokenPath(dir));
    }
  });
});

describe("the HTTP client", () => {
  const failures: [string, Responder][] = [
    ["a transport error that carries the URL", (url) => new TypeError(`fetch failed: connect ECONNREFUSED ${url}`)],
    ["a 400 whose description echoes the token", () => json(400, { ok: false, error_code: 400, description: `Bad Request: bad bot${TOKEN}` })],
    ["a 401 echoing the URL-encoded token", () => json(401, { ok: false, error_code: 401, description: `Unauthorized ${encodeURIComponent(TOKEN)}` })],
    ["a 409 conflict", () => json(409, { ok: false, error_code: 409, description: `Conflict: ${TOKEN}` })],
    ["a 429 with retry_after", () => json(429, { ok: false, error_code: 429, description: `Too Many Requests ${TOKEN}`, parameters: { retry_after: 2 } })],
    ["a 502 with an HTML body naming the token", () => new Response(`<html>bot${TOKEN}</html>`, { status: 502 })],
    ["a 200 that is not JSON", () => new Response(`garbage ${TOKEN}`, { status: 200 })],
    ["a 200 with ok false", () => json(200, { ok: false, description: `weird ${TOKEN}` })],
  ];

  for (const [label, respond] of failures) {
    test(`${label}: every error is scrubbed, with no cause`, async () => {
      const capture = captureOutput();
      const errors: string[] = [];
      try {
        const { fetchImpl, urls } = stubFetch(respond);
        const api = createHttpBotApi({ token: TOKEN, baseUrl: "http://bot-api.invalid", fetchImpl });
        const calls: (() => Promise<unknown>)[] = [
          () => api.getUpdates({ offset: 1, timeoutSec: 0 }),
          () => api.sendMessage({ chatId: -1001, text: "hi", messageThreadId: 5 }),
          () => api.createForumTopic({ chatId: -1001, name: "t" }),
          () => api.deleteForumTopic({ chatId: -1001, messageThreadId: 5 }),
          () => api.editForumTopic({ chatId: -1001, messageThreadId: 5, name: "n" }),
          () => api.answerCallbackQuery({ callbackQueryId: "1" }),
        ];
        for (const call of calls) {
          try {
            await call();
          } catch (error) {
            errors.push(describeError(error));
            expect(error).toBeInstanceOf(BotApiError);
            expect((error as { cause?: unknown }).cause).toBeUndefined();
          }
        }
        // The token really does travel in the request: the scrubbing is not vacuous.
        expect(urls.every((url) => url.includes(TOKEN))).toBe(true);
      } finally {
        capture.restore();
      }
      expect(errors.length).toBeGreaterThan(0);
      expectNoToken(errors.join("\n"), `an error (${label})`);
      expectNoToken(capture.text(), "console output");
    });
  }

  test("an aborted long poll surfaces as an abort, with no token", async () => {
    const controller = new AbortController();
    const { fetchImpl } = stubFetch((url) => {
      controller.abort();
      return new TypeError(`aborted ${url}`);
    });
    const api = createHttpBotApi({ token: TOKEN, baseUrl: "http://bot-api.invalid", fetchImpl });
    const error = await api.getUpdates({ timeoutSec: 30, signal: controller.signal }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expectNoToken(describeError(error), "the abort error");
  });

  test("an empty token is refused at construction", () => {
    expect(() => createHttpBotApi({ token: "" })).toThrow("bot token is empty");
  });
});

describe("through the hub, with every API call failing", () => {
  test("results, events, status, console and files are free of the token", async () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const tokenFile = writeTokenFile(dir, TOKEN);
    saveRemoteConfig(
      { schemaVersion: 1, chatId: -1001234567890, allowedUserIds: [OWNER_ID], orphanMs: 60_000, runTimeoutMs: 60_000 },
      dir,
    );

    const h = makeHarness({ dir });
    harnesses.push(h);
    const capture = captureOutput();
    const events: RemoteEvent[] = [];
    const seen: string[] = [];
    try {
      let mode: "down" | "conflict" | "rejected" = "down";
      const { fetchImpl } = stubFetch((url) => {
        if (mode === "down") return new TypeError(`getaddrinfo failed for ${url}`);
        if (mode === "conflict") return json(409, { ok: false, error_code: 409, description: `Conflict ${TOKEN}` });
        return json(400, { ok: false, error_code: 400, description: `Bad Request: ${TOKEN}` });
      });
      const opened = openRemoteHub({
        dir,
        fetchImpl,
        baseUrl: "http://bot-api.invalid",
        now: h.clock.now,
        timers: h.clock,
        deliver: async () => undefined,
        onEvent: (event) => events.push(event),
        pollSleep: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        },
      });
      if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
      const hub = opened.hub;
      h.hubs.push(hub);

      // Register against a dead network, then a rejecting API.
      const down = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
      seen.push(JSON.stringify(down));
      mode = "rejected";
      const rejected = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
      seen.push(JSON.stringify(rejected));

      // Polling fails with network errors, then with a 409.
      mode = "down";
      await hub.start();
      await until(() => hub.events().some((e) => e.type === "poller-status" && /running: /.test(e.detail ?? "")), "poller failure noted");
      mode = "conflict";
      await h.clock.advance(60_000);
      await until(() => hub.pollerStatus().state === "conflict", "conflict");
      seen.push(JSON.stringify(hub.pollerStatus()));
      seen.push(JSON.stringify(hub.events()));
      seen.push(JSON.stringify(hub.list()));
      await h.clock.advance(STALE_MS + 60_000);
      await hub.stop();
    } finally {
      capture.restore();
    }
    seen.push(JSON.stringify(events));
    expectNoToken(seen.join("\n"), "a hub result, event or status");
    expectNoToken(capture.text(), "console output");

    for (const { file, text } of readTree(dir)) {
      if (file === tokenFile) {
        continue;
      }
      expectNoToken(text, `the file ${path.relative(dir, file)}`);
    }
    // The token file is unchanged and still owner-only.
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(TOKEN);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    for (const { file } of readTree(dir)) {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  });

  test("a refused token file surfaces a reason without the token, and no hub", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const file = writeTokenFile(dir, TOKEN);
    saveRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [OWNER_ID], orphanMs: 60_000, runTimeoutMs: 60_000 }, dir);
    chmodSync(file, 0o666);
    const opened = openRemoteHub({ dir, deliver: async () => undefined });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expectNoToken(opened.reason, "the open failure");
      expect(opened.reason).toContain("chmod 600");
    }
  });

  test("the config file is owner-only and holds no token", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    saveRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [OWNER_ID], orphanMs: 60_000, runTimeoutMs: 60_000 }, dir);
    const file = path.join(dir, "remote", "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expectNoToken(readFileSync(file, "utf8"), "the config file");
  });
});
