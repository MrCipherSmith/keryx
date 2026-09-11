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
 * ADVISORY, NOT A GATE. What actually gates an MCP call is `use_tool`'s
 * static `risk: "destructive"` going through the agent's own approval branch
 * in `agent.ts` — the same one `shell_exec` and `apply_patch` go through.
 * D-05 is explicit that there is to be no fourth decision layer, and an
 * in-tool gate on top of the agent's would both duplicate the policy and
 * prompt the operator twice for one call.
 *
 * It is advisory for a second reason worth stating plainly: the `read` half
 * of this judgement rests on `readOnlyHint`, which is the THIRD-PARTY SERVER
 * asserting its own safety. Letting that assertion skip a prompt is exactly
 * the pattern ADR-0009 forbids — "a 'safe' verdict from an incomplete list
 * must never read as a grant". So the verdict is shown to the model in
 * `search_tool` output, where it helps it choose, and is never allowed to
 * decide anything.
 *
 * `read` still requires BOTH halves the specification names — annotated
 * read-only AND no write verb in the name or description — so the advice
 * errs the same direction the gate does.
 */
export function classifyToolRisk(entry: {
  readonly rawName: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly annotations?: Record<string, unknown> | undefined;
}): "read" | "destructive" {
  // `annotations` is a sibling of `inputSchema` on `Tool`. This used to read
  // `inputSchema.annotations`, which the protocol never populates — so no
  // real server could ever be classified `read`, and the only way to get
  // that verdict was to nest the field where the spec says it does not go.
  // A hostile server could do exactly that; an honest one could not.
  const annotations = entry.annotations;
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

/**
 * Strip what a third-party server should not be able to draw.
 *
 * P0 closed this for stdio by piping the child's stderr, with a comment
 * about a forged `✓ auto-approved shell: …` line painted into the TUI
 * transcript. The HTTP transport reopened it: the SDK embeds an error
 * response body verbatim in its message, and that message reaches
 * `doctor` output and the model. Same attack, remote, with no process to
 * spawn.
 *
 * Escapes are replaced rather than dropped so the text still reads and the
 * tampering is visible.
 *
 * `\n` is KEPT — a multi-line error message is legitimate, and flattening
 * every honest one to defuse a hostile one is the wrong trade. `\r` is NOT
 * kept, though the original range spared it alongside `\n`: a lone carriage
 * return is most of the attack by itself. It puts the cursor back at column
 * 0, so `real error\r\u2713 auto-approved` overwrites the real line with
 * the forged one and leaves nothing on screen to show that it did — no
 * escape sequence required. "It is only whitespace" holds for `\n` and not
 * for `\r`.
 */
export function sanitiseForDisplay(text: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters ARE the thing being removed
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "\uFFFD");
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
  /**
   * The advisory classification (see {@link classifyToolRisk}), shown so the
   * model can prefer a read tool when either would do and can expect a
   * prompt when it picks the other. It decides nothing.
   */
  readonly risk: "read" | "destructive";
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
    risk: classifyToolRisk(entry),
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
      // UNTRUSTED, even though this reads a local catalog and touches no
      // network. Every `description` in a hit was written by the third-party
      // server and copied verbatim from its `tools/list`. `search_tool` is
      // `risk: "read"`, so it is auto-approved — without this flag a server
      // could put a paragraph of instructions in a tool description and have
      // the model read it with no prompt and no provenance marker at all.
      // Capped like `use_tool`'s. Twenty hits with long descriptions
      // measured at twice the cap `use_tool` enforces, and the
      // descriptions are the server's own text.
      const { text } = truncateResult(JSON.stringify(hits, null, 2));
      return { output: text, isError: false, untrusted: true };
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
      // `destructive`, always, and this is load-bearing twice over.
      //
      // It is what routes every MCP call into the agent's own approval
      // branch, which is fail-closed when there is no approver and still
      // asks under `trust` — the whole of AC7, satisfied by the gate keryx
      // already hardened rather than by a second one here (D-05).
      //
      // It is ALSO what keeps `use_tool` out of a read-only side worker:
      // `tui-shell.ts` filters that tool list by `risk === "read"`, so
      // relaxing this to get fewer prompts would hand every third-party MCP
      // tool to a worker that is supposed to be unable to change anything.
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

      // No approval check here, deliberately. By the time `invoke` runs,
      // `agent.ts` has already put this call through `resolveApprovalDecision`
      // and `requestApproval` on the strength of the `destructive` risk
      // above. Asking again would be D-05's forbidden fourth layer and a
      // second prompt for one action.

      const timeoutSec = deps.toolTimeoutSec?.(entry.server, entry.rawName);

      // The RAW name, not the FQN: the qualified name is keryx's, and the
      // server has never heard of it.
      const outcome = await connection.callTool(entry.rawName, args, {
        ...(timeoutSec === undefined ? {} : { timeoutMs: timeoutSec * 1000 }),
      });

      if (outcome.kind === "timeout") {
        return { output: `MCP tool "${fqn}" timed out.`, isError: true, untrusted: true };
      }
      if (outcome.kind === "error") {
        // `outcome.message` is the server's own text, and for the HTTP
        // transport the SDK embeds the WHOLE error-response body in it. A
        // 400 with a 1 MB body produced a one-million-character tool
        // output — uncapped, because only the success branch was capped.
        // And an error is not a reason to stop treating it as
        // third-party content.
        const { text } = truncateResult(sanitiseForDisplay(outcome.message));
        return { output: `MCP tool "${fqn}" failed: ${text}`, isError: true, untrusted: true };
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
