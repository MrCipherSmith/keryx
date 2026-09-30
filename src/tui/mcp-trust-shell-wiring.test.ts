// Flow 360: the MCP session-trust wiring inside `launchTuiAgentShell`
// (`tui-shell.ts`). The function declines at its first line without a
// controlling TTY, so it is never launched headlessly; these are the same
// source-text audits `turn-guard-shell-wiring.test.ts` uses for logic wired
// deep inside it. The behavior itself (parse, list, revoke, the withheld
// reason, the marker) is proven on the pure functions in
// `../mcp-servers/approval-render.trust.test.ts` and on `runAgentTurn` in
// `../commands/agent-permission-mode.test.ts`.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBusyDispatch } from "./busy-dispatch";
import { isMcpConsumerCommand } from "./mcp-consumer";

const SOURCE = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
const FN_START = SOURCE.indexOf("export async function launchTuiAgentShell(opts: {");

function bodyFrom(marker: string): string {
  const at = SOURCE.indexOf(marker, FN_START);
  expect(at).toBeGreaterThan(FN_START);
  return SOURCE.slice(at, SOURCE.indexOf("\n    };\n", at));
}

test("the audit is anchored inside launchTuiAgentShell", () => {
  expect(FN_START).toBeGreaterThan(-1);
});

test("AC6: /new and /clear both go through startNewSession, which clears the trust grants", () => {
  const dispatch = SOURCE.indexOf('command.name === "/clear" || command.name === "/new"', FN_START);
  expect(dispatch).toBeGreaterThan(FN_START);
  expect(SOURCE.slice(dispatch, dispatch + 1200)).toContain("startNewSession(");
  const body = bodyFrom("const startNewSession = (note?: string): boolean => {");
  const reset = body.indexOf("resetSessionSurface();");
  const clear = body.indexOf("io.trustedMcpTools?.clear();");
  const swap = body.indexOf("liveSession = opened.handle;");
  expect(reset).toBeGreaterThan(-1);
  // After the open succeeded (a failed open keeps the session AND its grants),
  // and in the same block that swaps the live session.
  expect(clear).toBeGreaterThan(reset);
  expect(clear).toBeLessThan(swap);
});

test("AC6: the failed-open path returns before any grant is cleared", () => {
  const body = bodyFrom("const startNewSession = (note?: string): boolean => {");
  expect(body.indexOf("return false;")).toBeLessThan(body.indexOf("io.trustedMcpTools?.clear();"));
});

test("AC3/AC4: /mcp trust is routed while idle and while busy, ahead of the server view", () => {
  const helper = bodyFrom("const runMcpTrustLine = (line: string): boolean => {");
  expect(helper).toContain("parseMcpTrustCommand(line)");
  expect(helper).toContain("runMcpTrustCommand(parsed, io.trustedMcpTools,");
  expect(SOURCE.split("if (!runMcpTrustLine(line)) showMcpConsumer();")).toHaveLength(3); // busy + idle
});

test("AC2: the shell wires the live-catalog destructive resolver beside the fingerprint one", () => {
  const fingerprintAt = SOURCE.indexOf("io.mcpToolFingerprint = ", FN_START);
  const destructiveAt = SOURCE.indexOf("io.mcpToolDestructive = ", FN_START);
  expect(fingerprintAt).toBeGreaterThan(FN_START);
  expect(destructiveAt).toBeGreaterThan(fingerprintAt);
  expect(SOURCE.slice(destructiveAt, destructiveAt + 200)).toContain("catalogDestructiveResolver(");
});

test("AC1/AC5: the dock withholds trust for a destructive tool and marks a trusted one", () => {
  expect(SOURCE).toContain("catalogDestructiveResolver(deps.mcpRuntime?.()?.catalog())(described.fqn)");
  expect(SOURCE).toContain("...destructiveTrustNotices(meta)");
  expect(SOURCE).toContain('meta?.mcpTrusted === true ? ` ${TRUSTED_MARKER}` : ""');
  expect(SOURCE).toContain("(meta.mcpTrusted === true ? ` ${TRUSTED_MARKER}` : \"\")");
});

test("AC3: /mcp trust runs while a turn is busy — it classifies with the read-only consumer view, not as deferred", () => {
  for (const line of ["/mcp trust list", "/mcp trust revoke linear__search", "/mcp trust revoke all"]) {
    expect(isMcpConsumerCommand(line)).toBe(true);
    const target = classifyBusyDispatch({
      line, commandName: undefined, isSessionInfo: false, isFlows: false, isWorkspace: false, isReview: false,
      isMcp: false, isMcpConsumer: isMcpConsumerCommand(line),
    });
    expect(target).toBe("mcp-consumer");
  }
  // `/mcps` stays unknown: it is a different first token.
  expect(isMcpConsumerCommand("/mcps trust list")).toBe(false);
});
