// The MCP pair as the AGENT actually sees it — AC4 and AC7.
//
// Everything in `src/mcp-servers/tools.test.ts` drives the tools directly.
// That proves they behave; it cannot prove they are REGISTERED, and it cannot
// prove the approval gate fires, because the gate lives in `agent.ts` and a
// direct `invoke()` walks straight past it. Both criteria are about the
// agent, so both are asserted here through `buildInteractiveAgentTools` and
// `runAgentTurn`.
//
// This file is the reason `use_tool` may carry no approval check of its own
// (D-05, no fourth decision layer): the gate it relies on is exercised here,
// not assumed.

import { describe, expect, test } from "bun:test";
import { runAgentTurn, type AgentIO } from "./agent";
import { buildInteractiveAgentTools, type McpToolBinding } from "./interactive-agent-tools";
import { catalogForServer, mergeCatalogs } from "../mcp-servers/catalog";
import type { ServerState } from "../mcp-servers/manager";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { SearchProviderController } from "../harness/search";
import type {
  NormalizedEvent,
  NormalizedMessage,
  ProviderDescription,
  ProviderPort,
} from "../harness/provider/types";

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

function scriptedProvider(rounds: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function callScript(tool: string, input: string): Partial<NormalizedEvent>[][] {
  return [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: tool },
      { kind: "tool_call_end", toolCallId: "c1", input },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];
}

const spawnStub: InteractiveTool = {
  definition: {
    name: "spawn_subagent",
    description: "stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "delegate",
  },
  invoke: async () => ({ output: "", isError: false }),
};

/** A catalog of three tools on one server, and a connection that records calls. */
function binding(calls: string[]): { mcp: McpToolBinding; fqns: string[] } {
  const catalog = mergeCatalogs([
    catalogForServer("linear", [
      { name: "create_issue", description: "Open a ticket" },
      { name: "list_issues", description: "Read tickets", inputSchema: { annotations: { readOnlyHint: true } } },
      { name: "close_issue" },
    ] as never),
  ]);
  const server: ServerState = {
    name: "linear",
    status: "connected",
    toolCount: 3,
    connection: {
      listTools: async () => [],
      callTool: async (name) => {
        calls.push(name);
        return { kind: "result", result: { content: [{ type: "text", text: "ok" }], isError: false } } as never;
      },
      close: async () => {},
    },
  };
  return {
    mcp: { catalog: () => catalog, servers: () => [server] },
    fqns: catalog.entries.map((entry) => entry.fqn),
  };
}

function tools(mcp?: McpToolBinding): InteractiveTool[] {
  return buildInteractiveAgentTools({
    cwd: process.cwd(),
    metaprojectPort: {} as MetaprojectPort,
    searchController: {} as SearchProviderController,
    spawnTool: spawnStub,
    ...(mcp === undefined ? {} : { mcp }),
  });
}

let seq = 0;
const idSeq = (): string => `id-${seq++}`;

describe("AC4 — what the agent advertises", () => {
  test("search_tool and use_tool are registered, and NOT one tool per MCP tool", () => {
    const { mcp, fqns } = binding([]);
    const names = tools(mcp).map((tool) => tool.definition.name);

    expect(names).toContain("search_tool");
    expect(names).toContain("use_tool");

    // The refusal this package exists for, asserted against the definitions
    // the agent actually gets. Registering every connected tool grows the
    // per-turn cost with every server an operator adds, forever.
    expect(fqns.length).toBeGreaterThan(0);
    for (const fqn of fqns) {
      expect(names).not.toContain(fqn);
    }
  });

  test("without a runtime the pair is absent entirely, not advertised and broken", () => {
    // Same principle as `jobRegistry`: a tool backed by nothing is worse
    // than not offering the capability.
    const names = tools().map((tool) => tool.definition.name);
    expect(names).not.toContain("search_tool");
    expect(names).not.toContain("use_tool");
  });

  test("adding the runtime adds exactly two tools", () => {
    const { mcp } = binding([]);
    expect(tools(mcp).length - tools().length).toBe(2);
  });
});

