// `search_tool` and `use_tool`: the STABLE pair the model sees.
//
// P0 item 5. The shape this package specifies, and the shape it refuses:
// keryx does not register every connected MCP tool on the provider's tool
// list. That is OpenCode's design, and it grows the advertised surface with
// every server an operator adds — the model pays for all of it on every turn,
// forever, whether or not it uses any. Two tools of fixed cost replace N of
// unbounded cost.
//
// The consequence to keep in view: the model cannot see a tool it has not
// searched for. That is the trade, and `search_tool`'s output is what makes
// it workable.

import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import type { ServerCatalog } from "./catalog";
import { resolveFqn } from "./catalog";
import type { ServerState } from "./manager";

/**
 * Result cap, in bytes, before truncation.
 *
 * Grok's default. Named and exported because the test asserts the constant
 * itself: a cap silently raised is a cap that stops capping, and a test that
 * hardcodes its own number would keep passing while the real one drifted.
 */
export const MAX_TOOL_RESULT_BYTES = 20_000;

/** How many hits `search_tool` returns. Bounded for the same reason the pair exists. */
export const MAX_SEARCH_RESULTS = 20;

/**
 * Verbs that mean a tool changes something.
 *
 * Used only to REFUSE a read classification, never to grant one. See
 * {@link classifyToolRisk}.
 */
const WRITE_VERBS = [
  "write", "create", "update", "delete", "remove", "insert", "patch", "put",
  "post", "modify", "edit", "send", "publish", "deploy", "merge", "push",
  "close", "archive", "rename", "move", "set", "add", "drop", "execute", "run",
];

/**
 * Read or destructive, and destructive whenever it is not clearly read.
 *
 * `read` requires BOTH halves the specification names: the tool's own schema
 * annotates it read-only, AND neither its name nor its description matches a
 * write verb. Anything else — including a tool that says nothing about itself
 * — is `destructive`.
 *
 * This is a fail-closed default, not a belief that MCP servers annotate
 * honestly. An unannotated tool is the common case, and treating "did not
 * say" as "safe" would route the majority of third-party tools around the
 * approval prompt.
 */
export function classifyToolRisk(entry: {
  readonly rawName: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
}): "read" | "destructive" {
  const annotations = entry.inputSchema?.annotations;
  const readOnlyHint =
    typeof annotations === "object" && annotations !== null
      ? (annotations as { readOnlyHint?: unknown }).readOnlyHint
      : undefined;
  if (readOnlyHint !== true) {
    return "destructive";
  }

  const haystack = `${entry.rawName} ${entry.description ?? ""}`.toLowerCase();
  // The annotation claims read-only; the name still gets a vote, because a
  // server that annotates `delete_issue` read-only is either wrong or lying
  // and the outcome is the same either way.
  return WRITE_VERBS.some((verb) => haystack.includes(verb)) ? "destructive" : "read";
}

/** Truncate to the cap, and say so in the output rather than trailing off. */
export function truncateResult(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_TOOL_RESULT_BYTES) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf8").subarray(0, MAX_TOOL_RESULT_BYTES).toString("utf8");
  return {
    text: `${clipped}\n\n[truncated at ${MAX_TOOL_RESULT_BYTES} bytes]`,
    truncated: true,
  };
}

export type SearchHit = {
  readonly tool_name: string;
  readonly server: string;
  readonly description?: string | undefined;
};

/** Rank catalog entries against a free-text query, by name, server and description. */
export function searchCatalog(catalog: ServerCatalog, query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return [];
  }

  const scored = catalog.entries
    .map((entry) => {
      const name = entry.fqn.toLowerCase();
      const description = (entry.description ?? "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        // A name hit outranks a description hit: the model asked for a tool,
        // and prose mentioning the word is weaker evidence than a name
        // containing it.
        if (name.includes(term)) score += 3;
        else if (entry.server.toLowerCase().includes(term)) score += 2;
        else if (description.includes(term)) score += 1;
      }
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.fqn.localeCompare(b.entry.fqn))
    .slice(0, MAX_SEARCH_RESULTS);

  return scored.map(({ entry }) => ({
    tool_name: entry.fqn,
    server: entry.server,
    description: entry.description,
  }));
}

