// The two credentials of a serve that has remote control, and what each reaches.
//
//   serve bearer  -> every existing route, and NOT `/v1/remote/*` (404)
//   shell token   -> the seven exact `/v1/remote/*` paths, and NOTHING else (404)
//   neither       -> one fixed 401 on every path, behind the existing throttle
//
// Run over real sockets on loopback, plus the one property a loopback socket
// cannot show (a non-loopback peer) through `handleServeRequest` with a stub
// surface. A plain serve (no remote surface) is checked to be unchanged.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultServeConfig } from "../lib/serve-config";
import { issueServeToken, readServeCredential, type ServeCredentialRecord } from "../lib/serve-credential";
import { handleServeRequest, type ServeRemoteSurface } from "../lib/serve-server";
import { AUTH_FAILURE_LIMIT } from "../lib/serve-throttle";
import { remoteRoutePath, REMOTE_ROUTE_METHODS, type RemoteRoute } from "./protocol";
import { call, makeRig, type Rig } from "./remote.http.test-helpers";
import { ensureShellToken } from "./shell-token";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

const REMOTE_ROUTES = Object.keys(REMOTE_ROUTE_METHODS) as RemoteRoute[];

/** Every route a serve bearer reaches, with a method that route accepts. */
const SERVE_ROUTES: { method: string; path: string }[] = [
  { method: "GET", path: "/v1/status" },
  { method: "GET", path: "/v1/projects" },
  { method: "POST", path: "/v1/turns" },
  { method: "GET", path: "/v1/approvals" },
  { method: "POST", path: "/v1/approvals/abc" },
  { method: "GET", path: "/v1/turns/abc" },
  { method: "GET", path: "/v1/turns/abc/events" },
];

describe("the shell token", () => {
  test("opens the remote routes", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const registered = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId: "sess-ts-0001", project: "/work/app", name: "release" });
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({ schemaVersion: "1.0.0", name: "release" });
  });

  test("reaches no route that is not a remote route: every one is a plain 404", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    for (const route of SERVE_ROUTES) {
      const answer = await call(serve.origin, serve.shellToken, route.method, route.path, route.method === "POST" ? {} : undefined);
      expect({ ...route, status: answer.status }).toEqual({ ...route, status: 404 });
      expect(answer.body).toEqual({ error: { code: "not-found", message: "Not found." } });
    }
    // The wrong method on a serve route is not told apart from the route not existing.
    expect((await call(serve.origin, serve.shellToken, "POST", "/v1/status", {})).status).toBe(404);
    expect((await call(serve.origin, serve.shellToken, "GET", "/v1/turns")).status).toBe(404);
  });

  test("cannot be used to climb out of the remote table", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    for (const probe of ["/v1/remote", "/v1/remote/", "/v1/remote/register/extra", "/v1/remote/unknown", "/v1/remote/%2e%2e/status", "/v1/remote/../status", "/v1/remote/constructor", "/v1/remote/__proto__"]) {
      const answer = await call(serve.origin, serve.shellToken, "GET", probe);
      expect({ probe, status: answer.status }).toEqual({ probe, status: 404 });
    }
  });

  test("a wrong method on a remote route is 405 with the allowed method", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    for (const route of REMOTE_ROUTES) {
      const wrong = REMOTE_ROUTE_METHODS[route] === "GET" ? "POST" : "GET";
      const answer = await call(serve.origin, serve.shellToken, wrong, remoteRoutePath(route), wrong === "POST" ? {} : undefined);
      expect({ route, status: answer.status }).toEqual({ route, status: 405 });
      expect(answer.headers.get("allow")).toBe(REMOTE_ROUTE_METHODS[route]);
    }
  });
});

describe("the serve bearer", () => {
  test("opens the existing routes", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    expect((await call(serve.origin, serve.serveToken, "GET", "/v1/status")).status).toBe(200);
    expect((await call(serve.origin, serve.serveToken, "GET", "/v1/approvals")).status).toBe(200);
  });

  test("does not reach the remote routes: 404 on every one, with the right method or a wrong one", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    for (const route of REMOTE_ROUTES) {
      const right = REMOTE_ROUTE_METHODS[route];
      const wrong = right === "GET" ? "POST" : "GET";
      for (const method of [right, wrong]) {
        const answer = await call(serve.origin, serve.serveToken, method, remoteRoutePath(route), method === "POST" ? { sessionId: "sess-ts-0002", project: "/w" } : undefined);
        expect({ route, method, status: answer.status }).toEqual({ route, method, status: 404 });
      }
    }
    // And it did not register anything on the way.
    expect(serve.service.hub()?.list()).toEqual([]);
  });
});