describe("AC7 — the agent's gate, driven for real", () => {
  async function turn(
    io: AgentIO,
    mcp: McpToolBinding,
    permissionMode?: () => "ask" | "trust" | "auto",
  ): Promise<void> {
    const history: NormalizedMessage[] = [];
    await runAgentTurn(
      // `permissionMode` lives on AgentIO, beside `requestApproval` — the
      // mode and the approver are one surface, which is why a mode cannot be
      // set by something that has no way to ask.
      { ...io, ...(permissionMode === undefined ? {} : { permissionMode }) },
      {
        provider: scriptedProvider(
          callScript("use_tool", JSON.stringify({ tool_name: "linear__create_issue", tool_input: { title: "t" } })),
        ),
        providerId: "s",
        modelId: "m",
        tools: tools(mcp),
        systemInstruction: "sys",
        idSeq,
      },
      history,
      "go",
    );
  }

  test("ask mode: the operator is asked, and the call runs only after they agree", async () => {
    const calls: string[] = [];
    const { mcp } = binding(calls);
    const asked: string[] = [];

    await turn(
      {
        write: () => {},
        requestApproval: async (name) => {
          asked.push(name);
          return true;
        },
      },
      mcp,
    );

    expect(asked).toEqual(["use_tool"]);
    expect(calls).toEqual(["create_issue"]);
  });

  test("a refusal means the MCP server is never reached", async () => {
    const calls: string[] = [];
    const { mcp } = binding(calls);

    await turn({ write: () => {}, requestApproval: async () => false }, mcp);

    expect(calls).toEqual([]);
  });

  test("HEADLESS fails closed: no approver, no call", async () => {
    // The arm that turns a prompt into a bypass. A call that proceeds
    // because nobody was present to object has not been approved.
    const calls: string[] = [];
    const { mcp } = binding(calls);

    await turn({ write: () => {} }, mcp);

    expect(calls).toEqual([]);
  });

  test("trust mode STILL asks, because use_tool is destructive", async () => {
    const calls: string[] = [];
    const { mcp } = binding(calls);
    const asked: string[] = [];

    await turn(
      {
        write: () => {},
        requestApproval: async (name) => {
          asked.push(name);
          return true;
        },
      },
      mcp,
      () => "trust",
    );

    expect(asked).toEqual(["use_tool"]);
    expect(calls).toEqual(["create_issue"]);
  });

  test("auto mode is the one that does not ask — so the tests above are not vacuous", async () => {
    // If the gate never fired at all, every assertion above would pass for
    // the wrong reason. This is the mode where skipping IS correct, and it
    // shows the difference is real.
    const calls: string[] = [];
    const { mcp } = binding(calls);
    const asked: string[] = [];

    await turn(
      {
        write: () => {},
        requestApproval: async (name) => {
          asked.push(name);
          return true;
        },
      },
      mcp,
      () => "auto",
    );

    expect(asked).toEqual([]);
    expect(calls).toEqual(["create_issue"]);
  });

  test("search_tool is read, so finding a tool never prompts", async () => {
    const { mcp } = binding([]);
    const asked: string[] = [];
    const history: NormalizedMessage[] = [];

    await runAgentTurn(
      {
        write: () => {},
        requestApproval: async (name) => {
          asked.push(name);
          return true;
        },
      },
      {
        provider: scriptedProvider(callScript("search_tool", JSON.stringify({ query: "issue" }))),
        providerId: "s",
        modelId: "m",
        tools: tools(mcp),
        systemInstruction: "sys",
        idSeq,
      },
      history,
      "go",
    );

    expect(asked).toEqual([]);
  });
});

describe("a read-only side worker cannot reach MCP", () => {
  test("use_tool is excluded by the risk==='read' filter that side workers apply", () => {
    // `tui-shell.ts` builds a side-worker tool list with
    // `t.definition.risk === "read"`. If `use_tool` were ever relaxed to
    // `read` to reduce prompting, that worker would gain the ability to call
    // any destructive tool on any connected server.
    const { mcp } = binding([]);
    const readOnly = tools(mcp)
      .filter((tool) => tool.definition.risk === "read")
      .map((tool) => tool.definition.name);

    expect(readOnly).not.toContain("use_tool");
    // search_tool IS read, and that is correct: it reaches nothing.
    expect(readOnly).toContain("search_tool");
  });
});
