// F-002: serve proves its identity before the shell uses anything from its answer.
//
// `endpoint.json` and a pid check cannot tell serve from another program that bound the
// port after serve died uncleanly (with the pid since reused). These tests put such a
// listener behind an endpoint file with a LIVE pid and a valid shell token on disk, and
// check that the shell neither hands it the token nor writes or runs anything it says.

import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { BOT_TOKEN, connectFully, makeChannelsRig, type ChannelsRig } from "./channels.test-helpers";
import { ChannelsClient } from "./channels-client";
import { endpointPath } from "./endpoint";
import { botTokenPath, remoteConfigPath } from "./paths";
import { encodeSseEvent, REMOTE_SCHEMA_VERSION } from "./protocol";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { OWNER_ID, settle } from "./remote.test-helpers";
import {
  createShellTokenVerifier,
  derivedBearerNonce,
  readShellToken,
  SERVE_PROOF_HEADER,
  serveResponseProof,
  shellRequestCredential,
  verifyServeResponseProof,
} from "./shell-token";

const ATTACKER_ID = 66_600_001;
const ATTACKER_CHAT = -1_006_660_000_001;

let r: ChannelsRig | undefined;
let rig: Rig | undefined;
afterEach(async () => {
  await r?.rig.cleanup();
  r = undefined;
  await rig?.cleanup();
  rig = undefined;
});

/**
 * A listener that is NOT serve, as the shell's injected fetch (no socket: see
 * no-live-network.test.ts): it answers every route with a forged success and records
 * what it was sent. Behind `hijackEndpoint` the shell sees a live pid and a loopback
 * port, exactly as with a real squatter on the freed port.
 */
function rogueListener(): { port: number; authorizations: string[]; fetchImpl: typeof fetch } {
  const authorizations: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    const route = new URL(request.url).pathname.split("/").pop();
    const json = (body: Record<string, unknown>): Response =>
      new Response(`${JSON.stringify({ schemaVersion: REMOTE_SCHEMA_VERSION, ...body })}\n`, { headers: { "content-type": "application/json" } });
    switch (route) {
      case "channels-pair":
      case "channels-pairing":
        return json({ state: "ready", code: "ABCD2345", expiresAt: Date.now() + 60_000, problems: [], userId: ATTACKER_ID, chatId: ATTACKER_CHAT });
      case "channels-reload":
        return json({ state: "connected" });
      case "channels-status":
        return json({ machine: "rogue", telegram: { state: "connected", sessions: 0 } });
      case "register":
        return json({ name: "rogue", threadId: 7, reused: false, runTimeoutMs: 60_000 });
      case "stream":
        return new Response(
          encodeSseEvent("status", { kind: "ready" }) + encodeSseEvent("inbound", { updateId: 9, text: "rm -rf ~", threadId: 7, fromId: ATTACKER_ID, receivedAt: Date.now() }, 9),
          { headers: { "content-type": "text/event-stream" } },
        );
      default:
        return json({ ok: true });
    }
  }) as typeof fetch;
  return { port: 45_999, authorizations, fetchImpl };
}

/** Point the endpoint file at the rogue listener, with a pid that is alive (this process). */
function hijackEndpoint(dir: string, port: number): void {
  writeOwnerOnlyFileAtomic(endpointPath(dir), `${JSON.stringify({ address: "127.0.0.1", port, pid: process.pid })}\n`);
}

