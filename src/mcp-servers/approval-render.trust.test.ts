// Flow 360: destructive-tool trust withholding, the trusted marker, and the
// `/mcp trust list|revoke` command. Pure functions shared by the TUI dock and
// the readline prompt, so one file pins both surfaces.

import { describe, expect, test } from "bun:test";
import {
  catalogDestructiveResolver,
  catalogResolver,
  catalogTrustStaleness,
  describeUseToolApproval,
  destructiveTrustNotices,
  mcpTrustOffered,
  parseMcpTrustCommand,
  promptUseToolApproval,
  renderUseToolApprovalLines,
  runMcpTrustCommand,
  TRUSTED_MARKER,
  type ApprovalIo,
} from "./approval-render";
import { toolDefinitionFingerprint } from "./catalog";

function fakeIo(answer: string | undefined): ApprovalIo & { written: () => string } {
  const chunks: string[] = [];
  return { out: (text) => chunks.push(text), readLine: async () => answer, written: () => chunks.join("") };
}

const CALL = JSON.stringify({ tool_name: "linear__create_issue", tool_input: { title: "ship it" } });
const catalog = {
  entries: [
    { fqn: "linear__create_issue", server: "linear", rawName: "create_issue", annotations: { destructiveHint: true } },
    { fqn: "linear__list_issues", server: "linear", rawName: "list_issues", annotations: { destructiveHint: false } },
    { fqn: "linear__search", server: "linear", rawName: "search" },
  ],
};
const resolve = catalogResolver(catalog);
const destructiveMeta = { fingerprint: "fp-1", mcpTrustWithheld: true, mcpTrustWithheldReason: "destructive" } as const;

describe("AC1: a destructive tool is never offered trust", () => {
  test("AC1: the catalog resolver is true only for an explicit destructiveHint true", () => {
    const destructive = catalogDestructiveResolver(catalog);
    expect(destructive("linear__create_issue")).toBe(true);
    expect(destructive("linear__list_issues")).toBe(false);
    expect(destructive("linear__search")).toBe(false);
    expect(destructive("linear__unknown")).toBe(false);
    expect(catalogDestructiveResolver(undefined)("linear__create_issue")).toBe(false);
  });

  test("AC1: mcpTrustOffered refuses on the withheld reason and on the live resolver", () => {
    expect(mcpTrustOffered({ fingerprint: "fp-1", mcpTrustAvailable: true }, true)).toBe(true);
    expect(mcpTrustOffered({ fingerprint: "fp-1", mcpTrustAvailable: true }, true, false)).toBe(true);
    expect(mcpTrustOffered({ fingerprint: "fp-1", mcpTrustAvailable: true }, true, true)).toBe(false);
    expect(mcpTrustOffered(destructiveMeta, true)).toBe(false);
  });

  test("AC1: the readline prompt omits T, says why, and a typed T is a denial", async () => {
    const io = fakeIo("t");
    expect(await promptUseToolApproval(io, CALL, destructiveMeta, resolve, undefined, "", catalogDestructiveResolver(catalog))).toBe(false);
    const shown = io.written();
    expect(shown).toContain("[y/N] ");
    expect(shown).not.toContain("T=trust");
    expect(shown).toContain("marked destructive");
    expect(shown).not.toContain("follows untrusted external content");
  });

  test("AC1: the readline prompt also withholds when only the live resolver says destructive", async () => {
    const io = fakeIo("t");
    const meta = { fingerprint: "fp-1", mcpTrustAvailable: true } as const;
    expect(await promptUseToolApproval(io, CALL, meta, resolve, undefined, "", catalogDestructiveResolver(catalog))).toBe(false);
    expect(io.written()).not.toContain("T=trust");
  });

  test("AC1: a plain yes on a destructive tool still approves, with no grant attached", async () => {
    expect(await promptUseToolApproval(fakeIo("y"), CALL, destructiveMeta, resolve, undefined, "", catalogDestructiveResolver(catalog))).toEqual({
      approved: true,
      fingerprint: "fp-1",
    });
  });

  test("AC1: absent and false annotations keep the trust option", async () => {
    const io = fakeIo("t");
    const call = JSON.stringify({ tool_name: "linear__search", tool_input: {} });
    expect(await promptUseToolApproval(io, call, { fingerprint: "fp-1", mcpTrustAvailable: true }, resolve, undefined, "", catalogDestructiveResolver(catalog))).toEqual({
      approved: true,
      fingerprint: "fp-1",
      trustMcpTool: true,
    });
    expect(io.written()).toContain("T=trust this tool for session");
  });

  test("AC1: the dock notice names the destructive reason and the untrusted-origin one does not", () => {
    expect(destructiveTrustNotices(destructiveMeta).join(" ")).toContain("destructive");
    expect(destructiveTrustNotices({ mcpTrustWithheld: true, mcpTrustWithheldReason: "untrusted-origin" })).toEqual([]);
    expect(destructiveTrustNotices({})).toEqual([]);
  });
});

describe("AC5: the trusted marker", () => {
  test("AC5: the approval transcript marks a trusted tool and only a trusted one", () => {
    const description = describeUseToolApproval(CALL, resolve);
    const marked = renderUseToolApprovalLines(description, { mcpTrusted: true }).join("\n");
    const plain = renderUseToolApprovalLines(description, {}).join("\n");
    expect(marked).toContain(TRUSTED_MARKER);
    expect(plain).not.toContain(TRUSTED_MARKER);
  });
});