export type McpToolDeps = {
  /** Read at call time, so a server connecting later is visible without rebuilding the pair. */
  readonly catalog: () => ServerCatalog;
  readonly servers: () => readonly ServerState[];
  /** Per-tool timeout from config, in seconds. */
  readonly toolTimeoutSec?: (server: string, rawName: string) => number | undefined;
};

/**
 * The two tools, built once and stable for the session.
 *
 * `catalog` is a function rather than a value: servers connect in the
 * background, and a pair built from a snapshot would advertise an empty
 * catalog forever if it happened to be constructed first.
 */
export function createMcpInteractiveTools(deps: McpToolDeps): InteractiveTool[] {
  const searchTool: InteractiveTool = {
    definition: {
      name: "search_tool",
      description:
        "Search the connected MCP servers for a tool. Returns qualified tool names to pass to use_tool.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", minLength: 1 } },
      },
      risk: "read",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const query = typeof input.query === "string" ? input.query : "";
      if (query.trim() === "") {
        return { output: "search_tool requires a non-empty query.", isError: true };
      }
      const hits = searchCatalog(deps.catalog(), query);
      if (hits.length === 0) {
        // Say what WAS searched. "No results" over an empty catalog and no
        // results over a full one are different facts, and the operator can
        // act on only one of them.
        const connected = deps.servers().filter((s) => s.status === "connected").length;
        const total = deps.catalog().entries.length;
        return {
          output: `No MCP tool matched "${query}". ${total} tool(s) across ${connected} connected server(s).`,
          isError: false,
        };
      }
      return { output: JSON.stringify(hits, null, 2), isError: false };
    },
  };

  const useTool: InteractiveTool = {
    definition: {
      name: "use_tool",
      description: "Call an MCP tool by its qualified name, as returned by search_tool.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tool_name", "tool_input"],
        properties: {
          tool_name: { type: "string", minLength: 1 },
          tool_input: { type: "object" },
        },
      },
      // The advertised risk is the worst case, because one definition covers
      // every MCP tool. The per-call classification is what the approval
      // prompt actually consults.
      risk: "destructive",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const fqn = typeof input.tool_name === "string" ? input.tool_name : "";
      const entry = resolveFqn(deps.catalog(), fqn);
      if (entry === undefined) {
        return {
          output: `No connected MCP tool named "${fqn}". Use search_tool to find one.`,
          isError: true,
        };
      }

      const state = deps.servers().find((s) => s.name === entry.server);
      const connection = state?.connection;
      if (connection === undefined) {
        return {
          output: `Server "${entry.server}" is not connected (${state?.status ?? "unknown"}).`,
          isError: true,
        };
      }

      const args =
        typeof input.tool_input === "object" && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : {};
      const timeoutSec = deps.toolTimeoutSec?.(entry.server, entry.rawName);

      // The RAW name, not the FQN: the qualified name is keryx's, and the
      // server has never heard of it.
      const outcome = await connection.callTool(entry.rawName, args, {
        ...(timeoutSec === undefined ? {} : { timeoutMs: timeoutSec * 1000 }),
      });

      if (outcome.kind === "timeout") {
        return { output: `MCP tool "${fqn}" timed out.`, isError: true };
      }
      if (outcome.kind === "error") {
        return { output: `MCP tool "${fqn}" failed: ${outcome.message}`, isError: true };
      }

      const { text } = truncateResult(JSON.stringify(outcome.result.content ?? [], null, 2));
      return {
        output: text,
        isError: outcome.result.isError,
        // Everything here came from a third-party server. It may be shown and
        // must not be able to authorize further tools this turn.
        untrusted: true,
      };
    },
  };

  return [searchTool, useTool];
}
