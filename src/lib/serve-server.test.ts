// The `keryx serve` listener (flow 128 / roadmap R4b).
//
// Written BEFORE src/lib/serve-server.ts exists. The first run must fail with
// "Cannot find module ./serve-server".
//
// Every test that binds uses `port: 0` and reads back the assigned port. NOT
// because bun runs test files in parallel — measured, it does not; it runs them
// sequentially in one process — but because a fixed port collides with whatever
// else is on the developer's machine and with a second CI job on the same
// runner, and because the failure it produces is an unrelated EADDRINUSE.
//
// The single shared process is why the command-level suites must restore
// `console.*`, `XDG_DATA_HOME`, `APPDATA` and `process.exitCode`.
//
// The refusal tests do not read a log line. `refused` means no socket was ever
// bound, and the only honest way to assert that is to try to connect to the
// address the configuration named.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { compareProfiles, localBaselineProfile, resolveLocalProfile } from "../harness/policy/profiles";
// The SHARED stripper and tree walk. The guard below used to carry its own,
// which stripped comments but not string literals — so a mention of the seam
// inside a string would have been reported as a caller supplying it.
import { code, sourceFiles, treeSources } from "./config-dir.scan";
import { hasSecretShapedField, registerProject } from "./project-registry";
import { defaultServeConfig, type ServeConfig } from "./serve-config";
import {
  issueServeToken,
  readServeCredential,
  revokeServeToken,
  rotateServeToken,
  type ServeCredentialRecord,
  type ServeCredentialResult,
} from "./serve-credential";
import {
  describeServeStatus,
  handleServeRequest,
  resolveServeStartup,
  startServeListener,
  type ServeListener,
} from "./serve-server";

/** The source tree both guards in this file scan. */
const SRC_ROOT = path.join(import.meta.dir, "..");

let configDir = "";
let workspace = "";
let token = "";
let credential: ServeCredentialRecord;
let listeners: ServeListener[] = [];

/** An ephemeral-port configuration; 0 lets the OS choose. */
function ephemeralConfig(overrides: Parameters<typeof defaultServeConfig>[1] = {}): ServeConfig {
  return defaultServeConfig(credential.id, { port: 0, ...overrides });
}

function credentialResult(): ServeCredentialResult {
  return { status: "ok", record: credential };
}

function context(config: ServeConfig, state: () => ReturnType<ServeListener["state"]> = () => "listening") {
  return {
    config,
    // The real listener re-reads the store per request; so does this, so the
    // synthetic context cannot drift from the one the server builds.
    resolveCredential: () => readServeCredential(configDir),
    nonLoopback: false,
    boundPort: 12345,
    dir: configDir,
    state,
  };
}

function authed(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

/** The port a fixture server actually bound; fails loudly rather than defaulting. */
function boundPortOf(server: { port?: number | null | undefined }): number {
  const port = server.port;
  if (typeof port !== "number" || port <= 0) {
    throw new Error("fixture server reported no bound port");
  }
  return port;
}

/** True when something accepts a TCP connection on `port`. */
async function isListening(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {}, open() {}, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** path -> "size:mtimeMs", for every file under `root`. */
function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const stats = statSync(full);
        result[full] = `${stats.size}:${stats.mtimeMs}`;
      }
    }
  };
  walk(root);
  return result;
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-serve-server-"));
  configDir = path.join(base, "config");
  workspace = path.join(base, "work");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const issued = issueServeToken(configDir);
  if (!issued.ok) {
    throw new Error("fixture credential could not be issued");
  }
  token = issued.token;
  credential = issued.record;
  listeners = [];
});

