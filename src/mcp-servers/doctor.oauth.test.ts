// AC5 and AC3 — what doctor says about a server that needs a login,
// and what no surface ever prints.
//
// The pre-emptive branch here is narrow on purpose, and the first
// version of it was not. `usesOAuth` means "OAuth would apply if
// authentication is needed", which is true of every remote server
// declaring no credential — including every PUBLIC one. Used as "must
// authenticate before dialling" it stopped doctor dialling them at
// all. The boundary tests below are the ones that caught that.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCredential } from "./credentials";
import { runDoctor } from "./doctor";
import { OAuthInteractionRequiredError } from "./oauth-provider";
import type { ResolvedMcpConfig, ResolvedMcpServer } from "./config";
import type { McpToolDescriptor } from "../mcp-client/client";

const NOW = 1_700_000_000_000;
const URL_ = "https://mcp.linear.app/mcp";

function store(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-doctor-oauth-"));
}

function server(raw: Record<string, unknown>): ResolvedMcpServer {
  return {
    name: "linear",
    source: "user",
    file: "/config/mcp-servers.json",
    enabled: true,
    url: typeof raw.url === "string" ? raw.url : undefined,
    raw,
  } as unknown as ResolvedMcpServer;
}

function config(servers: ResolvedMcpServer[]): ResolvedMcpConfig {
  return { servers, problems: [] } as unknown as ResolvedMcpConfig;
}

function connection(tools: McpToolDescriptor[]) {
  return { listTools: async () => tools, close: async () => {} } as never;
}

async function diagnose(
  raw: Record<string, unknown>,
  over: { configDir?: string; connect?: () => Promise<never> } = {},
): Promise<{ status: string; detail: string; dialled: number }> {
  let dialled = 0;
  const report = await runDoctor(config([server(raw)]), {
    env: {},
    now: () => NOW,
    configDir: over.configDir ?? store(),
    connect: async () => {
      dialled++;
      return over.connect === undefined
        ? connection([{ name: "issue" }] as McpToolDescriptor[])
        : await over.connect();
    },
  });
  const first = report.servers[0];
  return { status: String(first?.status), detail: String(first?.detail ?? ""), dialled };
}

describe("AC5 — a declared OAuth server with no credential is diagnosed, not dialled", () => {
  test("status is needs_auth", async () => {
    const result = await diagnose({ url: URL_, oauth: {} });
    expect(result.status).toBe("needs_auth");
  });

  test("and it is NOT dialled — a 401 reads as the server rejecting you", async () => {
    expect((await diagnose({ url: URL_, oauth: {} })).dialled).toBe(0);
  });

  test("and the detail names the one command that fixes it", async () => {
    expect((await diagnose({ url: URL_, oauth: {} })).detail).toContain("keryx mcp auth linear");
  });

  test("an expired credential with NO refresh token is the same case", async () => {
    const dir = store();
    writeCredential("linear", URL_, { tokens: { access_token: "t", expires_at: NOW - 1 } }, dir);
    const result = await diagnose({ url: URL_, oauth: {} }, { configDir: dir });
    expect(result.status).toBe("needs_auth");
    expect(result.detail).toContain("expired");
  });

  test("BOUNDARY — expired WITH a refresh token is dialled, because the SDK will refresh it", async () => {
    // Reporting this as needs_auth sends the operator through a consent
    // screen to obtain what they already have.
    const dir = store();
    writeCredential(
      "linear",
      URL_,
      { tokens: { access_token: "t", refresh_token: "r", expires_at: NOW - 1 } },
      dir,
    );
    const result = await diagnose({ url: URL_, oauth: {} }, { configDir: dir });
    expect(result.dialled).toBe(1);
    expect(result.status).toBe("connected");
  });

  test("BOUNDARY — a valid credential is dialled", async () => {
    const dir = store();
    writeCredential("linear", URL_, { tokens: { access_token: "t", expires_at: NOW + 600_000 } }, dir);
    expect((await diagnose({ url: URL_, oauth: {} }, { configDir: dir })).dialled).toBe(1);
  });

  test("BOUNDARY — a PUBLIC remote server is dialled, credential or not", async () => {
    // The regression the narrow branch exists to prevent: keryx cannot
    // know in advance that a remote server needs a login, and treating
    // every credential-less one as unauthenticated reported working
    // servers as broken.
    const result = await diagnose({ url: URL_ });
    expect(result.dialled).toBe(1);
    expect(result.status).toBe("connected");
  });

  test("BOUNDARY — a declared oauth block WITH a bearer variable is dialled, not pre-empted", async () => {
    // Both conjuncts of the pre-flight gate have to matter. An
    // operator who writes both has said how to authenticate; the
    // `oauth` block does not override that.
    const result = await diagnose({ url: URL_, oauth: {}, bearer_token_env_var: "T" });
    expect(result.dialled).toBe(1);
  });

  test("BOUNDARY — `oauth: false` is dialled even with no credential at all", async () => {
    expect((await diagnose({ url: URL_, oauth: false })).dialled).toBe(1);
  });

  test("a corrupt credential store is reported as such, not as 'no credential'", async () => {
    // The token may well be in there, behind a syntax error. Telling
    // the operator to re-authenticate would have them overwrite it.
    const dir = store();
    await Bun.write(path.join(dir, "mcp-credentials.json"), "{not json");
    const result = await diagnose({ url: URL_, oauth: {} }, { configDir: dir });
    expect(result.status).toBe("needs_auth");
    expect(result.detail).toContain("not valid JSON");
  });
});

