// The `/mcp` consumer view's model — AC1 through AC6.
//
// Asserted against the built VALUE, never against a terminal. That is
// deliberate and it is the P0/P1 lesson applied before the fact: the
// approval rendering went untested for two whole phases because it
// existed only inside a TUI callback, and both defects that came out of
// it (F-032, F-033) were properties a pure function would have exposed
// immediately.

import { describe, expect, test } from "bun:test";
import {
  buildConsumerModel,
  formatConsumerRow,
  isMcpConsumerCommand,
  MCP_CONSUMER_COMMAND,
} from "./mcp-consumer";
import { isMcpToolsCommand, MCP_TOOLS_COMMAND } from "./mcp-inspector";
import type { ResolvedMcpServer } from "../mcp-servers/config";
import type { ServerState } from "../mcp-servers/manager";

function configured(raw: Record<string, unknown>, over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name: "s",
    source: "user",
    file: "/cfg/mcp-servers.json",
    enabled: true,
    raw,
    ...raw,
    ...over,
  } as ResolvedMcpServer;
}

function model(servers: ResolvedMcpServer[], states: ServerState[] = []) {
  return buildConsumerModel({
    configured: servers,
    states,
    problems: [],
    userFile: "/cfg/mcp-servers.json",
    projectFile: "/repo/.keryx/mcp-servers.json",
  });
}

/** Everything the view would put on screen, as one string. */
function screen(servers: ResolvedMcpServer[], states: ServerState[] = []): string {
  const m = model(servers, states);
  return [
    ...m.rows.map(formatConsumerRow),
    ...m.rows.map((r) => `${r.detail ?? ""} ${r.action ?? ""}`),
    ...m.problems,
    m.emptyHint ?? "",
  ].join("\n");
}

describe("AC1/AC2 — /mcp and /integrations are DIFFERENT views", () => {
  test("/mcp is the consumer view", () => {
    expect(isMcpConsumerCommand("/mcp")).toBe(true);
    expect(MCP_CONSUMER_COMMAND).toBe("/mcp");
  });

  test("/integrations is the installer view and is NOT the consumer view", () => {
    // The assertion that matters. Before P2 both commands opened the same
    // modal, so a test that each was "accepted" passed while the rename
    // was only half done.
    expect(isMcpToolsCommand(MCP_TOOLS_COMMAND)).toBe(true);
    expect(isMcpConsumerCommand(MCP_TOOLS_COMMAND)).toBe(false);
  });

  test("and /mcp no longer opens the installer", () => {
    expect(isMcpToolsCommand("/mcp")).toBe(false);
  });

  test("AC2 — /mcps is accepted by neither", () => {
    expect(isMcpConsumerCommand("/mcps")).toBe(false);
    expect(isMcpToolsCommand("/mcps")).toBe(false);
  });

  test("BOUNDARY — a command with arguments still resolves", () => {
    expect(isMcpConsumerCommand("/mcp  extra")).toBe(true);
  });

  test("BOUNDARY — a longer command starting with the same letters does not", () => {
    expect(isMcpConsumerCommand("/mcpfoo")).toBe(false);
  });
});

describe("AC3 — every configured server appears, with what it is doing", () => {
  test("a connected server shows its transport, source and tool count", () => {
    const line = formatConsumerRow(
      model([configured({ url: "https://api.test/mcp" })], [
        { name: "s", status: "connected", toolCount: 7 },
      ])[ "rows" ][0] as never,
    );
    expect(line).toContain("connected");
    expect(line).toContain("http");
    expect(line).toContain("user");
    expect(line).toContain("7 tool(s)");
  });

  test("a held server shows the exact command that releases it", () => {
    const m = model([configured({ command: "npx", args: ["evil"] }, { source: "project" })], [
      { name: "s", status: "needs-approval", toolCount: 0, error: "not started" },
    ]);
    expect(m.rows[0]?.action).toBe("keryx mcp trust s");
  });

  test("a failed server shows its reason", () => {
    const m = model([configured({ url: "https://api.test/mcp" })], [
      { name: "s", status: "failed", toolCount: 0, error: "nothing is listening at https://api.test/mcp" },
    ]);
    expect(m.rows[0]?.detail).toContain("nothing is listening");
  });

  test("a configured server with NO state yet is connecting, not missing", () => {
    // A server the operator configured and cannot see anywhere reads as
    // one keryx never noticed, and sends them to check the wrong file.
    const m = model([configured({ url: "https://api.test/mcp" })], []);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]?.status).toBe("connecting");
  });

  test("a disabled server is listed as disabled rather than omitted", () => {
    const m = model([configured({ url: "https://x/mcp" }, { enabled: false })], []);
    expect(m.rows[0]?.status).toBe("disabled");
  });

  test("BOUNDARY — with nothing configured, the view names the files it read", () => {
    const m = model([], []);
    expect(m.rows).toHaveLength(0);
    expect(m.emptyHint).toContain("/cfg/mcp-servers.json");
    expect(m.emptyHint).toContain("/repo/.keryx/mcp-servers.json");
  });
});

