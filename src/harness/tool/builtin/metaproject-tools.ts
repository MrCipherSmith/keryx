// Metaproject read-only tools for interactive agent mode (flow 035 / SA-01 Flow B).
//
// These give the agent keryx's differentiator — code search, graph blast-radius,
// and project memory — by running FIXED keryx read-only subcommands as a
// subprocess with an ARGV ARRAY (never a shell string, so a pattern/file/query
// argument can never inject a command). The command (`keryx`) and subcommand are
// fixed; the model supplies only arguments. Risk is `read` (constrained-read),
// auto-allowed by the flow-033 gate. The runner is injectable so tests are
// deterministic (no real subprocess).

import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";

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
 * The three read-only metaproject tools, bound to `root`. `run` defaults to a real
 * keryx subprocess runner and is injectable for deterministic tests.
 */
export function builtinMetaprojectTools(root: string, run: KeryxRunner = makeKeryxRunner(root)): InteractiveTool[] {
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
      const args = ["ctx", "rg", pattern.value];
      if (typeof input.path === "string" && input.path.length > 0) {
        args.push(input.path);
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
      return "error" in file ? file.error : run(["gdgraph", "affected", file.value]);
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
      return "error" in query ? query.error : run(["memory", "search", query.value]);
    },
  };

  return [searchCode, graphAffected, memorySearch];
}