describe("AC5 — and a server that turns out to want OAuth once dialled", () => {
  test("a 401 becomes needs_auth naming the command, not 'check the header'", async () => {
    const error = Object.assign(new Error("Unauthorized"), { code: 401 });
    const result = await diagnose({ url: URL_ }, { connect: async () => { throw error; } });
    expect(result.status).toBe("needs_auth");
    expect(result.detail).toContain("keryx mcp auth linear");
  });

  test("the provider's own headless refusal does too", async () => {
    const result = await diagnose(
      { url: URL_ },
      { connect: async () => { throw new OAuthInteractionRequiredError("linear"); } },
    );
    expect(result.status).toBe("needs_auth");
  });

  test("BOUNDARY — a 401 against a BEARER server stays failed, naming the header", async () => {
    // Two keryx surfaces must not contradict each other. Without the
    // `usesOAuth` gate, doctor told the operator to run
    // `keryx mcp auth <name>` and that command answered "does not use
    // OAuth" — a loop with no exit.
    const error = Object.assign(new Error("Unauthorized"), { code: 401 });
    const result = await diagnose(
      { url: URL_, bearer_token_env_var: "LINEAR_TOKEN" },
      { connect: async () => { throw error; } },
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("bearer_token_env_var");
    expect(result.detail).not.toContain("keryx mcp auth");
  });

  test("and a 401 against a server with a declared Authorization header does too", async () => {
    const error = Object.assign(new Error("Unauthorized"), { code: 401 });
    const result = await diagnose(
      { url: URL_, headers: { Authorization: "Bearer x" } },
      { connect: async () => { throw error; } },
    );
    expect(result.status).toBe("failed");
  });

  test("BOUNDARY — a 403 stays failed: authenticated, not permitted", async () => {
    // Re-running `keryx mcp auth` grants no scope. Sending the operator
    // through a consent screen that cannot help is worse than saying
    // their token lacks permission.
    const error = Object.assign(new Error("Forbidden"), { code: 403 });
    const result = await diagnose({ url: URL_ }, { connect: async () => { throw error; } });
    expect(result.status).toBe("failed");
  });

  test("BOUNDARY — a connection refused stays failed", async () => {
    const error = Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    const result = await diagnose({ url: URL_ }, { connect: async () => { throw error; } });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("nothing is listening");
  });

  test("BOUNDARY — a 500 stays failed, and says the server is failing", async () => {
    const error = Object.assign(new Error("boom"), { code: 503 });
    const result = await diagnose({ url: URL_ }, { connect: async () => { throw error; } });
    expect(result.status).toBe("failed");
  });
});

describe("AC3 — no surface prints token material", () => {
  const SECRET = "sk-live-ABCDEF0123456789";

  test("not the doctor report, on the needs_auth path", async () => {
    const dir = store();
    writeCredential("linear", URL_, { tokens: { access_token: SECRET, expires_at: NOW - 1 } }, dir);
    const result = await diagnose({ url: URL_, oauth: {} }, { configDir: dir });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("nor on the connected path", async () => {
    const dir = store();
    writeCredential("linear", URL_, { tokens: { access_token: SECRET, expires_at: NOW + 600_000 } }, dir);
    const report = await runDoctor(config([server({ url: URL_, oauth: {} })]), {
      env: {},
      now: () => NOW,
      configDir: dir,
      connect: async () => connection([{ name: "issue" }] as McpToolDescriptor[]),
    });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test("nor the refresh token, which is the more valuable of the two", async () => {
    // It outlives the access token and buys new ones.
    const dir = store();
    writeCredential(
      "linear",
      URL_,
      { tokens: { access_token: "a", refresh_token: SECRET, expires_at: NOW - 1 } },
      dir,
    );
    const report = await runDoctor(config([server({ url: URL_, oauth: {} })]), {
      env: {},
      now: () => NOW,
      configDir: dir,
      connect: async () => connection([]),
    });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test("nor the PKCE verifier", async () => {
    const dir = store();
    writeCredential("linear", URL_, { code_verifier: SECRET }, dir);
    const result = await diagnose({ url: URL_, oauth: {} }, { configDir: dir });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
