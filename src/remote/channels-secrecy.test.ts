// AC5 (flow 377), an invariant: the shell writes `remote/bot-token` and `remote/config.json`
// itself, atomically, owner-only; the bot token appears on no route, no request body, no
// result, no notice, no event, no console line and no file other than the token file.
//
// One full lifecycle runs on a real loopback serve and the fake Bot API, with every byte the
// shell sends and receives recorded, then the whole thing is searched for the secret.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { botTokenPath, remoteConfigPath } from "./paths";
import { CHANNELS_ROUTE_METHODS, channelsRoutePath, type ChannelsRoute } from "./protocol";
import { BOT_TOKEN, connectFully, makeChannelsRig, pairFully, type ChannelsRig } from "./channels.test-helpers";
import { call } from "./remote.http.test-helpers";
import { fileMode, readTree } from "./remote.test-helpers";

const SECRET_HALF = BOT_TOKEN.slice(BOT_TOKEN.indexOf(":") + 1);

interface Wire {
  method: string;
  url: string;
  requestBody: string;
  responseText: string;
}

let r: ChannelsRig | undefined;
const consoleLines: string[] = [];
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

afterEach(async () => {
  Object.assign(console, originals);
  consoleLines.length = 0;
  await r?.rig.cleanup();
  r = undefined;
});

function captureConsole(): void {
  const grab =
    () =>
    (...args: unknown[]): void => {
      consoleLines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  Object.assign(console, { log: grab(), info: grab(), warn: grab(), error: grab(), debug: grab() });
}

function recordingFetch(wire: Wire[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    wire.push({
      method: String(init?.method ?? "GET"),
      url: String(input),
      requestBody: typeof init?.body === "string" ? init.body : "",
      responseText: await response.clone().text(),
    });
    return response;
  }) as typeof fetch;
}

function leaks(text: string): boolean {
  return text.includes(BOT_TOKEN) || text.includes(SECRET_HALF);
}

/** Every file under the user-global dir, except the token file itself, must be free of the secret. */
function filesHoldingTheSecret(dir: string): string[] {
  return readTree(dir)
    .filter((entry) => leaks(entry.text))
    .map((entry) => path.relative(dir, entry.file));
}

describe("the bot token's only home is remote/bot-token", () => {
  test("typed once, written by the shell: owner-only, atomic, alone on disk, absent from the config", async () => {
    r = await makeChannelsRig();
    const started = await r.client.startPairing(BOT_TOKEN);
    expect(started.ok).toBe(true);

    const tokenFile = botTokenPath(r.rig.dir);
    expect(fileMode(tokenFile)).toBe(0o600);
    expect(readTree(r.rig.dir).find((entry) => entry.file === tokenFile)?.text.trim()).toBe(BOT_TOKEN);
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual(["remote/bot-token"]);
    // Atomic: no half-written sibling is left behind.
    expect(readTree(path.dirname(tokenFile)).map((entry) => path.basename(entry.file)).filter((name) => name.includes("tmp"))).toEqual([]);

    await connectFully(r);
    const config = remoteConfigPath(r.rig.dir);
    expect(fileMode(config)).toBe(0o600);
    expect(fileMode(tokenFile)).toBe(0o600);
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual(["remote/bot-token"]);
  });

  test("a whole lifecycle leaves the secret off every request, response, result, notice, event and console line", async () => {
    const wire: Wire[] = [];
    r = await makeChannelsRig({ client: { fetchImpl: recordingFetch(wire) } });
    captureConsole();
    const results: unknown[] = [];

    results.push(await r.client.status());
    results.push(await r.client.startPairing(BOT_TOKEN));
    const ready = await pairFully(r);
    results.push(ready);
    results.push(await r.client.connectFinish({ userId: ready.userId as number, chatId: ready.chatId as number }));
    results.push(await r.client.status());
    results.push(await r.client.test());
    results.push(await r.client.disconnect());
    results.push(await r.client.status());
    Object.assign(console, originals);

    expect(wire.length).toBeGreaterThan(6);
    for (const exchange of wire) {
      expect(leaks(exchange.url)).toBe(false);
      expect(leaks(exchange.requestBody)).toBe(false);
      expect(leaks(exchange.responseText)).toBe(false);
    }
    expect(leaks(JSON.stringify(results))).toBe(false);
    expect(leaks(r.rig.notices.join("\n"))).toBe(false);
    expect(leaks(JSON.stringify(r.rig.events))).toBe(false);
    expect(leaks(consoleLines.join("\n"))).toBe(false);
    // And, with Telegram disconnected, nowhere on disk either.
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual([]);
  });

  test("while connected, the secret is on disk in exactly one place", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual(["remote/bot-token"]);
    expect(fileMode(botTokenPath(r.rig.dir))).toBe(0o600);
    expect(fileMode(remoteConfigPath(r.rig.dir))).toBe(0o600);
  });
});

describe("a token that is refused is never echoed and leaves nothing behind", () => {
  test("a string that is not shaped like a bot token is refused locally, without echoing it", async () => {
    r = await makeChannelsRig();
    const attempt = "12345:short_secret_x";
    const result = await r.client.startPairing(attempt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid");
      expect(result.reason).not.toContain("short_secret_x");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual([]);
  });

  test("a token Telegram rejects is refused with a reason that omits it, and the file is not kept", async () => {
    r = await makeChannelsRig();
    r.rig.api.setTokenRejected(true);
    const result = await r.client.startPairing(BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("token-rejected");
      expect(leaks(result.reason)).toBe(false);
    }
    expect(r.client.localFiles().tokenFile).toBe(false);
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual([]);
  });
});

describe("serve never takes the token from a request", () => {
  test("a token put in a request body is neither used, echoed nor written", async () => {
    r = await makeChannelsRig();
    const sneaky = await call(r.serve.origin, r.serve.shellToken, "POST", channelsRoutePath("channels-pair"), { token: BOT_TOKEN, botToken: BOT_TOKEN });
    expect(leaks(JSON.stringify(sneaky.body))).toBe(false);
    expect(r.client.localFiles().tokenFile).toBe(false);
    expect(filesHoldingTheSecret(r.rig.dir)).toEqual([]);
  });

  test("no channels route answers with the token, whatever its state", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const routes = Object.keys(CHANNELS_ROUTE_METHODS) as ChannelsRoute[];
    for (const route of routes) {
      const method = CHANNELS_ROUTE_METHODS[route];
      const answer = await call(r.serve.origin, r.serve.shellToken, method, channelsRoutePath(route), method === "POST" ? {} : undefined);
      expect(leaks(JSON.stringify(answer.body))).toBe(false);
    }
  });

  test("the serve bearer does not open the channels plane: only the local shell token does", async () => {
    r = await makeChannelsRig();
    const answer = await call(r.serve.origin, r.serve.serveToken, "GET", channelsRoutePath("channels-status"));
    expect([401, 404]).toContain(answer.status);
    expect(JSON.stringify(answer.body)).not.toContain("delivered");
  });
});
