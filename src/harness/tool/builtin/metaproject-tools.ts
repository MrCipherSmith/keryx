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
import { checkSearchToolOption, SEARCH_TOOL_FORCED_OPTIONS } from "../../../lib/rg-options";
import { confineToRoot } from "./interactive-tools";
import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";

// Re-export the formatters for backward compatibility with existing importers.
export { formatAffected, formatMemory };
export type { GraphAffectedResult, MemorySearchResult };

/** Runs `keryx <args>` and returns the captured output (or an error result). */
export type KeryxRunner = (args: string[]) => Promise<InteractiveToolResult>;

const MAX_OUTPUT_BYTES = 20_000;

/**
 * `memory_search` filter properties → the `keryx memory search` flag that carries
 * them, for the subprocess fallback. Kept beside the descriptor's `cliParity`
 * declaration in metaproject-operations.ts, which the parity test enforces.
 */
const MEMORY_SEARCH_VALUE_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["--module", "module"],
  ["--entity", "entity"],
  ["--status", "status"],
  ["--class", "class"],
  ["--limit", "limit"],
  ["--as-of", "asOf"],
];

/**
 * Signature of "ripgrep is unavailable" across the paths it can surface on: the
 * bare `Bun.spawn` throw (`Executable not found in $PATH: "rg"`), a generic
 * ENOENT, and the graceful `keryx ctx rg` exit message (see `MISSING_RG_MESSAGE`
 * in commands/ctx.ts). Matched only against ALREADY-failing results, so a normal
 * search result that merely contains "not found" is never rewritten.
 */
const RG_UNAVAILABLE_SIGNATURE =
  /ripgrep \(rg\) is not installed|Executable not found[^\n]*\brg\b|\brg\b[^\n]*\bENOENT\b|\bENOENT\b[^\n]*\brg\b/i;

/**
 * The model-facing diagnosis when `search_code` cannot run because ripgrep is
 * missing. Unlike the CLI message it names the *tools* the model can fall back
 * to, so the model changes approach instead of hammering a dead tool.
 */
export const SEARCH_CODE_RG_UNAVAILABLE_MESSAGE =
  "ripgrep (rg) is not installed or not on PATH, and search_code needs it. Install it " +
  "(`brew install ripgrep` / `apt install ripgrep`), or use read_file and list_dir to " +
  "inspect files directly instead of retrying search_code.";

/**
 * The option name in a `keryx ctx rg` refusal, e.g. `--no-follow` out of
 * "unsupported ripgrep option --no-follow. Only a reviewed set …".
 */
const CLI_REJECTED_OPTION = /unsupported ripgrep option\s+(--?[\w-]+)/i;

/**
 * The model- and operator-facing diagnosis when the `keryx` on PATH is older than
 * the checkout that built this tool.
 *
 * `search_code` runs `keryx ctx rg` as a SUBPROCESS, resolved from PATH — so the
 * confinement argv it assembles is handed to a binary whose accepted-option table
 * may be a different vintage. `--no-follow` is only forwarded from `377fc325`
 * onward, so against an older install EVERY search fails, including a benign
 * in-root one. Measured: global keryx 0.2.9 refuses it, the 0.2.16 checkout
 * returns matches for the same call.
 *
 * That matters most exactly where this is least likely to be noticed — an
 * unattended run in CI, where the installed binary and the checkout routinely
 * differ, `search_code` is one of only two general read tools, and there is no
 * `shell_exec` to fall back to and no human watching. So the failure is rewritten
 * into something that says what broke and what to do about it, rather than a
 * ripgrep-option message that reads like the model passed a bad flag.
 */
export function searchCliSkewMessage(option: string): string {
  return (
    `search_code cannot run here: the \`keryx\` on PATH refused \`${option}\`, an option this ` +
    "tool adds to every search to keep it inside the project. The installed `keryx` is older " +
    "than the one this project expects, so the CLI and the tool no longer agree on what may be " +
    "forwarded. Fix it by updating the installed keryx to at least the version of this checkout. " +
    "Until then every search_code call will fail the same way — use read_file and list_dir to " +
    "inspect files directly instead of retrying it."
  );
}

/**
 * Rewrite a failed `search_code` result into an actionable diagnosis where one
 * applies; pass anything else through unchanged. Only error results are
 * inspected, so successful searches are untouched.
 *
 * Two conditions are rewritten, and the second is deliberately narrow. A refusal
 * is treated as version skew ONLY when the option the CLI named is one this tool
 * FORCED — a fact the tool holds ({@link SEARCH_TOOL_FORCED_OPTIONS}) rather than
 * a guess about CLI versions. A refusal of a CALLER-supplied option is left
 * alone: the CLI's own message already names the option the caller passed and is
 * the right thing to show, and rewriting it would hide a real input error behind
 * an environment story.
 */
