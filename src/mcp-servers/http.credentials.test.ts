// AC4/AC5/AC8, end to end: a hollow credential reaches no socket, and no
// report prints a real one.
//
// The class table next door proves the DECISION. This proves the decision
// is wired: from a config file on disk, through the runtime and through
// `keryx mcp doctor`, to a mock server that records every request it
// received. The criterion is that the recording is EMPTY — a request that
// is sent and then rejected is a different, weaker property.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockHttpMcpServer, type MockHttpMcpServer } from "../../fixtures/mcp-servers/http-server";
import { loadMcpServers } from "./config";
import { runDoctor, formatDoctorReport } from "./doctor";
import { createMcpRuntime } from "./runtime";
import { connectHttpMcpServer } from "../mcp-client/client";
import { resolveHttpHeaders, describeHollow } from "./http-headers";

const running: MockHttpMcpServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop().catch(() => {});
});

async function mock(options?: Parameters<typeof startMockHttpMcpServer>[0]): Promise<MockHttpMcpServer> {
  const server = await startMockHttpMcpServer(options);
  running.push(server);
  return server;
}

function workspace(entry: Record<string, unknown>): string {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-http-cred-"));
  const configDir = path.join(base, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "mcp-servers.json"),
    JSON.stringify({ schemaVersion: 1, servers: { remote: entry } }),
  );
  return configDir;
}

/** The real connect path, with the env injected rather than read. */
async function dial(configDir: string, env: Record<string, string | undefined>) {
  const config = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env });
  const server = config.servers[0];
  if (server === undefined) throw new Error("no server loaded");
  const resolved = resolveHttpHeaders(server, server.raw, env);
  if (!resolved.ok) throw new Error(describeHollow(resolved.hollow));
  return connectHttpMcpServer(server.url as string, {
    headers: resolved.headers,
    handshakeTimeoutMs: 8_000,
  });
}

describe("AC4 — an unset variable means NO REQUEST, not a rejected one", () => {
  test("Bearer ${TOKEN} with TOKEN unset reaches the server never", async () => {
    const server = await mock();
    const configDir = workspace({ url: server.url, headers: { Authorization: "Bearer ${TOKEN}" } });

    await expect(dial(configDir, {})).rejects.toThrow(/TOKEN/);
    // The assertion the criterion is actually about.
    expect(server.requests()).toEqual([]);
  }, 30_000);

  test("bearer_token_env_var naming an unset variable, likewise", async () => {
    const server = await mock();
    const configDir = workspace({ url: server.url, bearer_token_env_var: "LINEAR_TOKEN" });

    await expect(dial(configDir, {})).rejects.toThrow(/LINEAR_TOKEN/);
    expect(server.requests()).toEqual([]);
  }, 30_000);

  test("BOUNDARY — with the variable set, the request arrives and carries it", async () => {
    // Without this the two tests above pass for a runtime that dials
    // nothing at all.
    const server = await mock();
    const configDir = workspace({ url: server.url, headers: { Authorization: "Bearer ${TOKEN}" } });

    const connection = await dial(configDir, { TOKEN: "sk-live-xyz" });
    await connection.listTools();
    await connection.close();

    expect(server.requests().length).toBeGreaterThan(0);
    expect(server.requests()[0]?.headers.authorization).toBe("Bearer sk-live-xyz");
  }, 30_000);

  test("the runtime holds the server rather than dialling it", async () => {
    const server = await mock();
    const configDir = workspace({ url: server.url, bearer_token_env_var: "TOKEN" });

    const runtime = createMcpRuntime({ cwd: configDir, gitRoot: configDir, configDir, env: {} });
    await runtime.ready();
    const state = runtime.servers()[0];
    await runtime.close();

    expect(state?.status).toBe("failed");
    expect(state?.error).toContain("TOKEN");
    expect(server.requests()).toEqual([]);
  }, 30_000);
});

describe("AC4 — doctor says which variable, and does not dial", () => {
  test("a hollow credential is needs_auth and names the variable", async () => {
    const server = await mock();
    const configDir = workspace({ url: server.url, headers: { Authorization: "Bearer ${MY_TOKEN}" } });
    const config = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: {} });

    let dialled = 0;
    const report = await runDoctor(config, {
      env: {},
      connect: async () => {
        dialled++;
        throw new Error("should not be reached");
      },
    });

    expect(report.servers[0]?.status).toBe("needs_auth");
    expect(report.servers[0]?.detail).toContain("MY_TOKEN");
    expect(dialled).toBe(0);
    expect(server.requests()).toEqual([]);
    expect(formatDoctorReport(report)).toContain("MY_TOKEN");
  }, 30_000);
});

describe("AC8 — no report prints a token", () => {
  const SECRET = "sk-live-must-never-be-printed";

  test("doctor text, doctor --json and the header map show set/unset only", async () => {
    const server = await mock();
    const configDir = workspace({
      url: server.url,
      headers: { Authorization: "Bearer ${MY_TOKEN}", "X-Api-Key": "${MY_TOKEN}" },
    });
    const config = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: { MY_TOKEN: SECRET } });

    const report = await runDoctor(config, {
      env: { MY_TOKEN: SECRET },
      connect: async () => ({
        listTools: async () => [],
        callTool: async () => ({ kind: "result", result: { content: [], isError: false } }) as never,
        close: async () => {},
      }),
    });

    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(formatDoctorReport(report)).not.toContain(SECRET);
    expect(report.servers[0]?.headers).toEqual({ Authorization: "set", "X-Api-Key": "set" });
  }, 30_000);

  test("and an UNSET one is reported unset rather than omitted", async () => {
    const server = await mock();
    const configDir = workspace({ url: server.url, headers: { Authorization: "Bearer ${NOPE}" } });
    const config = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: {} });

    const report = await runDoctor(config, { env: {}, connect: async () => ({}) as never });
    expect(report.servers[0]?.detail).toContain("NOPE");
    // And the headers map must AGREE with the detail. `Bearer ${NOPE}`
    // expands to `Bearer ` — non-empty — so a redaction that looks only at
    // the expanded value calls it `set`, and the report then says the
    // header is set and the variable is unset in the same breath.
    expect(report.servers[0]?.headers).toEqual({ Authorization: "unset" });
  }, 30_000);
});