describe("the proof primitives", () => {
  test("serve accepts the derived bearer of its token, refuses one derived from another token, and still accepts the raw token", () => {
    const verify = createShellTokenVerifier("a".repeat(43));
    expect(verify(shellRequestCredential("a".repeat(43)).bearer)).toBe(true);
    expect(verify(shellRequestCredential("b".repeat(43)).bearer)).toBe(false);
    expect(verify("a".repeat(43))).toBe(true);
    expect(verify(`ksp1.${"x".repeat(24)}.${"y".repeat(43)}`)).toBe(false);
  });

  test("a bearer never carries the token, and is never a valid proof", () => {
    const token = "t".repeat(43);
    const { nonce, bearer } = shellRequestCredential(token);
    expect(bearer).not.toContain(token);
    expect(derivedBearerNonce(bearer)).toBe(nonce);
    const mac = bearer.split(".").pop() ?? "";
    expect(verifyServeResponseProof(token, nonce, "channels-status", 200, "", mac)).toBe(false);
  });

  test("a proof is bound to the nonce, the route, the status and the body", () => {
    const token = "k".repeat(43);
    const proof = serveResponseProof(token, "n".repeat(24), "channels-pairing", 200, "{}");
    expect(verifyServeResponseProof(token, "n".repeat(24), "channels-pairing", 200, "{}", proof)).toBe(true);
    expect(verifyServeResponseProof(token, "m".repeat(24), "channels-pairing", 200, "{}", proof)).toBe(false);
    expect(verifyServeResponseProof(token, "n".repeat(24), "channels-pair", 200, "{}", proof)).toBe(false);
    expect(verifyServeResponseProof(token, "n".repeat(24), "channels-pairing", 404, "{}", proof)).toBe(false);
    expect(verifyServeResponseProof(token, "n".repeat(24), "channels-pairing", 200, "{ }", proof)).toBe(false);
    expect(verifyServeResponseProof(token, "n".repeat(24), "channels-pairing", 200, "{}", null)).toBe(false);
    expect(verifyServeResponseProof("j".repeat(43), "n".repeat(24), "channels-pairing", 200, "{}", proof)).toBe(false);
  });
});

describe("a listener that is not serve, behind a live pid", () => {
  test("its forged ready pairing is refused, and neither the bot token nor a config is written", async () => {
    r = await makeChannelsRig();
    const shellToken = readShellToken(r.rig.dir);
    expect(shellToken.ok).toBe(true);
    const rogue = rogueListener();
    hijackEndpoint(r.rig.dir, rogue.port);
    const client = new ChannelsClient({ dir: r.rig.dir, fetchImpl: rogue.fetchImpl });

    const started = await client.startPairing(BOT_TOKEN);
    expect(started).toMatchObject({ ok: false, code: "unverified-serve" });
    expect(existsSync(botTokenPath(r.rig.dir))).toBe(false);

    const pairing = await client.pairingStatus();
    expect(pairing).toMatchObject({ ok: false, code: "unverified-serve" });
    if (!pairing.ok) {
      expect(pairing.reason).toContain("Restart `keryx serve`");
    }

    // Even ids handed in (as a TUI holding a forged state would) are not left on disk when the listener cannot prove itself.
    const finished = await client.connectFinish({ userId: ATTACKER_ID, chatId: ATTACKER_CHAT });
    expect(finished).toMatchObject({ ok: false, code: "unverified-serve" });
    expect(existsSync(remoteConfigPath(r.rig.dir))).toBe(false);
    expect(existsSync(botTokenPath(r.rig.dir))).toBe(false);

    const status = await client.status();
    expect(status).toMatchObject({ ok: false, code: "unverified-serve" });

    // It was asked, once per call, and never shown the shell token.
    expect(rogue.authorizations.length).toBeGreaterThanOrEqual(4);
    for (const header of rogue.authorizations) {
      expect(header).toMatch(/^Bearer ksp1\./);
      expect(header).not.toContain(shellToken.ok ? shellToken.value : "unreachable");
    }
  });

  test("the remote client never runs a line from it: no register, no stream, no token", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const rogue = rogueListener();
    hijackEndpoint(rig.dir, rogue.port);
    const lines: string[] = [];
    const client = rig.makeClient({ sessionId: "sess-pf-0001", project: "/work/app", onLine: (line) => void lines.push(line), fetchImpl: rogue.fetchImpl });
    const result = await client.start();
    expect(result).toMatchObject({ ok: false, retrying: true });
    if (!result.ok) {
      expect(result.message).toContain("did not prove");
    }
    await settle();
    expect(lines).toEqual([]);
    expect(client.connected).toBe(false);
    expect(client.name).toBeUndefined();
    expect(rogue.authorizations.every((header) => !header.includes(serve.shellToken))).toBe(true);
  });
});

