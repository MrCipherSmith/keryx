import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrcaReporter, parseOrcaEndpoint } from "./orca-report";

const env = {
  KERYX_ORCA_HOOKS: "1", ORCA_AGENT_HOOK_PORT: "32123", ORCA_AGENT_HOOK_TOKEN: "test-token",
  ORCA_PANE_KEY: "pane&1", ORCA_TAB_ID: "tab", ORCA_WORKTREE_ID: "tree",
  ORCA_AGENT_LAUNCH_TOKEN: "launch", ORCA_AGENT_HOOK_ENV: "local", ORCA_AGENT_HOOK_VERSION: "1",
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("off by default, even inside Orca", async () => {
  let calls = 0;
  const reporter = createOrcaReporter({ env: { ...env, KERYX_ORCA_HOOKS: undefined },
    post: async () => { calls++; return new Response(); } });
  reporter.report("working"); await reporter.release(); expect(calls).toBe(0);
});

test("literal endpoint parser never evaluates shell expressions", () => {
  expect(parseOrcaEndpoint("# file\nexport ORCA_AGENT_HOOK_PORT='32123'\nORCA_AGENT_HOOK_TOKEN=abc\n"))
    .toEqual({ ORCA_AGENT_HOOK_PORT: "32123", ORCA_AGENT_HOOK_TOKEN: "abc" });
  for (const text of ["ORCA_AGENT_HOOK_PORT=$(id)", "ORCA_AGENT_HOOK_PORT=`id`",
    'ORCA_AGENT_HOOK_TOKEN="$TOKEN"', "OTHER=evil", "ORCA_AGENT_HOOK_PORT=1\nORCA_AGENT_HOOK_PORT=2"]) {
    expect(() => parseOrcaEndpoint(text)).toThrow();
  }
});

test("authenticated native envelope; loopback only, ordered, deduped, release idempotent", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reporter = createOrcaReporter({ env, post: async (url, init) => {
    requests.push({ url, init }); return new Response();
  } });
  reporter.report("working"); reporter.report("working"); reporter.report("blocked");
  reporter.report("working"); reporter.report("idle"); await tick();
  await Promise.all([reporter.release(), reporter.release()]); reporter.report("working");
  expect(requests).toHaveLength(5);
  const states: string[] = [];
  for (const { url, init } of requests) {
    expect(url).toBe("http://127.0.0.1:32123/hook/keryx");
    expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("X-Orca-Agent-Hook-Token")).toBe("test-token");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ paneKey: "pane&1", tabId: "tab", worktreeId: "tree",
      launchToken: "launch", env: "local", version: "1", payload: body.payload });
    const payload = body.payload; states.push(payload.state);
    expect(payload).toEqual({ event: "keryx_state", protocolVersion: 1, state: payload.state });
    expect(String(init.body)).not.toContain("test-token");
  }
  expect(states).toEqual(["working", "blocked", "working", "idle", "stopped"]);
});

test.each(["0", "65536", "-1", "http://evil.test", "32123/path", "1.5"])("invalid port %s is inert", async port => {
  let calls = 0; let warnings = 0;
  const reporter = createOrcaReporter({ env: { ...env, ORCA_AGENT_HOOK_PORT: port },
    post: async () => { calls++; return new Response(); }, onError: () => { warnings++; } });
  reporter.report("working"); await reporter.release(); expect(calls).toBe(0); expect(warnings).toBe(1);
});

test.each(["ORCA_AGENT_HOOK_TOKEN", "ORCA_PANE_KEY", "ORCA_AGENT_LAUNCH_TOKEN"])("missing %s is inert", async key => {
  let calls = 0;
  const reporter = createOrcaReporter({ env: { ...env, [key]: undefined },
    post: async () => { calls++; return new Response(); } });
  reporter.report("idle"); await reporter.release(); expect(calls).toBe(0);
});

test("endpoint FILE overrides stale env; invalid file never falls back", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orca-report-")); roots.push(root);
  const file = path.join(root, "endpoint");
  writeFileSync(file, "export ORCA_AGENT_HOOK_PORT=32124\nexport ORCA_AGENT_HOOK_TOKEN='file-token'\n");
  const urls: string[] = [];
  const post = async (url: string, init: RequestInit) => {
    urls.push(url); expect(new Headers(init.headers).get("X-Orca-Agent-Hook-Token")).toBe("file-token");
    return new Response();
  };
  await createOrcaReporter({ env: { ...env, ORCA_AGENT_HOOK_ENDPOINT: file }, post }).release();
  expect(urls).toEqual(["http://127.0.0.1:32124/hook/keryx"]);
  for (const invalid of [file + ".missing", root, "https://evil.test/hook"]) {
    await createOrcaReporter({ env: { ...env, ORCA_AGENT_HOOK_ENDPOINT: invalid }, post }).release();
  }
  writeFileSync(file, "x".repeat(16_385));
  await createOrcaReporter({ env: { ...env, ORCA_AGENT_HOOK_ENDPOINT: file }, post }).release();
  expect(urls).toHaveLength(1);
});

test.each([401, 404, 500])("HTTP %s disables delivery without throwing", async status => {
  let calls = 0; let warnings = 0;
  const reporter = createOrcaReporter({ env, post: async () => { calls++; return new Response(null, { status }); },
    onError: () => { warnings++; throw new Error("observer failure"); } });
  reporter.report("working"); reporter.report("blocked"); await tick();
  reporter.report("idle"); await reporter.release(); expect(calls).toBe(1); expect(warnings).toBe(1);
});

test("transport throw is contained", async () => {
  const reporter = createOrcaReporter({ env, post: () => { throw new Error("offline"); } });
  reporter.report("working"); await expect(reporter.release()).resolves.toBeUndefined();
});

test("hung transport is bounded and aborted, including release", async () => {
  let signal: AbortSignal | null | undefined;
  const reporter = createOrcaReporter({ env, post: (_url, init) => {
    signal = init.signal; return new Promise<Response>(() => {});
  } });
  reporter.report("working"); const start = Date.now(); await reporter.release();
  expect(Date.now() - start).toBeLessThan(1500); expect(signal?.aborted).toBe(true);
});

test("backlog is bounded", async () => {
  let finish!: (response: Response) => void; let calls = 0;
  const reporter = createOrcaReporter({ env, post: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  reporter.report("working");
  for (let i = 0; i < 20; i++) reporter.report(i % 2 === 0 ? "blocked" : "working");
  finish(new Response()); await reporter.release(); expect(calls).toBe(1);
});


test("real Orca endpoint metadata is accepted and overrides stale envelope metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orca-report-")); roots.push(root);
  const file = path.join(root, "endpoint");
  writeFileSync(file, [
    "ORCA_AGENT_HOOK_PORT=32124", "ORCA_AGENT_HOOK_TOKEN=fixture-token",
    "ORCA_AGENT_HOOK_ENV=production", "ORCA_AGENT_HOOK_VERSION=1",
    "ORCA_AGENT_HOOK_TRANSPORT=raw-json-v1", "ORCA_AGENT_HOOK_OPENCODE_TUI=1", "",
  ].join("\n"));
  let calls = 0;
  const reporter = createOrcaReporter({ env: { ...env, ORCA_AGENT_HOOK_ENDPOINT: file },
    post: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init.body));
      expect(body.env).toBe("production");
      expect(body.version).toBe("1");
      return new Response();
    } });
  reporter.report("working"); await tick(); await reporter.release();
  expect(calls).toBe(2);
  expect(() => parseOrcaEndpoint("ORCA_AGENT_HOOK_TRANSPORT=$(id)")).toThrow();
});