describe("AC4 — nothing the view displays is raw third-party text", () => {
  // `String.fromCharCode(27)`, not a literal escape byte. A literal
  // one does not survive every editor in the chain, and an ESC that
  // silently became "" makes `expect(x).not.toContain(ESC)` an
  // assertion that ALWAYS fails — which is how this test first went
  // red, for the wrong reason. Second time today.
  const ESC = String.fromCharCode(27);
  const FORGERY = ESC + "[2K" + "\r" + ESC + "[32m" + "\u2713 auto-approved";

  test("a server error carrying escapes is neutralised", () => {
    // The latent asymmetry P1's security reviewer recorded: `doctor`
    // sanitises its copy of the failure message and `ServerState.error`
    // did not. They could not find a surface that displayed it. This is
    // that surface.
    const text = screen([configured({ url: "https://x/mcp" })], [
      { name: "s", status: "failed", toolCount: 0, error: `dial failed: ${FORGERY}` },
    ]);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\r");
    // BOUNDARY — neutralised, not dropped. Without this,
    // `detail = undefined` passes the two assertions above.
    expect(text).toContain("dial failed");
    expect(text).toContain("auto-approved");
  });

  test("and so is a config problem message", () => {
    const m = buildConsumerModel({
      configured: [],
      states: [],
      problems: [{ file: "/cfg/x.json", message: `bad: ${FORGERY}` }],
      userFile: "/u",
      projectFile: "/p",
    });
    expect(m.problems.join("\n")).not.toContain(ESC);
    expect(m.problems.join("\n")).not.toContain("\r");
    expect(m.problems.join("\n")).toContain("bad:");
  });
});

describe("AC5 — the view never prints a credential", () => {
  test("a literal secret in the url is elided, and the host still shown", () => {
    const text = screen([configured({ url: "https://alice:hunter2@api.test/mcp?api_key=sk-live-abc" })]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-live-abc");
    // The host is the point of showing the row at all.
    expect(text).toContain("api.test");
  });

  test("header and bearer variables are named, never resolved", () => {
    const m = model([
      configured({
        url: "https://api.test/mcp",
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
        bearer_token_env_var: "FALLBACK_TOKEN",
      }),
    ]);
    expect(m.rows[0]?.credentials).toEqual(["FALLBACK_TOKEN", "LINEAR_TOKEN"]);
  });

  test("a stdio server's ${VAR} argument shows the NAME, not the value", () => {
    const text = screen([configured({ command: "npx", args: ["pkg", "--token=${GITHUB_TOKEN}"] })]);
    expect(text).toContain("${GITHUB_TOKEN}");
  });

  test("and a url variable is listed as a credential too", () => {
    const m = model([configured({ url: "https://${REGION}.api.test/mcp" })]);
    expect(m.rows[0]?.credentials).toEqual(["REGION"]);
  });

  test("BOUNDARY — a server with no credentials lists none, rather than an empty tag", () => {
    const m = model([configured({ url: "https://api.test/mcp" })]);
    expect(m.rows[0]?.credentials).toEqual([]);
    expect(formatConsumerRow(m.rows[0] as never)).not.toContain("reads");
  });
});