afterEach(async () => {
  for (const listener of listeners) {
    await listener.drain();
  }
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

/**
 * A runner that refuses everything, for the tests that are not about turns.
 *
 * `makeSubmitTurn` is required rather than optional, which is the fix for the
 * blocker where production simply never set it. These suites are about startup
 * and the read routes, so they supply a runner that starts nothing — an honest
 * stand-in, and one that would fail loudly if a test here ever began depending
 * on a turn actually running.
 */
const REFUSES_EVERY_TURN = () => async () => ({ kind: "rejected" }) as const;

async function start(config: ServeConfig | null, cred: ServeCredentialResult = credentialResult()) {
  const outcome = await startServeListener({
    config,
    credential: cred,
    dir: configDir,
    makeSubmitTurn: REFUSES_EVERY_TURN,
  });
  if (outcome.ok) {
    listeners.push(outcome.listener);
  }
  return outcome;
}

// ---------------------------------------------------------------------------

describe("startup preconditions", () => {
  test("a loopback configuration with a credential resolves", async () => {
    const startup = resolveServeStartup({ config: ephemeralConfig(), credential: credentialResult() });
    expect(startup.ok).toBe(true);
    if (startup.ok) {
      expect(startup.nonLoopback).toBe(false);
    }
  });

  test("no configuration refuses", async () => {
    const startup = resolveServeStartup({ config: null, credential: credentialResult() });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("no-configuration");
      expect(startup.message).toContain("keryx serve config init");
    }
  });

  test("a disabled configuration refuses", async () => {
    const startup = resolveServeStartup({
      config: { ...ephemeralConfig(), enabled: false },
      credential: credentialResult(),
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("disabled");
    }
  });

  test("an absent credential refuses", async () => {
    const startup = resolveServeStartup({ config: ephemeralConfig(), credential: { status: "absent" } });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("no-credential");
      expect(startup.message).toContain("keryx serve token issue");
    }
  });

  test("an unreadable credential refuses, and is reported distinctly from an absent one", async () => {
    const startup = resolveServeStartup({
      config: ephemeralConfig(),
      credential: { status: "unreadable", message: "the serve credential store is unreadable" },
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("unreadable-credential");
    }
  });

  test("a credential the configuration does not reference refuses", async () => {
    // Otherwise a rotate that changed the id would leave the config pointing at
    // a credential that no longer exists while the server happily authenticated
    // with a different one.
    const startup = resolveServeStartup({
      config: defaultServeConfig("some-other-id", { port: 0 }),
      credential: credentialResult(),
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("no-credential");
    }
  });

  test("a configuration naming the OS credential store refuses instead of silently using the file store", async () => {
    // The schema allows the value; nothing in this release implements it. An
    // accepted-and-ignored field is the same shape as a comment describing
    // enforcement no code performs — the operator believes their token is in
    // the OS keychain while it is a hash in a file.
    const base = ephemeralConfig();
    const startup = resolveServeStartup({
      config: { ...base, credentialRef: { store: "os-credential-store", id: credential.id } },
      credential: credentialResult(),
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("unsupported-credential-store");
      expect(startup.message).toContain("auth-json");
    }
  });

  test("a non-loopback bind without acknowledgement refuses", async () => {
    for (const address of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      const startup = resolveServeStartup({
        config: ephemeralConfig({ address }),
        credential: credentialResult(),
      });
      expect(startup.ok).toBe(false);
      if (!startup.ok) {
        expect(startup.reason).toBe("non-loopback-not-acknowledged");
        expect(startup.message).toContain("acknowledge");
      }
    }
  });

  test("a non-loopback bind WITH acknowledgement resolves and is reported as non-loopback", async () => {
    const startup = resolveServeStartup({
      config: ephemeralConfig({ address: "0.0.0.0", acknowledgeNonLoopback: true }),
      credential: credentialResult(),
    });
    expect(startup.ok).toBe(true);
    if (startup.ok) {
      expect(startup.nonLoopback).toBe(true);
    }
  });

  test("acknowledgement on a loopback bind does not make it non-loopback", async () => {
    const startup = resolveServeStartup({
      config: ephemeralConfig({ address: "127.0.0.1", acknowledgeNonLoopback: true }),
      credential: credentialResult(),
    });
    // NOT `expect(startup.ok && startup.nonLoopback).toBe(false)`: that is also
    // satisfied by the startup refusing outright, so a regression that made an
    // acknowledged loopback bind refuse would keep it green.
    expect(startup.ok).toBe(true);
    if (startup.ok) {
      expect(startup.nonLoopback).toBe(false);
    }
  });

  // ── the non-weakening remote profile (spec AC-04) ────────────────────────

  test("the default configuration resolves a profile, and the resolved posture is returned rather than the name", async () => {
    // Not vacuous: every refusal test below means nothing if the happy path
    // never resolves a profile at all.
    const startup = resolveServeStartup({ config: ephemeralConfig(), credential: credentialResult() });
    expect(startup.ok).toBe(true);
    if (startup.ok) {
      expect(startup.profile.profileId).toBe("unattended-untrusted");
      // The stricter-by-default posture, asserted through the startup result —
      // so a configuration that resolved to something laxer fails HERE and not
      // only in the profile module's own suite.
      expect(startup.profile.requiredControls.isolation).toBe("required-fail-closed");
      expect(startup.profile.defaults.network).toBe("deny");
    }
  });

  test("a profile name this release does not implement is a refusal, not a fallback", async () => {
    const startup = resolveServeStartup({
      config: ephemeralConfig({ profile: "hardened" }),
      credential: credentialResult(),
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("unknown-profile");
      // The message names the valid set, so the operator is not left guessing.
      expect(startup.message).toContain("remote-restricted");
    }
  });

  test("a widening remote profile refuses at startup and names the fields that widen", async () => {
    // Every profile this release ships resolves at or below the baseline, so
    // the widening input is produced by TIGHTENING the baseline rather than by
    // inventing a wider remote profile. Same branch, reachable premise.
    const startup = resolveServeStartup({
      config: ephemeralConfig({ profile: "remote-restricted" }),
      credential: credentialResult(),
      localBaseline: () => resolveLocalProfile("read-only-review"),
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("widening-profile");
      // The FIELDS, by value. `remote-restricted` asks where read-only-review
      // denies, on exactly these three.
      expect(startup.message).toContain("defaults.delegate, defaults.shell, defaults.write");
    }
  });

  test("a widening profile binds NO socket", async () => {
    // The point of AC-04. `refused` is "a terminal startup outcome, never a
    // degraded listen", so the assertion is about the socket, not the message.
    const outcome = await startServeListener({
      config: ephemeralConfig({ profile: "remote-restricted" }),
      credential: credentialResult(),
      localBaseline: () => resolveLocalProfile("read-only-review"),
      dir: configDir,
      makeSubmitTurn: REFUSES_EVERY_TURN,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("widening-profile");
      expect(outcome.state).toBe("refused");
    }
    // No listener object exists to drain, because nothing was opened.
    expect(Object.hasOwn(outcome, "listener")).toBe(false);
  });

  test("an unknown profile name also binds no socket", async () => {
    const outcome = await startServeListener({
      config: ephemeralConfig({ profile: "hardened" }),
      credential: credentialResult(),
      dir: configDir,
      makeSubmitTurn: REFUSES_EVERY_TURN,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("unknown-profile");
    }
    expect(Object.hasOwn(outcome, "listener")).toBe(false);
  });

  test("the shell-allow posture is wider than the baseline — the premise, asserted", async () => {
    // If this ever stops being true the widening tests above are still green
    // while proving nothing, because their input would no longer widen.
    expect(compareProfiles(localBaselineProfile(), resolveLocalProfile("monitored-trusted-local"))).toEqual({
      ok: false,
      widened: ["defaults.shell"],
    });
  });

  /**
   * Files that SUPPLY the `localBaseline` seam, as opposed to declaring it.
   *
   * PURE over a `{ path -> source }` map, so the self-checks below drive this
   * function rather than a re-implementation of it. The guard this replaces
   * inlined the walk and re-evaluated its regex on a string literal, so
   * replacing the predicate with "match nothing" would have left it green —
   * and it had no scan-reach assertion and a zero denominator besides.
   *
   * The predicate is one clause, not two. It used to read
   * `/localBaseline\s*:/.test(x) && !/localBaseline\?\s*:/.test(x)`, and the
   * second half was dead: `localBaseline?:` does not match the first pattern in
   * the first place, because `?` is not whitespace. The declaration was already
   * excluded, the stated rationale for the second clause was wrong, and the
   * self-check "proving" it passed for a reason other than the one it named.
   */
  function baselineSuppliers(sources: ReadonlyMap<string, string>): string[] {
    const found: string[] = [];
    for (const [file, raw] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // `code()`, so a mention inside a string literal cannot fake a hit. The
      // previous version stripped comments only.
      if (/localBaseline\s*:/.test(code(raw))) {
        found.push(file);
      }
    }
    return found;
  }

  test("no non-test file supplies the localBaseline seam", () => {
    // `localBaseline` exists so the widening branch has a reachable input under
    // test. It can also LOWER the ceiling a remote profile is held to, which is
    // the one thing this whole check exists to prevent — so production code may
    // not pass it, and that is held by reading the source rather than by the
    // comment on the field.
    expect(baselineSuppliers(treeSources(SRC_ROOT))).toEqual([]);
  });

  test("the scan actually reaches the source tree", () => {
    // Without this the assertion above passes vacuously if the root moves.
    const files = sourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("lib/serve-server.ts");
    expect(files).toContain("commands/serve.ts");
  });

  test("the file that DECLARES the seam is in the scan and is not reported", () => {
    // The numerator control. An empty complement means nothing unless the one
    // file that mentions `localBaseline` at all was actually read — and it must
    // be read and NOT reported, because declaring the seam is not supplying it.
    const tree = treeSources(SRC_ROOT);
    const mentions = [...tree]
      .filter(([, raw]) => code(raw).includes("localBaseline"))
      .map(([file]) => file)
      .sort();
    // Two files name it: the one that DECLARES the seam, and the one that
    // exports `localBaselineProfile` — a different identifier that happens to
    // share the prefix. Both are read, and neither supplies the seam.
    expect(mentions).toEqual(["harness/policy/profiles.ts", "lib/serve-server.ts"]);
    expect(baselineSuppliers(tree)).toEqual([]);
  });

  test("the detector fires on a planted caller, through baselineSuppliers() itself", () => {
    // Through the seam. The version this replaces tested the regex against a
    // string, which is not the same thing as testing the function that walks
    // the tree with it.
    const planted = new Map([
      ["probe/supplies.ts", "resolveServeStartup({ config, credential, localBaseline: () => wideOpen() });"],
      ["probe/supplies-spaced.ts", "startServeListener({ localBaseline : lower });"],
    ]);
    expect(baselineSuppliers(planted).sort()).toEqual(["probe/supplies-spaced.ts", "probe/supplies.ts"]);

    // The other half: the declaration, a type-only mention, and a mention
    // inside a string are all NOT suppliers.
    const clean = new Map([
      ["probe/declares.ts", "  localBaseline?: () => PolicyProfile;"],
      ["probe/mentions.ts", "// localBaseline: the seam, named in a comment"],
      ["probe/in-a-string.ts", 'const help = "pass localBaseline: to override";'],
    ]);
    expect(baselineSuppliers(clean)).toEqual([]);
  });

  test("the profile is checked AFTER the refusals that already existed", async () => {
    // A configuration with two faults refuses on the one that was already
    // proven, not on the new one. Both are terminal and neither is unsafe, so
    // this is about not silently changing which instruction an operator is
    // handed — the non-loopback refusal has its own executed instruction.
    const startup = resolveServeStartup({
      config: ephemeralConfig({ address: "10.0.0.5", profile: "hardened" }),
      credential: credentialResult(),
    });
    expect(startup.ok).toBe(false);
    if (!startup.ok) {
      expect(startup.reason).toBe("non-loopback-not-acknowledged");
    }
  });
});

describe("CLI status projection", () => {
  test("nothing configured is stopped", async () => {
    const report = describeServeStatus({ config: null, credential: { status: "absent" } });
    expect(report.state).toBe("stopped");
    expect(report.pendingApprovals).toBe(0);
  });

  test("a configuration with enabled:false is stopped, not refused", async () => {
    const report = describeServeStatus({
      config: { ...ephemeralConfig(), enabled: false },
      credential: credentialResult(),
    });
    expect(report.state).toBe("stopped");
  });

  test("a complete configuration is configured and reports the same fields as the route", async () => {
    const report = describeServeStatus({
      config: ephemeralConfig({ profile: "remote-restricted" }),
      credential: credentialResult(),
    });
    expect(report.state).toBe("configured");
    expect(report.profile).toBe("remote-restricted");
    expect(report.bind?.address).toBe("127.0.0.1");
    expect(report.nonLoopback).toBe(false);
    expect(report.pendingApprovals).toBe(0);
  });

  test("a non-loopback acknowledged bind is reported as non-loopback", async () => {
    const report = describeServeStatus({
      config: ephemeralConfig({ address: "0.0.0.0", acknowledgeNonLoopback: true }),
      credential: credentialResult(),
    });
    expect(report.state).toBe("configured");
    expect(report.nonLoopback).toBe(true);
  });

  test("a failed precondition is refused, with the reason", async () => {
    const report = describeServeStatus({ config: ephemeralConfig(), credential: { status: "absent" } });
    expect(report.state).toBe("refused");
    expect(report.reason).toBe("no-credential");
  });

  test("no status projection contains the token", async () => {
    const report = describeServeStatus({ config: ephemeralConfig(), credential: credentialResult() });
    expect(JSON.stringify(report)).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------

describe("authentication", () => {
  const paths = ["/v1/status", "/v1/projects", "/", "/health", "/v1/turns", "/v1/status/"];

  test("missing, malformed and wrong tokens produce a byte-identical 401", async () => {
    const config = ephemeralConfig();
    const variants = [
      new Request("http://127.0.0.1/v1/status"),
      new Request("http://127.0.0.1/v1/status", { headers: { authorization: "Bearer" } }),
      new Request("http://127.0.0.1/v1/status", { headers: { authorization: "Basic abc" } }),
      new Request("http://127.0.0.1/v1/status", { headers: { authorization: "Bearer " } }),
      new Request("http://127.0.0.1/v1/status", { headers: { authorization: `Bearer wrong-${token}` } }),
      new Request("http://127.0.0.1/v1/status", { headers: { authorization: `Bearer ${token.slice(0, -1)}` } }),
    ];
    const seen = new Set<string>();
    for (const request of variants) {
      const response = await handleServeRequest(request, context(config));
      expect(response.status).toBe(401);
      const body = await response.text();
      seen.add(
        JSON.stringify({
          status: response.status,
          body,
          headers: [...response.headers.entries()].sort(),
        }),
      );
    }
    expect(seen.size).toBe(1);
  });

  test("an unauthenticated request to an unknown path is indistinguishable from one to a known path", async () => {
    const config = ephemeralConfig();
    const shapes = new Set<string>();
    for (const route of paths) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await handleServeRequest(new Request(`http://127.0.0.1${route}`, { method }), context(config));
        // Pinned explicitly. Without it "they all match each other" is also
        // satisfied by them all being 200.
        expect(response.status).toBe(401);
        shapes.add(
          JSON.stringify({
            status: response.status,
            body: await response.text(),
            headers: [...response.headers.entries()].sort(),
          }),
        );
      }
    }
    expect(shapes.size).toBe(1);
  });

  test("the 401 body discloses nothing about configuration, projects or sessions", async () => {
    registerProject(makeProject("alpha"), { dir: configDir });
    const config = ephemeralConfig({ profile: "a-very-distinctive-profile-name" });
    // Positive control FIRST. `unauthorized()` returns a byte-constant, so the
    // absence loop below cannot fail on its own — it would pass even if the
    // fixture had registered nothing and the profile name had not taken. This
    // proves those values really are reachable through this surface when the
    // caller IS authenticated, which is what makes their absence meaningful.
    const authorized = await (await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(config))).text();
    expect(authorized).toContain("alpha");
    const authorizedStatus = await (await handleServeRequest(authed("http://127.0.0.1/v1/status"), context(config))).text();
    expect(authorizedStatus).toContain("a-very-distinctive-profile-name");

    const response = await handleServeRequest(new Request("http://127.0.0.1/v1/projects"), context(config));
    const body = await response.text();
    for (const leak of [token, credential.id, credential.hash, credential.salt, "a-very-distinctive-profile-name", "alpha", workspace, configDir]) {
      expect(body).not.toContain(leak);
    }
    expect(JSON.parse(body)).toEqual({ error: { code: "unauthorized", message: "Unauthorized." } });
  });

  test("a correct token is accepted", async () => {
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/status"), context(ephemeralConfig()));
    expect(response.status).toBe(200);
  });

  test("the scheme is matched case-insensitively, as RFC 7235 requires", async () => {
    // `bearerToken` lowercases the scheme. That was asserted only in the
    // negative direction (a `Basic` header is refused); a lowercase `bearer`
    // must still be ACCEPTED or the leniency is one-way and useless.
    for (const scheme of ["bearer", "Bearer", "BEARER", "BeArEr"]) {
      const response = await handleServeRequest(
        new Request("http://127.0.0.1/v1/status", { headers: { authorization: `${scheme} ${token}` } }),
        context(ephemeralConfig()),
      );
      expect({ scheme, status: response.status }).toEqual({ scheme, status: 200 });
    }
  });
});

describe("the route surface", () => {
  test("the route table is closed; everything outside it is 404 for an authenticated caller", async () => {
    // `/v1/turns` left this list when R4c added it — it is now a real route and
    // answers 405 to a GET, which the method test below pins. Everything here
    // is a path that does NOT exist, including the near-misses that a prefix
    // match would have accepted.
    const config = ephemeralConfig();
    for (const route of [
      "/",
      "/health",
      "/v1",
      "/v1/",
      "/v1/status/",
      "/v1/statusx",
      "/v1/turnsx",
      "/v1/turns/",
      "/v1/turns/not-an-id/events/more",
      "/v1/projects/1",
      "/V1/STATUS",
    ]) {
      const response = await handleServeRequest(authed(`http://127.0.0.1${route}`), context(config));
      expect({ route, status: response.status }).toEqual({ route, status: 404 });
      expect(JSON.parse(await response.text())).toEqual({ error: { code: "not-found", message: "Not found." } });
    }
  });

  test("a non-GET method on a real route is 405 and executes nothing", async () => {
    const config = ephemeralConfig();
    for (const route of ["/v1/status", "/v1/projects"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        const response = await handleServeRequest(authed(`http://127.0.0.1${route}`, { method }), context(config));
        expect({ route, method, status: response.status }).toEqual({ route, method, status: 405 });
        expect(JSON.parse(await response.text())).toEqual({
          error: { code: "method-not-allowed", message: "Method not allowed." },
        });
      }
    }
  });

  test("a draining server accepts no new request", async () => {
    const config = ephemeralConfig();
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/status"), context(config, () => "draining"));
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())).toEqual({
      error: { code: "draining", message: "The server is draining." },
    });
  });
});

describe("GET /v1/status", () => {
  test("reports state, bind, profile, the non-loopback flag and a pending-approval count of 0", async () => {
    const config = ephemeralConfig({ profile: "remote-restricted" });
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/status"), {
      ...context(config),
      nonLoopback: false,
      boundPort: 54321,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe("listening");
    expect(body.profile).toBe("remote-restricted");
    expect(body.bind).toEqual({ address: "127.0.0.1", port: 54321 });
    expect(body.nonLoopback).toBe(false);
    expect(body.pendingApprovals).toBe(0);
  });

  test("reports the bind as non-loopback when it is one", async () => {
    const config = ephemeralConfig({ address: "0.0.0.0", acknowledgeNonLoopback: true });
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/status"), {
      ...context(config),
      nonLoopback: true,
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.nonLoopback).toBe(true);
    expect(body.bind).toEqual({ address: "0.0.0.0", port: 12345 });
  });

  test("never carries the token, the stored hash, the salt or the credential id", async () => {
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/status"), context(ephemeralConfig()));
    const raw = await response.text();
    for (const leak of [token, credential.hash, credential.salt, credential.id]) {
      expect(raw).not.toContain(leak);
    }
  });
});

describe("GET /v1/projects", () => {
  test("returns the R4a registry projection", async () => {
    const alpha = makeProject("alpha");
    const beta = makeProject("beta");
    registerProject(alpha, { dir: configDir });
    registerProject(beta, { dir: configDir });

    const response = await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(ephemeralConfig()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { schemaVersion: number; projects: Array<Record<string, unknown>> };
    expect(body.schemaVersion).toBe(1);
    expect(body.projects.map((entry) => entry.displayName).sort()).toEqual(["alpha", "beta"]);
    expect(body.projects.map((entry) => entry.path).sort()).toEqual([alpha, beta].sort());
    expect(body.projects.every((entry) => entry.state === "active")).toBe(true);
  });

  test("a project whose path disappeared is reported as missing, not dropped", async () => {
    const gone = makeProject("gone");
    registerProject(gone, { dir: configDir });
    rmSync(gone, { recursive: true, force: true });

    const response = await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(ephemeralConfig()));
    const body = (await response.json()) as { projects: Array<Record<string, unknown>> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.state).toBe("missing");
  });

  test("carries addressing only — no credential-shaped field anywhere", async () => {
    registerProject(makeProject("alpha"), { dir: configDir });
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(ephemeralConfig()));
    const body = (await response.json()) as { projects: unknown[] };
    // Pinned first: `hasSecretShapedField` returns false for an empty list, so
    // without this the assertion below would pass having inspected nothing.
    expect(body.projects).toHaveLength(1);
    expect(hasSecretShapedField(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(credential.hash);
  });
});

// ---------------------------------------------------------------------------

describe("the listener", () => {
  test("binds loopback and answers both routes over a real socket", async () => {
    registerProject(makeProject("alpha"), { dir: configDir });
    const outcome = await start(ephemeralConfig());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const { listener } = outcome;
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.state()).toBe("listening");

    const status = await fetch(`http://127.0.0.1:${listener.port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    expect((await status.json() as Record<string, unknown>).bind).toEqual({
      address: "127.0.0.1",
      port: listener.port,
    });

    const projects = await fetch(`http://127.0.0.1:${listener.port}/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(projects.status).toBe(200);
    expect(((await projects.json()) as { projects: unknown[] }).projects).toHaveLength(1);

    const anonymous = await fetch(`http://127.0.0.1:${listener.port}/v1/status`);
    expect(anonymous.status).toBe(401);
  });

  test("404 and 405 hold over a real socket, not only against the handler", async () => {
    // The route surface was asserted only against `handleServeRequest` directly.
    // A real HTTP server sits between the caller and that function and can
    // special-case methods — HEAD in particular — before it is ever reached.
    const outcome = await start(ephemeralConfig());
    if (!outcome.ok) {
      throw new Error("listener did not start");
    }
    const base = `http://127.0.0.1:${outcome.listener.port}`;
    const auth = { authorization: `Bearer ${token}` };

    for (const route of ["/", "/health", "/v1/status/", "/v1/turnsx"]) {
      const response = await fetch(`${base}${route}`, { headers: auth });
      expect({ route, status: response.status }).toEqual({ route, status: 404 });
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await fetch(`${base}/v1/status`, { method, headers: auth });
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
    }
    // HEAD is special: the server suppresses the body, so only the status can
    // be asserted — and it must still be the 405 a GET-only route gives.
    const head = await fetch(`${base}/v1/projects`, { method: "HEAD", headers: auth });
    expect(head.status).toBe(405);
  });

  test("refuses without binding when a precondition fails", async () => {
    // The proof is a connection attempt, not a log line. A port that was never
    // bound refuses the connection; a "refused" that had bound anyway would
    // accept it.
    // A BORROWED ephemeral port: bound, read, released. Not a fixed port, and
    // the residual race — something else grabbing it in the microseconds before
    // the probe — is accepted rather than designed away, because a refusal has
    // no port of its own to report and the alternative is asserting on a log
    // line, which is what this test exists not to do.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
    const borrowed = boundPortOf(probe);
    await probe.stop(true);

    const config = defaultServeConfig(credential.id, { port: borrowed });
    const outcome = await start(config, { status: "absent" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe("no-credential");
    expect(await isListening(borrowed)).toBe(false);
  });

  test("refuses a non-loopback bind without acknowledgement, and binds nothing", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
    const borrowed = boundPortOf(probe);
    await probe.stop(true);

    const outcome = await start(defaultServeConfig(credential.id, { address: "0.0.0.0", port: borrowed }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe("non-loopback-not-acknowledged");
    expect(await isListening(borrowed)).toBe(false);
  });

  test("draining closes the listener and releases the port", async () => {
    const outcome = await start(ephemeralConfig());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const { listener } = outcome;
    const port = listener.port;
    expect(await isListening(port)).toBe(true);

    await listener.drain();
    expect(listener.state()).toBe("stopped");
    expect(await isListening(port)).toBe(false);

    // The port is genuinely released: something else can take it.
    const rebound = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("rebound") });
    try {
      expect(boundPortOf(rebound)).toBe(port);
      const check = await fetch(`http://127.0.0.1:${port}/`);
      expect(await check.text()).toBe("rebound");
    } finally {
      await rebound.stop(true);
    }
  });

  test("an acknowledged non-loopback bind binds, and reports itself as non-loopback", async () => {
    // security-policy.md forbids a fixture from opening a real listener on a
    // non-loopback interface, so this uses `0177.0.0.1`: the classifier refuses
    // it (leading-zero octets are ambiguous, so it fails closed and calls it
    // non-loopback) while the kernel resolves it to 127.0.0.1. The acknowledged
    // bind path is exercised end to end without anything becoming reachable.
    const config = ephemeralConfig({ address: "0177.0.0.1", acknowledgeNonLoopback: true });
    const outcome = await start(config);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const response = await fetch(`http://127.0.0.1:${outcome.listener.port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.nonLoopback).toBe(true);
    expect(body.state).toBe("listening");
  });

  test("a port already in use refuses; it does not silently move to another port", async () => {
    const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupant") });
    try {
      const occupiedPort = boundPortOf(occupied);
      const outcome = await start(defaultServeConfig(credential.id, { port: occupiedPort }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.reason).toBe("bind-failed");
      // The occupant is untouched, and nothing of ours is anywhere else.
      const still = await fetch(`http://127.0.0.1:${occupiedPort}/`);
      expect(await still.text()).toBe("occupant");
    } finally {
      await occupied.stop(true);
    }
  });

  test("a REAL listener reports draining while it is draining", async () => {
    // Not a stubbed `state()`. `state = "draining"` was mutation-checked and
    // found decorative: removing it broke nothing, because no test ever
    // observed the real state machine between the flip and the close.
    const outcome = await start(ephemeralConfig());
    if (!outcome.ok) {
      throw new Error("listener did not start");
    }
    expect(outcome.listener.state()).toBe("listening");
    const draining = outcome.listener.drain();
    // The flip happens synchronously, before the await, which is exactly why
    // the 503 window is empty by construction — see the comment on drain().
    expect(outcome.listener.state()).toBe("draining");
    await draining;
    expect(outcome.listener.state()).toBe("stopped");
  });

  test("draining twice is safe", async () => {
    const outcome = await start(ephemeralConfig());
    if (!outcome.ok) {
      throw new Error("listener did not start");
    }
    await outcome.listener.drain();
    await outcome.listener.drain();
    expect(outcome.listener.state()).toBe("stopped");
  });
});

describe("the credential is resolved per request, not captured at startup", () => {
  // security-policy.md §Authentication: "Revocation takes effect for in-flight
  // requests at the next authenticated boundary, and immediately for new ones",
  // and rotation "does not silently keep both valid".
  //
  // A security review demonstrated the opposite: with the record closed over at
  // startup, `keryx serve token revoke` printed success, the store on disk held
  // `active: null`, and the attacker's token kept returning 200 for the life of
  // the process. Rotation was worse — the old token worked and the new one did
  // not.

  test("revoke locks out a LIVE listener", async () => {
    const outcome = await start(ephemeralConfig());
    if (!outcome.ok) {
      throw new Error("listener did not start");
    }
    const url = `http://127.0.0.1:${outcome.listener.port}/v1/status`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    expect(revokeServeToken(configDir)).toBe("revoked");

    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("rotate invalidates the old token on a LIVE listener and admits the new one", async () => {
    const outcome = await start(ephemeralConfig());
    if (!outcome.ok) {
      throw new Error("listener did not start");
    }
    const url = `http://127.0.0.1:${outcome.listener.port}/v1/status`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    const rotated = rotateServeToken(configDir);
    if (!rotated.ok) {
      throw new Error("rotate failed");
    }

    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${rotated.token}` } })).status).toBe(200);
  });

  test("a store that becomes unreadable denies rather than falling back to the startup credential", async () => {
    // The other direction of the same defect: deleting or corrupting the store
    // must not be a way to keep the last-known-good credential alive, and must
    // not be a way to disable authentication either.
    const outcome = await start(ephemeralConfig());
    if (!outcome.ok) {
      throw new Error("listener did not start");
    }
    const url = `http://127.0.0.1:${outcome.listener.port}/v1/status`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    writeFileSync(path.join(configDir, "serve-credentials.json"), "{not json", "utf8");
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(url)).status).toBe(401);

    rmSync(path.join(configDir, "serve-credentials.json"), { force: true });
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});

describe("the projects route discloses no filesystem path of its own", () => {
  test("a registry warning becomes a bounded code, not the terminal message", async () => {
    // security-policy.md §Data minimization forbids absolute paths in any
    // response. Project paths are addressing and are in the contract; the
    // CONFIG-directory path is not addressing at all, and the R4a warning
    // strings are composed for a terminal and quote it verbatim.
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "projects.json"),
      JSON.stringify({ schemaVersion: 1, projects: [{ path: "/x" }] }),
      "utf8",
    );

    const response = await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(ephemeralConfig()));
    const raw = await response.text();
    expect(raw).not.toContain(configDir);
    expect(raw).not.toContain("projects.json");

    const body = JSON.parse(raw) as { warnings: unknown[] };
    expect(body.warnings).toEqual([{ code: "registry-entries-dropped", count: 1 }]);
  });

  test("a malformed registry is reported as a code with no path", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "projects.json"), "{not json", "utf8");

    const response = await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(ephemeralConfig()));
    const raw = await response.text();
    expect(raw).not.toContain(configDir);
    const body = JSON.parse(raw) as { warnings: unknown[]; projects: unknown[] };
    expect(body.warnings).toEqual([{ code: "registry-unreadable", count: 1 }]);
    expect(body.projects).toEqual([]);
  });

  test("a healthy registry reports no warnings at all", async () => {
    registerProject(makeProject("alpha"), { dir: configDir });
    const response = await handleServeRequest(authed("http://127.0.0.1/v1/projects"), context(ephemeralConfig()));
    const body = (await response.json()) as { warnings: unknown[]; projects: unknown[] };
    expect(body.warnings).toEqual([]);
    expect(body.projects).toHaveLength(1);
  });
});

describe("read-only on disk", () => {
  test("exercising every route writes nothing under .metaproject, flow.json included", async () => {
    const project = makeProject("alpha");
    mkdirSync(path.join(project, ".metaproject", "flows", "001"), { recursive: true });
    writeFileSync(path.join(project, ".metaproject", "flows", "001", "flow.json"), '{"status":"done"}\n', "utf8");
    registerProject(project, { dir: configDir });

    const before = inventory(project);
    expect(Object.keys(before).some((file) => file.endsWith("flow.json"))).toBe(true);

    const config = ephemeralConfig();
    for (const route of ["/v1/status", "/v1/projects", "/v1/unknown"]) {
      for (const method of ["GET", "POST"]) {
        const response = await handleServeRequest(authed(`http://127.0.0.1${route}`, { method }), context(config));
        await response.text();
      }
      (await handleServeRequest(new Request(`http://127.0.0.1${route}`), context(config))).text();
    }

    expect(inventory(project)).toEqual(before);
  });
});

/** A directory that looks like an initialized keryx project. */
function makeProject(name: string): string {
  const root = path.join(workspace, name);
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

describe("the credential reader reports absence and damage distinctly", () => {
  test("absent, ok and unreadable are three different answers", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "keryx-serve-cred-read-"));
    try {
      expect(readServeCredential(empty).status).toBe("absent");
      expect(readServeCredential(configDir).status).toBe("ok");
      writeFileSync(path.join(configDir, "serve-credentials.json"), "{not json", "utf8");
      expect(readServeCredential(configDir).status).toBe("unreadable");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
