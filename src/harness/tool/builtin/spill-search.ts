// Flow 387 T14 (SECURITY BOUNDARY): let `search_code` search the live session's
// spilled tool output, and nothing else outside the project root.
//
// `search_code` has three backings (the in-process port, its subprocess fallback,
// and the port-less subprocess tool), each confining `path` to the project root.
// Rather than widen all three, the interactive roster wraps the tool once: an
// ABSOLUTE `path` that `resolveSpillReadable` accepts (realpath inside
// `<sessionDir>/tool-output`) is searched here with a fixed ripgrep argv; every
// other input is passed to the wrapped tool untouched, so its confinement is
// exactly what it was.

import { resolveSpillReadable } from "../output-spill";
import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";

/** Same bound the project search uses. */
const MAX_SPILL_SEARCH_CHARS = 20_000;

/** Run ripgrep with a fixed argv; injectable so tests need no ripgrep. */
export type SpillRipgrep = (argv: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultRipgrep: SpillRipgrep = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

async function searchSpill(pattern: string, target: string, run: SpillRipgrep): Promise<InteractiveToolResult> {
  // Fixed argv, pattern after `--`: a model-supplied pattern can never be re-parsed
  // as an option. No `--follow`, so a link met inside the directory is not walked.
  const argv = [
    "rg",
    "--with-filename",
    "--line-number",
    "--column",
    "--no-heading",
    "--max-columns=400",
    "--max-columns-preview",
    "--",
    pattern,
    target,
  ];
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await run(argv, target);
  } catch (cause) {
    return { output: `search_code failed: ${cause instanceof Error ? cause.message : String(cause)}`, isError: true };
  }
  if (result.exitCode === 1 && result.stdout.trim().length === 0) {
    return { output: `No matches for ${JSON.stringify(pattern)} under ${target}.`, isError: false };
  }
  if (result.exitCode > 1) {
    const detail = result.stderr.trim() || result.stdout.trim() || "(no diagnostic)";
    return { output: `search_code failed (rg exit ${result.exitCode}): ${detail}`, isError: true };
  }
  const raw = result.stdout.trimEnd();
  if (raw.length <= MAX_SPILL_SEARCH_CHARS) {
    return { output: raw, isError: false };
  }
  const kept = raw.slice(0, MAX_SPILL_SEARCH_CHARS);
  const cut = kept.lastIndexOf("\n");
  return {
    output: `${cut > 0 ? kept.slice(0, cut) : kept}\n…(truncated — narrow the pattern)`,
    isError: false,
  };
}

/**
 * Wrap a `search_code` tool so an absolute path inside the live session's
 * spilled-output directory is searchable. Any other tool is returned as is.
 */
export function withSpillSearch(
  tool: InteractiveTool,
  getSessionDir: () => string | undefined,
  run: SpillRipgrep = defaultRipgrep,
): InteractiveTool {
  if (tool.definition.name !== "search_code") {
    return tool;
  }
  return {
    ...tool,
    invoke: async (input, ctx) => {
      const requested = typeof input.path === "string" ? input.path : "";
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const spill = pattern.length > 0 ? resolveSpillReadable(getSessionDir(), requested) : null;
      if (spill === null) {
        return tool.invoke(input, ctx);
      }
      return searchSpill(pattern, spill, run);
    },
  };
}