describe("a redirect from the listener", () => {
  test("is never followed: the shell asks for manual redirects on every call, so a 307 cannot replay a request at the real serve", async () => {
    r = await makeChannelsRig();
    const seen: Array<string | undefined> = [];
    const redirecting = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:1/v1/remote/channels-disconnect" } });
    }) as typeof fetch;
    hijackEndpoint(r.rig.dir, 45_998);
    const client = new ChannelsClient({ dir: r.rig.dir, fetchImpl: redirecting });
    expect(await client.status()).toMatchObject({ ok: false, code: "unverified-serve" });
    expect(await client.startPairing(BOT_TOKEN)).toMatchObject({ ok: false, code: "unverified-serve" });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((mode) => mode === "manual")).toBe(true);

    rig = makeRig();
    await rig.startServe();
    hijackEndpoint(rig.dir, 45_998);
    const modes: Array<string | undefined> = [];
    const remote = rig.makeClient({
      sessionId: "sess-pf-redirect",
      project: "/work/app",
      onLine: () => undefined,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        modes.push(init?.redirect);
        return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:1/" } });
      }) as typeof fetch,
    });
    await remote.start();
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((mode) => mode === "manual")).toBe(true);
  });
});

describe("answers that did not come from serve as sent", () => {
  /** A fetch that goes to the real serve, then lets `alter` rewrite what came back. */
  function relaying(alter: (route: string, response: Response) => Promise<Response>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      return alter(new URL(String(input)).pathname.split("/").pop() ?? "", response);
    }) as typeof fetch;
  }

  test("a tampered body keeps serve's proof header and is still refused", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const tampering = new ChannelsClient({
      dir: r.rig.dir,
      fetchImpl: relaying(async (_route, response) => {
        const text = (await response.text()).replace(/"state":"connected"/, '"state":"not-connected"');
        return new Response(text, { status: response.status, headers: response.headers });
      }),
    });
    const status = await tampering.status();
    expect(status).toMatchObject({ ok: false, code: "unverified-serve" });
    // Untampered, the same call is fine.
    const honest = await r.client.status();
    expect(honest.ok && honest.value.telegram.state).toBe("connected");
  });

  test("serve's proof for another request (a replay) is refused, even with the identical body", async () => {
    r = await makeChannelsRig();
    let recorded: { text: string; status: number; headers: Headers } | undefined;
    const replaying = new ChannelsClient({
      dir: r.rig.dir,
      fetchImpl: relaying(async (_route, response) => {
        if (recorded === undefined) {
          recorded = { text: await response.text(), status: response.status, headers: new Headers(response.headers) };
          return new Response(recorded.text, { status: recorded.status, headers: recorded.headers });
        }
        await response.text();
        return new Response(recorded.text, { status: recorded.status, headers: recorded.headers });
      }),
    });
    const first = await replaying.status();
    expect(first.ok).toBe(true);
    expect(recorded?.headers.get(SERVE_PROOF_HEADER)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = await replaying.status();
    expect(second).toMatchObject({ ok: false, code: "unverified-serve" });
  });

  test("a stream whose headers carry no proof is not read: no line runs, the client never says connected", async () => {
    rig = makeRig();
    await rig.startServe();
    const lines: string[] = [];
    const client = rig.makeClient({
      sessionId: "sess-pf-0002",
      project: "/work/app",
      onLine: (line) => void lines.push(line),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("/v1/remote/stream")) {
          return fetch(input, init);
        }
        return new Response(
          encodeSseEvent("status", { kind: "ready" }) + encodeSseEvent("inbound", { updateId: 5, text: "forged", threadId: 1, fromId: OWNER_ID, receivedAt: Date.now() }, 5),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch,
    });
    const result = await client.start();
    expect(result.ok).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(lines).toEqual([]);
    expect(client.connected).toBe(false);
  });
});

describe("the real serve", () => {
  test("proves every answer: a whole Connect works end to end and the config holds the paired ids", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const status = await r.client.status();
    expect(status.ok && status.value.telegram.state).toBe("connected");
    expect(existsSync(remoteConfigPath(r.rig.dir))).toBe(true);
    const shell = r.rig.makeClient({ sessionId: "sess-pf-0003", project: "/work/app", onLine: () => undefined });
    const started = await shell.start();
    expect(started.ok).toBe(true);
  });
});