describe("a caller with neither", () => {
  test("gets the same fixed 401 on every path, remote or not, and on a plain serve too", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const paths = [...SERVE_ROUTES.map((route) => route.path), ...REMOTE_ROUTES.map((route) => remoteRoutePath(route)), "/", "/nope"];
    const answers = new Set<string>();
    for (const probe of paths) {
      for (const token of [undefined, "not-the-token", "x".repeat(300)]) {
        const answer = await call(serve.origin, token, "GET", probe);
        if (answer.status === 429) {
          continue;
        }
        expect({ probe, status: answer.status }).toEqual({ probe, status: 401 });
        answers.add(JSON.stringify(answer.body) + answer.headers.get("www-authenticate"));
      }
    }
    expect(answers.size).toBe(1);

    // The same body a serve with no remote control gives.
    const plain = await makeRigWithPlainServe();
    const plainAnswer = await call(plain.origin, undefined, "GET", "/v1/status");
    expect(plainAnswer.status).toBe(401);
    expect([...answers][0]).toBe(JSON.stringify(plainAnswer.body) + plainAnswer.headers.get("www-authenticate"));
  });

  test("is throttled like any other stranger, and a valid shell token is never throttled", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const codes: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT + 2; i += 1) {
      codes.push((await call(serve.origin, "guess", "POST", remoteRoutePath("register"), {})).status);
    }
    expect(codes.at(-1)).toBe(429);
    // Same peer, now throttled: the two real credentials still work.
    expect((await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("heartbeat"), { sessionId: "sess-ts-0003" })).status).toBe(404);
    expect((await call(serve.origin, serve.serveToken, "GET", "/v1/status")).status).toBe(200);
  });

  test("a header that is not a bearer credential does not authenticate", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const response = await fetch(`${serve.origin}${remoteRoutePath("register")}`, {
      method: "POST",
      headers: { authorization: `Basic ${serve.shellToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});

describe("a plain serve (no remote control configured)", () => {
  test("has no remote routes and no second credential", async () => {
    rig = makeRig();
    const serve = await rig.startServe({ remote: false });
    for (const route of REMOTE_ROUTES) {
      const answer = await call(serve.origin, serve.serveToken, REMOTE_ROUTE_METHODS[route], remoteRoutePath(route), REMOTE_ROUTE_METHODS[route] === "POST" ? {} : undefined);
      expect({ route, status: answer.status }).toEqual({ route, status: 404 });
    }
    // A shell token that exists on disk (a serve with remote control wrote it earlier) opens nothing here.
    const minted = ensureShellToken(rig.dir);
    if (!minted.ok) {
      throw new Error(minted.reason);
    }
    for (const probe of [remoteRoutePath("register"), "/v1/status"]) {
      expect({ probe, status: (await call(serve.origin, minted.value, "POST", probe, {})).status }).toEqual({ probe, status: 401 });
    }
    expect((await call(serve.origin, serve.serveToken, "GET", "/v1/status")).status).toBe(200);
  });
});

describe("the shell token is for the same machine", () => {
  let configDir = "";
  let credential: ServeCredentialRecord;
  let token = "";
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "keryx-remote-scope-"));
    mkdirSync(configDir, { recursive: true });
    const issued = issueServeToken(configDir);
    if (!issued.ok) {
      throw new Error("fixture could not issue a token");
    }
    credential = issued.record;
    token = issued.token;
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  const surface = (): ServeRemoteSurface & { handled: number } => {
    const stub = {
      handled: 0,
      verifyShellToken: (presented: string) => presented === "shell-secret",
      handle: async () => {
        stub.handled += 1;
        return new Response("ok");
      },
    };
    return stub;
  };

  function ask(remote: ServeRemoteSurface, peer: string | undefined): Promise<Response> {
    return handleServeRequest(new Request("http://127.0.0.1/v1/remote/register", { method: "POST", headers: { authorization: "Bearer shell-secret" } }), {
      config: defaultServeConfig(credential.id, { port: 0 }),
      resolveCredential: () => readServeCredential(configDir),
      nonLoopback: false,
      boundPort: 1,
      dir: configDir,
      state: () => "listening",
      ...(peer === undefined ? {} : { peer }),
      remote,
    });
  }

  test("from a loopback peer it reaches the surface", async () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const remote = surface();
      expect({ peer, status: (await ask(remote, peer)).status }).toEqual({ peer, status: 200 });
      expect(remote.handled).toBe(1);
    }
  });

  test("from any other peer, or one that cannot be told, it is the fixed 401 and the surface is never reached", async () => {
    for (const peer of ["203.0.113.7", "10.0.0.9", "unknown", "::ffff:10.0.0.9", undefined]) {
      const remote = surface();
      const answer = await ask(remote, peer);
      expect({ peer, status: answer.status }).toEqual({ peer, status: 401 });
      expect(remote.handled).toBe(0);
    }
  });

  test("the serve bearer is judged first: a value that is both is a serve caller", async () => {
    const remote: ServeRemoteSurface = { verifyShellToken: () => true, handle: async () => new Response("remote") };
    const answer = await handleServeRequest(new Request("http://127.0.0.1/v1/remote/register", { method: "POST", headers: { authorization: `Bearer ${token}` } }), {
      config: defaultServeConfig(credential.id, { port: 0 }),
      resolveCredential: () => readServeCredential(configDir),
      nonLoopback: false,
      boundPort: 1,
      dir: configDir,
      state: () => "listening",
      peer: "127.0.0.1",
      remote,
    });
    expect(answer.status).toBe(404);
  });
});

async function makeRigWithPlainServe(): Promise<{ origin: string }> {
  const plain = makeRig();
  const previous = rig;
  const serve = await plain.startServe({ remote: false });
  // Cleaned up with the main rig.
  const original = previous?.cleanup.bind(previous);
  if (previous !== undefined && original !== undefined) {
    previous.cleanup = async () => {
      await plain.cleanup();
      await original();
    };
  }
  return { origin: serve.origin };
}