describe("AC3: /mcp trust list and revoke", () => {
  const grants = () => new Map([["linear__search", "fp-a"], ["linear__list_issues", "fp-b"]]);

  test("AC3: only exact /mcp trust lines are trust commands", () => {
    expect(parseMcpTrustCommand("/mcp")).toBeUndefined();
    expect(parseMcpTrustCommand("/mcp servers")).toBeUndefined();
    expect(parseMcpTrustCommand("/mcps trust list")).toBeUndefined();
    expect(parseMcpTrustCommand("/mcp trust list")).toEqual({ kind: "list" });
    expect(parseMcpTrustCommand("  /mcp   trust   list  ")).toEqual({ kind: "list" });
    expect(parseMcpTrustCommand("/mcp trust revoke linear__search")).toEqual({ kind: "revoke", target: "linear__search" });
    expect(parseMcpTrustCommand("/mcp trust revoke all")).toEqual({ kind: "revoke-all" });
  });

  test("AC3: malformed trust lines answer with usage and change nothing", () => {
    const trusted = grants();
    for (const line of ["/mcp trust", "/mcp trust nope", "/mcp trust revoke", "/mcp trust revoke a b", "/mcp trust list extra"]) {
      const parsed = parseMcpTrustCommand(line);
      expect(parsed?.kind).toBe("usage");
      const out = runMcpTrustCommand(parsed!, trusted, resolve).join("\n");
      expect(out).toContain("Usage:");
    }
    expect(trusted.size).toBe(2);
  });

  test("AC3: list shows each grant with its full name, server and the trusted marker", () => {
    const out = runMcpTrustCommand({ kind: "list" }, grants(), resolve).join("\n");
    expect(out).toContain("linear__list_issues");
    expect(out).toContain("linear__search");
    expect(out).toContain("server: linear");
    expect(out.split(TRUSTED_MARKER).length - 1).toBe(2);
  });

  test("AC3: list on an empty session says so", () => {
    expect(runMcpTrustCommand({ kind: "list" }, new Map(), resolve).join("\n")).toContain("No MCP tools are trusted");
    expect(runMcpTrustCommand({ kind: "list" }, undefined, resolve).join("\n")).toContain("No MCP tools are trusted");
  });

  test("AC3: revoke removes exactly that grant", () => {
    const trusted = grants();
    const out = runMcpTrustCommand({ kind: "revoke", target: "linear__search" }, trusted, resolve).join("\n");
    expect(out).toContain("Revoked trust for linear__search");
    expect([...trusted.keys()]).toEqual(["linear__list_issues"]);
  });

  test("AC3: an unknown tool is reported and nothing changes", () => {
    const trusted = grants();
    const out = runMcpTrustCommand({ kind: "revoke", target: "linear__nope" }, trusted, resolve).join("\n");
    expect(out).toContain("not trusted");
    expect(out).toContain("nothing changed");
    expect(trusted.size).toBe(2);
  });

  test("AC3: a bare tool name is not a full name and revokes nothing", () => {
    const trusted = grants();
    runMcpTrustCommand({ kind: "revoke", target: "search" }, trusted, resolve);
    expect(trusted.size).toBe(2);
  });

  test("AC3: hostile revoke targets never touch another grant", () => {
    const trusted = new Map([
      ["srv__a__b", "fp"],
      ["all__x", "fp"],
      ["srv__all", "fp"],
    ]);
    for (const line of ["/mcp trust revoke ALL", "/mcp trust revoke all__", "/mcp trust revoke srv", "/mcp trust revoke srv__a", "/mcp trust revoke  "]) {
      const parsed = parseMcpTrustCommand(line);
      expect(parsed?.kind === "revoke-all").toBe(false);
      runMcpTrustCommand(parsed!, trusted, resolve);
    }
    expect(trusted.size).toBe(3);
    runMcpTrustCommand({ kind: "revoke", target: "all__x" }, trusted, resolve);
    expect([...trusted.keys()].sort()).toEqual(["srv__a__b", "srv__all"]);
    runMcpTrustCommand(parseMcpTrustCommand("/mcp trust revoke srv__a__b")!, trusted, resolve);
    expect([...trusted.keys()]).toEqual(["srv__all"]);
  });

  test("AC3: list says which grants would ask again — definition changed, now destructive, gone — and marks the rest trusted", () => {
    const search = { fqn: "linear__search", description: "d", inputSchema: {} };
    const staleCatalog = {
      entries: [
        { ...search },
        { fqn: "linear__list_issues", description: "changed since the grant", inputSchema: {} },
        { fqn: "linear__create_issue", description: "d", inputSchema: {}, annotations: { destructiveHint: true } },
      ],
    };
    const trusted = new Map([
      ["linear__search", toolDefinitionFingerprint(search)],
      ["linear__list_issues", "fingerprint-from-before"],
      ["linear__create_issue", "whatever"],
      ["linear__removed", "whatever"],
    ]);
    const out = runMcpTrustCommand({ kind: "list" }, trusted, resolve, catalogTrustStaleness(staleCatalog)).join("\n");
    expect(out).toMatch(/linear__search .*\[trusted\]/);
    expect(out).toContain("will ask again: changed");
    expect(out).toContain("will ask again: destructive");
    expect(out).toContain("will ask again: gone");
    expect(out.split(TRUSTED_MARKER).length - 1).toBe(1);
  });

  test("AC3: revoke all clears every grant", () => {
    const trusted = grants();
    const out = runMcpTrustCommand({ kind: "revoke-all" }, trusted, resolve).join("\n");
    expect(out).toContain("Revoked trust for 2");
    expect(trusted.size).toBe(0);
    expect(runMcpTrustCommand({ kind: "revoke-all" }, trusted, resolve).join("\n")).toContain("nothing to revoke");
  });
});
