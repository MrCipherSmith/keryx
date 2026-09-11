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

import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { NormalizedToolDefinition } from "../../provider/types";

/** The content-returning result of an interactive tool invocation. */
export interface InteractiveToolResult {
  output: string;
  isError: boolean;
  /** External content may be shown, but cannot authorize further tools this turn. */
  untrusted?: boolean;
}

/** A tool the interactive agent can offer to the model and execute for content. */
export interface InteractiveTool {
  definition: NormalizedToolDefinition;
  invoke: (input: Record<string, unknown>) => Promise<InteractiveToolResult>;
}

/** Read-file output cap so a tool result stays modest. */
const MAX_READ_BYTES = 20_000;

/**
 * Read up to `cap` characters of `file` starting at 1-based `startLine`.
 *
 * `read_file` used to return the first 20 KB of a file and nothing else — no
 * offset, no range — so content past the head was unreachable however the model
 * asked. The arena's one gold file keryx did name was clipped exactly there.
 * Lines, not bytes, because the line numbers the model holds are the ones
 * `search_code` and `graph_symbol` print.
 *
 * `nextLine` is set when the file continues past what was returned; the text is
 * cut at the last whole line so the continuation starts cleanly.
 */
async function readFromLine(
  file: ReturnType<typeof Bun.file>,
  startLine: number,
  cap: number,
): Promise<{ text: string; nextLine?: number; pastEnd: boolean; lines: number }> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let line = 1;
  let out = "";
  let overflowed = false;
  let sawAny = false;
  let endsWithNewline = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      let text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (text.length > 0) {
        sawAny = true;
        endsWithNewline = text.endsWith("\n");
      }
      if (line < startLine) {
        let from = 0;
        while (line < startLine) {
          const newline = text.indexOf("\n", from);
          if (newline === -1) break;
          from = newline + 1;
          line += 1;
        }
        text = line < startLine ? "" : text.slice(from);
      }
      out += text;
      if (out.length > cap) {
        overflowed = true;
        break;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  // `line` counts newlines + 1, so a file ending in "\n" would read one line longer
  // than it is — and start_line = length + 1 would return nothing instead of saying
  // it was past the end.
  const lines = !sawAny ? 0 : endsWithNewline ? line - 1 : line;
  if (!overflowed && (line < startLine || (out.length === 0 && startLine > lines))) {
    return { text: "", pastEnd: true, lines };
  }
  if (!overflowed) {
    return { text: out, pastEnd: false, lines };
  }
  const kept = out.slice(0, cap);
  const lastBreak = kept.lastIndexOf("\n");
  const body = lastBreak >= 0 ? kept.slice(0, lastBreak + 1) : kept;
  const shownLines = (body.match(/\n/g) ?? []).length;
  return { text: body, nextLine: startLine + shownLines, pastEnd: false, lines: line };
}

/**
 * Resolve `candidate` (relative to `root`) and confine it to `root`. Returns the
 * absolute path, or `null` when it escapes.
 *
 * The check is on the REAL path. A purely lexical comparison — which this was —
 * is satisfied by a symlink inside the root that points outside it, and then
 * reads the target anyway. It is also segment-wise, so an in-project file named
 * `..hidden.ts` is not mistaken for a traversal.
 *
 * A path that does not exist yet is still checked lexically and allowed if it
 * would land inside the root; callers surface their own not-found error.
 */
export function confineToRoot(root: string, candidate: string | undefined): string | null {
  const rootReal = realpathOr(root);
  const target = resolve(rootReal, candidate ?? ".");
  const effective = realpathOr(target);

  if (effective === rootReal) {
    return rootReal; // the root itself
  }
  const rel = relative(rootReal, effective);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return null; // escapes the root
  }
  return effective;
}

/** Real path when it resolves, the lexical path otherwise (target may not exist yet). */
function realpathOr(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return resolve(candidate);
  }
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
      description:
        "Read a UTF-8 text file inside the project. Input: { path: string, start_line?: number } — path " +
        "relative to the project root, start_line 1-based (default 1). Returns at most " +
        `${MAX_READ_BYTES} characters from start_line. When the file continues past that, the output ends ` +
        "with a notice naming the start_line to read the next part from — use it to page through a large " +
        "file, or jump straight to a line that search_code or graph_symbol reported.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 } },
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
      const startLine = input.start_line ?? 1;
      if (typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1) {
        return { output: "read_file: start_line must be a positive integer", isError: true };
      }
      const target = confineToRoot(root, requested);
      if (target === null) {
        return { output: `path escapes the project root: ${requested}`, isError: true };
      }
      try {
        const file = Bun.file(target);
        const size = file.size;
        if (startLine === 1 && size <= MAX_READ_BYTES) {
          return { output: await file.text(), isError: false };
        }
        // Streamed, never loaded whole: the model can issue this freely and in
        // parallel, and reading a 256 MiB file to return 20 KB of it cost 256 MiB
        // of RSS once (stress findings T1/L3). The stream is cancelled as soon as
        // the cap is filled.
        const part = await readFromLine(file, startLine, MAX_READ_BYTES);
        if (part.pastEnd) {
          return {
            output: `read_file: start_line ${startLine} is past the end of the file (it has ${part.lines} lines)`,
            isError: true,
          };
        }
        if (part.nextLine === undefined) {
          return { output: part.text, isError: false };
        }
        // Lines, not a byte count: "read 19,990 of 100,000 bytes" at start_line 1500
        // compared characters from that line with the whole file's bytes, and told
        // the model something false about how much was left.
        const notice =
          part.nextLine > startLine
            ? `truncated: showed lines ${startLine}–${part.nextLine - 1} of a ${size}-byte file; continue with start_line: ${part.nextLine}`
            : `truncated: line ${startLine} alone is longer than ${MAX_READ_BYTES} characters, in a ${size}-byte file — search_code finds text inside it`;
        return { output: `${part.text}\n…(${notice})`, isError: false };
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
