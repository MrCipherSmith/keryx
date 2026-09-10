import { describe, expect, test } from "bun:test";
import { catalogForServer, mergeCatalogs, type ServerCatalog } from "./catalog";
import type { ServerState } from "./manager";
import {
  classifyToolRisk,
  createMcpInteractiveTools,
  MAX_SEARCH_RESULTS,
  MAX_TOOL_RESULT_BYTES,
  searchCatalog,
  truncateResult,
} from "./tools";

type Call = { name: string; args: Record<string, unknown>; timeoutMs?: number | undefined };

function connectedServer(
  name: string,
  calls: Call[],
  outcome: unknown = { kind: "result", result: { content: [{ type: "text", text: "ok" }], isError: false } },
): ServerState {
  return {
    name,
    status: "connected",
    toolCount: 1,
    connection: {
      listTools: async () => [],
      callTool: async (toolName, args, opts) => {
        calls.push({ name: toolName, args, timeoutMs: opts?.timeoutMs });
        return outcome as never;
      },
      close: async () => {},
    },
  };
}

function catalogWith(server: string, tools: Array<Record<string, unknown>>): ServerCatalog {
  return mergeCatalogs([catalogForServer(server, tools as never)]);
}

describe("AC4 — the advertised list is the PAIR, not the tools", () => {
  test("exactly search_tool and use_tool are offered, whatever the catalog holds", () => {
    const catalog = catalogWith("linear", [
      { name: "create_issue" },
      { name: "list_issues" },
      { name: "close_issue" },
    ]);
    const tools = createMcpInteractiveTools({ catalog: () => catalog, servers: () => [] });

    const names = tools.map((t) => t.definition.name);
    expect(names).toEqual(["search_tool", "use_tool"]);

    // And none of the qualified names leaked into the advertised surface —
    // the refusal this package is built around. Registering every MCP tool
    // would grow the model's per-turn cost with every server the operator
    // adds.
    const advertised = JSON.stringify(tools.map((t) => t.definition));
    for (const fqn of catalog.entries.map((e) => e.fqn)) {
      expect(advertised).not.toContain(fqn);
    }
  });

  test("the pair reads the catalog at call time, not at construction", async () => {
    // Servers connect in the background. A pair built from a snapshot would
    // advertise an empty catalog forever if it happened to be built first.
    let catalog = mergeCatalogs([]);
    const [search] = createMcpInteractiveTools({ catalog: () => catalog, servers: () => [] });

    catalog = catalogWith("linear", [{ name: "create_issue" }]);
    const result = await search?.invoke({ query: "create" });

    expect(result?.output).toContain("linear__create_issue");
  });
});

describe("risk is destructive unless a tool proves otherwise", () => {
  test("an unannotated tool is destructive — 'did not say' is not 'safe'", () => {
    expect(classifyToolRisk({ rawName: "list_issues" })).toBe("destructive");
  });

  test("a read-only annotation with a harmless name is read", () => {
    expect(
      classifyToolRisk({ rawName: "list_issues", inputSchema: { annotations: { readOnlyHint: true } } }),
    ).toBe("read");
  });

  test("a read-only annotation on a write-verb name is still destructive", () => {
    // A server that annotates `delete_issue` read-only is wrong or lying, and
    // the outcome is the same either way.
    expect(
      classifyToolRisk({ rawName: "delete_issue", inputSchema: { annotations: { readOnlyHint: true } } }),
    ).toBe("destructive");
  });

  test("a write verb in the DESCRIPTION also refuses the read class", () => {
    expect(
      classifyToolRisk({
        rawName: "issues",
        description: "Create a new issue in the tracker",
        inputSchema: { annotations: { readOnlyHint: true } },
      }),
    ).toBe("destructive");
  });

  test("a non-boolean annotation does not count as read-only", () => {
    expect(
      classifyToolRisk({ rawName: "peek", inputSchema: { annotations: { readOnlyHint: "yes" } } }),
    ).toBe("destructive");
  });
});

describe("AC6 — results are truncated at the cap", () => {
  test("a result over the cap is truncated and says so", () => {
    const { text, truncated } = truncateResult("x".repeat(MAX_TOOL_RESULT_BYTES + 500));
    expect(truncated).toBe(true);
    expect(text).toContain(`truncated at ${MAX_TOOL_RESULT_BYTES} bytes`);
  });

  test("the cap constant itself is asserted, so a silently raised cap fails", () => {
    // A test with its own hardcoded number would keep passing while the real
    // constant drifted.
    expect(MAX_TOOL_RESULT_BYTES).toBe(20_000);
  });

  test("a result under the cap is returned untouched", () => {
    const { text, truncated } = truncateResult("small");
    expect(truncated).toBe(false);
    expect(text).toBe("small");
  });
});

