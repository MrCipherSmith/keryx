// Metaproject read-only tools for interactive agent mode (flow 035 / SA-01 Flow B).
//
// These give the agent keryx's differentiator — code search, graph blast-radius,
// project memory, whole-graph queries, and wiki pages. Since flow 038 the tools
// are a THIN PROJECTION of the single metaproject-operation descriptor source
// (metaproject-operations.ts): when a `port` is provided the agent sources its
// tools from `toInteractiveTools(METAPROJECT_OPERATIONS, port)`, so adding an
// operation once surfaces it here and in the harness registry.
//
// The subprocess fallback is preserved: when NO `port` is given the tools run
// FIXED keryx read-only subcommands as a subprocess with an ARGV ARRAY (never a
// shell string, so a pattern/file/query argument can never inject a command). And
// even with a port, `search_code` — which has no in-process backing — degrades to
// the subprocess runner rather than surfacing the port's "unavailable" result.

import {
  METAPROJECT_OPERATIONS,
  formatAffected,
  formatMemory,
  toInteractiveTools,
} from "../metaproject-operations";
import type {
  GraphAffectedResult,
  MemorySearchResult,
  MetaprojectPort,
  SearchCodeResult,
} from "../metaproject-port";
import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";

// Re-export the formatters for backward compatibility with existing importers.
export { formatAffected, formatMemory };
export type { GraphAffectedResult, MemorySearchResult };

/** Runs `keryx <args>` and returns the captured output (or an error result). */
export type KeryxRunner = (args: string[]) => Promise<InteractiveToolResult>;

const MAX_OUTPUT_BYTES = 20_000;

/**
 * The default runner: invoke `keryx` via an argv array (NO shell string) from the
 * project root, capturing bounded stdout. Never throws — a failure or a missing
 * binary becomes `{ isError: true }`.
 */
export function makeKeryxRunner(root: string): KeryxRunner {
  return async (args) => {
    try {
      const proc = Bun.spawn(["keryx", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exit = await proc.exited;
      const raw = stdout.trim().length > 0 ? stdout : stderr;
      const bounded =
        raw.length > MAX_OUTPUT_BYTES ? `${raw.slice(0, MAX_OUTPUT_BYTES)}\n…(truncated)` : raw;
      if (exit !== 0 && bounded.trim().length === 0) {
        return { output: `keryx ${args.join(" ")} exited with code ${exit}`, isError: true };
      }
      return { output: bounded.trim().length > 0 ? bounded : "(no output)", isError: exit !== 0 };
    } catch (cause) {
      return {
        output: `keryx is not available: ${cause instanceof Error ? cause.message : String(cause)}`,
        isError: true,
      };
    }
  };
}

/** Require a non-empty string field from a tool input; else an error result. */
function requireString(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): { value: string } | { error: InteractiveToolResult } {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    return { error: { output: `${tool} requires a non-empty '${key}'`, isError: true } };
  }
  return { value };
}

/**
 * Wrap `port` so `searchCode` degrades to the subprocess `run`ner when the port
 * has no in-process backing (an `isError` result). The port is still CONSULTED
 * first (preserving the flow-037 behavior/tests); only a failed port result falls
 * back to `keryx ctx rg <pattern> [path]`. All other methods pass through.
 */
function withSearchFallback(port: MetaprojectPort, run: KeryxRunner): MetaprojectPort {
  return {
    ...port,
    async searchCode(input): Promise<SearchCodeResult> {
      const result = await port.searchCode(input);
      if (!result.isError) {
        return result;
      }
      const args = ["ctx", "rg", input.pattern];
      if (input.path !== undefined) {
        args.push(input.path);
      }
      const fallback = await run(args);
      return {
        pattern: input.pattern,
        ...(input.path !== undefined ? { path: input.path } : {}),
        output: fallback.output,
        isError: fallback.isError,
      };
    },
  };
}

/**
 * The read-only metaproject tools, bound to `root`. `run` defaults to a real keryx
 * subprocess runner and is injectable for deterministic tests. When `port` is
 * provided, the tools are the single-source descriptor projection
 * (`toInteractiveTools(METAPROJECT_OPERATIONS, port)`), with `search_code`
 * degrading to the subprocess runner when the port has no in-process backing.
 * When `port` is omitted, the original three subprocess-backed tools are returned
 * unchanged (backward compatible).
 */
export function builtinMetaprojectTools(
  root: string,
  run: KeryxRunner = makeKeryxRunner(root),
  port?: MetaprojectPort,
): InteractiveTool[] {
  if (port !== undefined) {
    return toInteractiveTools(METAPROJECT_OPERATIONS, withSearchFallback(port, run));
  }

  const searchCode: InteractiveTool = {
    definition: {
      name: "search_code",
      description:
        "Search the project's code/text (compact ripgrep via `keryx ctx rg`). Input: { pattern: string, path?: string } (path relative to the project root).",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const pattern = requireString(input, "pattern", "search_code");
      if ("error" in pattern) {
        return pattern.error;
      }
      const path = typeof input.path === "string" && input.path.length > 0 ? input.path : undefined;
      const args = ["ctx", "rg", pattern.value];
      if (path !== undefined) {
        args.push(path);
      }
      return run(args);
    },
  };

  const graphAffected: InteractiveTool = {
    definition: {
      name: "graph_affected",
      description:
        "Show the blast radius (dependents) of a file via the code graph (`keryx gdgraph affected`). Input: { file: string } relative to the project root.",
      inputSchema: {
        type: "object",
        properties: { file: { type: "string" } },
        required: ["file"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const file = requireString(input, "file", "graph_affected");
      if ("error" in file) {
        return file.error;
      }
      return run(["gdgraph", "affected", file.value]);
    },
  };

  const memorySearch: InteractiveTool = {
    definition: {
      name: "memory_search",
      description:
        "Search project memory — decisions, lessons, constraints (`keryx memory search`). Input: { query: string }.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const query = requireString(input, "query", "memory_search");
      if ("error" in query) {
        return query.error;
      }
      return run(["memory", "search", query.value]);
    },
  };

  return [searchCode, graphAffected, memorySearch];
}