export function normalizeSearchResult(result: InteractiveToolResult): InteractiveToolResult {
  if (!result.isError) {
    return result;
  }
  if (RG_UNAVAILABLE_SIGNATURE.test(result.output)) {
    return { output: SEARCH_CODE_RG_UNAVAILABLE_MESSAGE, isError: true };
  }
  const option = CLI_REJECTED_OPTION.exec(result.output)?.[1];
  if (option !== undefined && SEARCH_TOOL_FORCED_OPTIONS.includes(option)) {
    return { output: searchCliSkewMessage(option), isError: true };
  }
  return result;
}

/**
 * The default runner: invoke `keryx` via an argv array (NO shell string) from the
 * project root, capturing bounded stdout. Never throws — a failure or a missing
 * binary becomes `{ isError: true }`.
 */
export function makeKeryxRunner(root: string): KeryxRunner {
  return async (args) => {
    try {
      // `env` is passed EXPLICITLY, and it is not decoration. Without it
      // `Bun.spawn` resolves the executable against a snapshot of `PATH` taken
      // when the process started, so a later change to `process.env.PATH` is
      // ignored and the binary that runs is whatever was first on PATH at
      // launch. Measured while writing the real-chain test: with a shim first on
      // the mutated PATH, the no-`env` form still ran the global install.
      //
      // That made the version-skew failure untestable in-process — and a test
      // that cannot put a known `keryx` on PATH is a test that silently measures
      // the developer's global install instead of the chain it claims to cover.
      const proc = Bun.spawn(["keryx", ...args], {
        cwd: root,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
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
 * Build the `keryx ctx rg` argv for `search_code` so that EVERY positional
 * operand is a root-confined path.
 *
 * The shape is the fix. Passing the pattern as an operand meant the operand's
 * meaning depended on the flags beside it: with `-e <expr>` the pattern slot
 * becomes a path, and a review used that to read `~/.aws/credentials` through a
 * `risk: "read"` tool that never reaches an approver. Confining `input.path`
 * could not help, because the leak did not travel through `input.path`.
 *
 * So the pattern always goes in as `--regexp=<pattern>` — one token, inline, so
 * it cannot be re-parsed as an option and cannot be mistaken for a path — and
 * the operand list is exactly one confined directory or file. There is no
 * operand left whose meaning could shift.
 *
 * Exported for the tests that hold this property.
 */
export function buildSearchArgv(input: {
  root: string;
  pattern: string;
  path?: string | undefined;
  flags?: readonly string[] | undefined;
}): { ok: true; args: string[] } | { ok: false; reason: string } {
  const flags: string[] = [];
  const supplied = input.flags ?? [];
  let index = 0;
  while (index < supplied.length) {
    const token = supplied[index] ?? "";
    if (!token.startsWith("-")) {
      return {
        ok: false,
        reason:
          `search_code: "${token}" is not a ripgrep option. Put the search text in \`pattern\` ` +
          "and the target in `path`; `flags` carries options only.",
      };
    }
    const check = checkSearchToolOption(token);
    if (!check.ok) {
      return { ok: false, reason: `search_code: ${check.reason}` };
    }
    flags.push(token);
    if (!check.consumesValue) {
      index += 1;
      continue;
    }
    const value = supplied[index + 1];
    if (value === undefined) {
      return { ok: false, reason: `search_code: ${token} needs a value.` };
    }
    // The CLI's own rule: a dash-leading value in a separate token can be
    // re-parsed as an option by some ripgrep builds.
    if (value.startsWith("-") && value !== "-") {
      return {
        ok: false,
        reason:
          `search_code: the value for ${token} may not start with a dash (${value}). ` +
          `Use the inline form instead: ${token}=${value}.`,
      };
    }
    flags.push(value);
    index += 2;
  }

  // The ONE operand, always a path, always confined. `.` (the project root) when
  // the caller named no target — the same scope `rg` searches by default.
  let operand = ".";
  if (input.path !== undefined && input.path.length > 0) {
    const confined = confineToRoot(input.root, input.path);
    if (confined === null) {
      return { ok: false, reason: `search_code: path escapes the project root: ${input.path}` };
    }
    operand = confined;
  }

  // `--no-follow` goes AFTER the caller's flags and before the pattern, so it is
  // the last occurrence and ripgrep resolves it last. Confining the operand
  // stops the tool being pointed outside the root; this stops it walking outside
  // the root from inside, which a symlink in `node_modules`, a pnpm/bun store or
  // a monorepo link makes an ordinary situation rather than an exotic one.
  return {
    ok: true,
    args: [
      "ctx",
      "rg",
      ...flags,
      ...SEARCH_TOOL_FORCED_OPTIONS,
      `--regexp=${input.pattern}`,
      operand,
    ],
  };
}

/**
 * Wrap `port` so `searchCode` degrades to the subprocess `run`ner when the port
 * has no in-process backing (an `isError` result). The port is still CONSULTED
 * first (preserving the flow-037 behavior/tests); only a failed port result falls
 * back to `keryx ctx rg <pattern> [path]`. All other methods pass through.
 */
function withSearchFallback(port: MetaprojectPort, run: KeryxRunner, root: string): MetaprojectPort {
  return {
    ...port,
    async searchCode(input): Promise<SearchCodeResult> {
      const result = await port.searchCode(input);
      if (!result.isError) {
        return result;
      }
      // The SAME builder the no-port branch uses. This fallback is reachable
      // from the model whenever the port has no in-process backing, so a second,
      // laxer assembly here would simply be the hole on the other branch.
      const built = buildSearchArgv({
        root,
        pattern: input.pattern,
        path: input.path,
        flags: input.flags,
      });
      if (!built.ok) {
        return {
          pattern: input.pattern,
          ...(input.path !== undefined ? { path: input.path } : {}),
          output: built.reason,
          isError: true,
        };
      }
      const normalized = normalizeSearchResult(await run(built.args));
      return {
        pattern: input.pattern,
        ...(input.path !== undefined ? { path: input.path } : {}),
        output: normalized.output,
        isError: normalized.isError,
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
    return toInteractiveTools(METAPROJECT_OPERATIONS, withSearchFallback(port, run, root));
  }

  const searchOp = METAPROJECT_OPERATIONS.find((op) => op.name === "search_code");

  const searchCode: InteractiveTool = {
    definition: {
      name: "search_code",
      description:
        searchOp?.description ?? "Search the project's code/text (compact ripgrep via `keryx ctx rg`).",
      inputSchema: searchOp?.inputSchema ?? {
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
      const rawFlags = input.flags;
      const flags = Array.isArray(rawFlags)
        ? rawFlags.filter((flag): flag is string => typeof flag === "string" && flag.length > 0)
        : [];
      // Validated and assembled by the shared builder. This branch used to
      // forward `flags` verbatim on the reasoning that `keryx ctx rg` refuses an
      // unknown option anyway — which was true and beside the point: the options
      // that matter here are ones the CLI DOES accept, and they change what the
      // operands mean. "The next layer will catch it" is how the layer that
      // could not catch it got skipped.
      const built = buildSearchArgv({ root, pattern: pattern.value, path, flags });
      if (!built.ok) {
        return { output: built.reason, isError: true };
      }
      return normalizeSearchResult(await run(built.args));
    },
  };

  // Parity with the descriptor projection (tool-surface.md §P4.1): the
  // subprocess fallback advertises and forwards the SAME arguments the port-backed
  // tool takes. A fallback that could only ask for depth 1 would send the model
  // back to `shell_exec("keryx gdgraph affected … --depth 2")` — the exact path
  // benchmark case A1 recorded, just on the other branch of this function.
  const affectedOp = METAPROJECT_OPERATIONS.find((op) => op.name === "graph_affected");
  const memoryOp = METAPROJECT_OPERATIONS.find((op) => op.name === "memory_search");

  const graphAffected: InteractiveTool = {
    definition: {
      name: "graph_affected",
      description: affectedOp?.description ?? "Show the blast radius (dependents) of a file via the code graph.",
      inputSchema: affectedOp?.inputSchema ?? {
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
      const args = ["gdgraph", "affected", file.value];
      const depth = input.depth;
      if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) {
        args.push("--depth", String(Math.floor(depth)));
      }
      if (input.ranked === true) {
        args.push("--ranked");
      }
      return run(args);
    },
  };

  const memorySearch: InteractiveTool = {
    definition: {
      name: "memory_search",
      description: memoryOp?.description ?? "Search project memory — decisions, lessons, constraints.",
      inputSchema: memoryOp?.inputSchema ?? {
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
      const args = ["memory", "search", query.value];
      for (const [flag, key] of MEMORY_SEARCH_VALUE_FLAGS) {
        const value = input[key];
        if (typeof value === "string" && value.length > 0) {
          args.push(flag, value);
        } else if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          args.push(flag, String(Math.floor(value)));
        }
      }
      if (input.semantic === true) {
        args.push("--semantic");
      }
      return run(args);
    },
  };

  return [searchCode, graphAffected, memorySearch];
}