describe("AC5 — search finds it, use calls it", () => {
  test("search returns the qualified name and use_tool calls the RAW name", async () => {
    const calls: Call[] = [];
    const catalog = catalogWith("linear", [{ name: "create_issue", description: "Open a ticket" }]);
    const [search, use] = createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => [connectedServer("linear", calls)],
    });

    const found = await search?.invoke({ query: "create issue" });
    expect(found?.output).toContain("linear__create_issue");

    const called = await use?.invoke({ tool_name: "linear__create_issue", tool_input: { title: "t" } });

    // The raw name, not the FQN: the server has never heard of keryx's
    // qualified name.
    expect(calls[0]?.name).toBe("create_issue");
    expect(calls[0]?.args).toEqual({ title: "t" });
    expect(called?.isError).toBe(false);
  });

  test("MCP output is marked untrusted", async () => {
    // Third-party content may be shown and must not authorize further tools
    // this turn.
    const calls: Call[] = [];
    const catalog = catalogWith("srv", [{ name: "read" }]);
    const [, use] = createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => [connectedServer("srv", calls)],
    });

    const result = await use?.invoke({ tool_name: "srv__read", tool_input: {} });
    expect(result?.untrusted).toBe(true);
  });

  test("a per-tool timeout reaches the connection", async () => {
    const calls: Call[] = [];
    const catalog = catalogWith("srv", [{ name: "slow" }]);
    const [, use] = createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => [connectedServer("srv", calls)],
      toolTimeoutSec: () => 3,
    });

    await use?.invoke({ tool_name: "srv__slow", tool_input: {} });
    expect(calls[0]?.timeoutMs).toBe(3000);
  });
});

describe("failures say which failure", () => {
  test("an unknown qualified name points at search_tool rather than failing blankly", async () => {
    const [, use] = createMcpInteractiveTools({ catalog: () => mergeCatalogs([]), servers: () => [] });
    const result = await use?.invoke({ tool_name: "nope__thing", tool_input: {} });

    expect(result?.isError).toBe(true);
    expect(result?.output).toContain("search_tool");
  });

  test("a known tool on a disconnected server names the status", async () => {
    // Different from "no such tool", and the operator acts differently on it.
    const catalog = catalogWith("srv", [{ name: "read" }]);
    const [, use] = createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => [{ name: "srv", status: "failed", toolCount: 0, error: "ENOENT" }],
    });

    const result = await use?.invoke({ tool_name: "srv__read", tool_input: {} });
    expect(result?.output).toContain("failed");
  });

  test("a timeout is reported as a timeout, not as a generic error", async () => {
    const catalog = catalogWith("srv", [{ name: "slow" }]);
    const [, use] = createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => [connectedServer("srv", [], { kind: "timeout" })],
    });

    const result = await use?.invoke({ tool_name: "srv__slow", tool_input: {} });
    expect(result?.output).toContain("timed out");
  });

  test("an empty search says what was searched, not just 'nothing'", async () => {
    // No results over an empty catalog and no results over a full one are
    // different facts, and only one of them is actionable.
    const catalog = catalogWith("srv", [{ name: "read" }]);
    const [search] = createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => [connectedServer("srv", [])],
    });

    const result = await search?.invoke({ query: "zzzz" });
    expect(result?.output).toContain("1 tool(s)");
    expect(result?.output).toContain("1 connected server(s)");
  });
});

describe("search ranking and bounds", () => {
  test("a name hit outranks a description-only hit", () => {
    const catalog = mergeCatalogs([
      catalogForServer("a", [{ name: "notes", description: "search things" }] as never),
      catalogForServer("b", [{ name: "search_docs" }] as never),
    ]);
    expect(searchCatalog(catalog, "search")[0]?.tool_name).toBe("b__search_docs");
  });

  test("results are bounded", () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 10 }, (_v, i) => ({ name: `find_${i}` }));
    const catalog = catalogWith("srv", many);
    expect(searchCatalog(catalog, "find")).toHaveLength(MAX_SEARCH_RESULTS);
  });

  test("an empty query matches nothing rather than everything", () => {
    const catalog = catalogWith("srv", [{ name: "read" }]);
    expect(searchCatalog(catalog, "   ")).toEqual([]);
  });
});
