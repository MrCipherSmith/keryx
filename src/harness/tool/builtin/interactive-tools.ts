// Read-only builtin tools for interactive agent mode (flow 033 / SA-01 Flow A).
//
// The durable `ToolExecutorPort.invoke` returns a HASHED receipt (`ToolResult`
// with `outputHash`, not content) — it cannot feed content back to a live model.
// So agent mode uses this lightweight, content-returning tool layer instead: it
// reuses the neutral `NormalizedToolDefinition` shape (name + description + JSON
// `inputSchema` + `risk`) and the `ToolRisk` classes, but its executor returns
// the actual output text the model needs.
//
// Every tool here is risk `read` and is CONFINED to the project root: a path that
// resolves outside the root (via `..` or an absolute escape) is rejected and
// nothing outside the root is ever read.

import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { NormalizedToolDefinition } from "../../provider/types";

/** The content-returning result of an interactive tool invocation. */
export interface InteractiveToolResult {
  output: string;
  isError: boolean;
}

/** A tool the interactive agent can offer to the model and execute for content. */
export interface InteractiveTool {
  definition: NormalizedToolDefinition;
  invoke: (input: Record<string, unknown>) => Promise<InteractiveToolResult>;
}

/** Read-file output cap so a tool result stays modest. */
const MAX_READ_BYTES = 20_000;

/**
 * Resolve `candidate` (relative to `root`) and confine it to `root`. Returns the
 * absolute path, or `null` when it escapes (via `..` or an absolute path).
 */
export function confineToRoot(root: string, candidate: string | undefined): string | null {
  const target = resolve(root, candidate ?? ".");
  const rel = relative(root, target);
  if (rel === "") {
    return root; // the root itself
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null; // escapes the root
  }
  return target;
}

/** The three read-only builtin tools, bound to `root` (the project root). */
export function builtinReadOnlyTools(root: string): InteractiveTool[] {
  const getCwd: InteractiveTool = {
    definition: {
      name: "get_cwd",
      description: "Return the current working directory (the project root).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async () => ({ output: root, isError: false }),
  };

  const listDir: InteractiveTool = {
    definition: {
      name: "list_dir",
      description:
        "List the entries of a directory inside the project. Input: { path?: string } relative to the project root (default '.').",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const requested = typeof input.path === "string" ? input.path : ".";
      const target = confineToRoot(root, requested);
      if (target === null) {
        return { output: `path escapes the project root: ${requested}`, isError: true };
      }
      try {
        const entries = await readdir(target, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return { output: lines.length > 0 ? lines.join("\n") : "(empty)", isError: false };
      } catch (cause) {
        return {
          output: `list_dir failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        };
      }
    },
  };

  const readFileTool: InteractiveTool = {
    definition: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the project. Input: { path: string } relative to the project root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const requested = typeof input.path === "string" ? input.path : "";
      if (requested.length === 0) {
        return { output: "read_file requires a non-empty 'path'", isError: true };
      }
      const target = confineToRoot(root, requested);
      if (target === null) {
        return { output: `path escapes the project root: ${requested}`, isError: true };
      }
      try {
        // Read AT MOST the cap. The previous implementation read the whole file
        // and then sliced, so returning 20 KB of a 256 MiB file cost 256 MiB of
        // RSS — and the model can issue this call freely, in parallel (stress
        // findings T1/L3). `Bun.file().slice()` is a lazy byte range: nothing
        // outside it is ever read.
        const file = Bun.file(target);
        const size = file.size;
        if (size > MAX_READ_BYTES) {
          const head = await file.slice(0, MAX_READ_BYTES).text();
          return {
            output: `${head}\n…(truncated: read ${MAX_READ_BYTES} of ${size} bytes)`,
            isError: false,
          };
        }
        return { output: await file.text(), isError: false };
      } catch (cause) {
        return {
          output: `read_file failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        };
      }
    },
  };

  return [getCwd, listDir, readFileTool];
}
