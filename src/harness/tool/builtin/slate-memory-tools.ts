// Flow 393: the model-facing half of "slate as working memory".
//
//   slate_note      write/replace/delete one Note (the only thing the model writes here)
//   slate_trail     read-only: the harness-recorded Trail, filtered by file, tool or step range
//   recall_step     read-only: page the full saved output of one Trail step, by line
//   history_search  read-only: search this session's archive.jsonl
//
// All four are bound to ONE session dir (`getSessionDir`, the lease-aware accessor): they never
// take a session id, so another session is not addressable at all. The two readers that open
// files (`recall_step`, `history_search`) additionally resolve the real path and refuse anything
// that is not a regular file strictly inside this session's own dir (a `..` segment in a path
// recorded in a tampered slate.json, a sibling session's file, or a symlink all fail that check).
// `invoke` never throws: `executeCall` calls it bare.

import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { redactSensitiveText } from "../../../security/service";
import {
  NOTE_KEY_PATTERN,
  NOTE_MAX_CHARS,
  NOTES_MAX_TOKENS,
  SlateNoteRefusedError,
  estimateNotesTokens,
  readSlate,
  writeNote,
  type TrailEntry,
} from "../../../session/slate";
import type { InteractiveTool } from "./interactive-tools";

/** The tool names this module adds; the agent loop offers them only on working-memory hosts. */
export const WORKING_MEMORY_TOOL_NAMES: readonly string[] = ["slate_note", "slate_trail", "recall_step", "history_search"];

/** The four working-memory tools, for a host that builds its own roster (the benchmark runners). */
export function workingMemoryTools(getSessionDir: () => string | undefined, clock: () => string): InteractiveTool[] {
  return [slateNoteTool(getSessionDir, clock), slateTrailTool(getSessionDir), recallStepTool(getSessionDir), historySearchTool(getSessionDir)];
}

const TRAIL_DEFAULT_LIMIT = 40;
const TRAIL_MAX_LIMIT = 200;
const RECALL_DEFAULT_LINES = 200;
const RECALL_MAX_LINES = 500;
const RECALL_MAX_CHARS = 24_000;
const RECALL_LINE_CLIP = 2000;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 30;
const SNIPPET_RADIUS = 120;
/** Characters of one archived message that a `history_search` recall returns per call. */
export const MESSAGE_PAGE_CHARS = 6000;

function failure(message: string): { output: string; isError: true } {
  return { output: message, isError: true };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * `candidate` as a real path strictly inside `sessionDir`'s own tree and a regular file, or
 * `null`. Resolves symlinks on BOTH sides, and rejects the final component being a symlink, so a
 * link planted inside the session dir cannot lead out of it. Read-only callers only.
 */
async function confinedFile(sessionDir: string, candidate: string, within?: string): Promise<string | null> {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const root = await realpath(within === undefined ? sessionDir : path.join(sessionDir, within));
    const sessionReal = await realpath(sessionDir);
    const info = await lstat(path.resolve(candidate));
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const real = await realpath(path.resolve(candidate));
    const rel = path.relative(root, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    const relSession = path.relative(sessionReal, real);
    if (relSession === "" || relSession.startsWith(`..${path.sep}`) || path.isAbsolute(relSession)) return null;
    return real;
  } catch {
    return null;
  }
}

/** `slate_note`: set, replace or delete one Note. Redaction and the caps live in `writeNote`. */
export function slateNoteTool(getSessionDir: () => string | undefined, clock: () => string): InteractiveTool {
  return {
    definition: {
      name: "slate_note",
      description:
        "Keep a fact you will need later in this session's Notes: a decision, a file path, a command, a finding. " +
        "Older tool rounds leave the request as the session grows; Notes do not, they are re-shown to you in full every time the request is rebuilt. " +
        `Input: { key: string, text?: string }. A new key adds a note, an existing key replaces it, and omitting text deletes it. ` +
        `At most ${NOTE_MAX_CHARS} characters per note and ${NOTES_MAX_TOKENS} tokens in all; secrets are redacted. ` +
        "Notes are your own scratch memory: they are never Seeds and never leave this session.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", pattern: NOTE_KEY_PATTERN.source },
          text: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const key = typeof input.key === "string" ? input.key.trim() : "";
      if (key.length === 0) return failure("slate_note requires a 'key'");
      if (input.text !== undefined && typeof input.text !== "string") {
        return failure("slate_note: 'text' must be a string (omit it to delete the note)");
      }
      const dir = getSessionDir();
      if (dir === undefined) return failure("slate_note: no active session in this run");
      try {
        const result = await writeNote(dir, key, input.text, clock());
        if (result.deleted) {
          return { output: JSON.stringify({ deleted: key }), isError: false };
        }
        if (result.stored === undefined) {
          return { output: JSON.stringify({ deleted: null, note: `no note named ${key}` }), isError: false };
        }
        return {
          output: JSON.stringify({
            stored: key,
            chars: result.stored.text.length,
            ...(result.truncated ? { truncated: `cut to ${NOTE_MAX_CHARS} characters` } : {}),
            shelfTokens: estimateNotesTokens(result.slate.notes),
            shelfLimit: NOTES_MAX_TOKENS,
          }),
          isError: false,
        };
      } catch (cause) {
        if (cause instanceof SlateNoteRefusedError) return failure(`slate_note refused: ${cause.message}`);
        return failure(`slate_note failed: ${errorText(cause)}`);
      }
    },
  };
}

function trailLine(entry: TrailEntry): string {
  const files = entry.files !== undefined && entry.files.length > 0 ? ` [${entry.files.join(", ")}]` : "";
  const recall = entry.outputPath !== undefined ? " (output saved)" : "";
  return `#${entry.step} ${entry.tool}(${entry.digest}) -> ${entry.outcome}${files}${recall}`;
}

/** `slate_trail`: the harness-written Trail, read-only. */
export function slateTrailTool(getSessionDir: () => string | undefined): InteractiveTool {
  return {
    definition: {
      name: "slate_trail",
      description:
        "List the Trail: one line per tool call this session, recorded by the harness (step number, tool, argument digest, outcome, files touched). " +
        "Filters (all optional): file (a path or part of one), tool (exact name), from_step / to_step (inclusive), limit (default " +
        `${TRAIL_DEFAULT_LIMIT}, max ${TRAIL_MAX_LIMIT}). Without from_step the newest matches are returned. Use recall_step to read a step's full output.`,
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
          tool: { type: "string" },
          from_step: { type: "integer", minimum: 1 },
          to_step: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: TRAIL_MAX_LIMIT },
        },
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const dir = getSessionDir();
      if (dir === undefined) return failure("slate_trail: no active session in this run");
      try {
        const slate = await readSlate(dir);
        const all = slate?.trail ?? [];
        const file = typeof input.file === "string" && input.file.length > 0 ? input.file : undefined;
        const tool = typeof input.tool === "string" && input.tool.length > 0 ? input.tool : undefined;
        const from = positiveInt(input.from_step);
        const to = positiveInt(input.to_step);
        const limit = Math.min(positiveInt(input.limit) ?? TRAIL_DEFAULT_LIMIT, TRAIL_MAX_LIMIT);
        const matches = all.filter(
          (e) =>
            (tool === undefined || e.tool === tool) &&
            (from === undefined || e.step >= from) &&
            (to === undefined || e.step <= to) &&
            (file === undefined || (e.files ?? []).some((f) => f.includes(file)) || e.digest.includes(file)),
        );
        const shown = from !== undefined ? matches.slice(0, limit) : matches.slice(Math.max(0, matches.length - limit));
        if (shown.length === 0) {
          return { output: `slate_trail: no matching steps (the Trail holds ${all.length} entries)`, isError: false };
        }
        const lines = shown.map(trailLine);
        const omitted = matches.length - shown.length;
        const tail =
          omitted > 0
            ? from !== undefined
              ? `\n... ${omitted} more; continue with from_step ${(shown[shown.length - 1]?.step ?? 0) + 1}`
              : `\n... ${omitted} older matches omitted; narrow with from_step / file / tool`
            : "";
        return { output: `${lines.join("\n")}${tail}`, isError: false };
      } catch (cause) {
        return failure(`slate_trail failed: ${errorText(cause)}`);
      }
    },
  };
}

/** `recall_step`: page the full saved output of one Trail step, by line. */
export function recallStepTool(getSessionDir: () => string | undefined): InteractiveTool {
  return {
    definition: {
      name: "recall_step",
      description:
        "Read the full saved output of one earlier tool call by its Trail step number, a page of lines at a time. " +
        `Input: { step: number, start_line?: number (1-based, default 1), line_count?: number (default ${RECALL_DEFAULT_LINES}, max ${RECALL_MAX_LINES}) }. ` +
        "Find step numbers with slate_trail, or in a packed observation's reference.",
      inputSchema: {
        type: "object",
        properties: {
          step: { type: "integer", minimum: 1 },
          start_line: { type: "integer", minimum: 1 },
          line_count: { type: "integer", minimum: 1, maximum: RECALL_MAX_LINES },
        },
        required: ["step"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const step = positiveInt(input.step);
      if (step === undefined) return failure("recall_step requires a positive integer 'step'");
      const start = positiveInt(input.start_line) ?? 1;
      const count = Math.min(positiveInt(input.line_count) ?? RECALL_DEFAULT_LINES, RECALL_MAX_LINES);
      const dir = getSessionDir();
      if (dir === undefined) return failure("recall_step: no active session in this run");
      try {
        const slate = await readSlate(dir);
        const entry = slate?.trail?.find((e) => e.step === step);
        if (entry === undefined) return failure(`recall_step: step ${step} is not in this session's Trail`);
        if (entry.outputPath === undefined) {
          return failure(`recall_step: step ${step} (${entry.tool}) has no saved output`);
        }
        const file = await confinedFile(dir, entry.outputPath, "tool-output");
        if (file === null) {
          return failure(`recall_step: the saved output for step ${step} is not readable from this session`);
        }
        const lines: string[] = [];
        let total = 0;
        let chars = 0;
        let capped = false;
        const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
        for await (const raw of reader) {
          total += 1;
          if (total < start || total >= start + count || capped) continue;
          const line = raw.length > RECALL_LINE_CLIP ? `${raw.slice(0, RECALL_LINE_CLIP)} ...[line clipped, ${raw.length} chars]` : raw;
          if (chars + line.length > RECALL_MAX_CHARS) {
            capped = true;
            continue;
          }
          chars += line.length + 1;
          lines.push(redactSensitiveText(line));
        }
        if (start > total) {
          return failure(`recall_step: step ${step} has ${total} lines; start_line ${start} is past the end`);
        }
        const last = start + lines.length - 1;
        const header = `step ${step} ${entry.tool}(${entry.digest}) -> ${entry.outcome}; lines ${start}-${last} of ${total}`;
        const more =
          last < total ? `\nnext page: recall_step {"step":${step},"start_line":${last + 1}}` : "\n(end of output)";
        return { output: `${header}\n${lines.join("\n")}${more}`, isError: false };
      } catch (cause) {
        return failure(`recall_step failed: ${errorText(cause)}`);
      }
    },
  };
}

function snippetAround(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle);
  const from = Math.max(0, (at < 0 ? 0 : at) - SNIPPET_RADIUS);
  const to = Math.min(text.length, (at < 0 ? 0 : at) + needle.length + SNIPPET_RADIUS);
  return `${from > 0 ? "..." : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "..." : ""}`;
}

/**
 * Whether a raw archive line can be skipped without parsing it: the line is JSON, so a character the
 * encoder escapes (a quote, a backslash, a newline, a control character) appears in the line in its
 * ESCAPED form and a plain `includes(query)` misses it. A query with such a character is therefore never
 * prefiltered; every other query is, because its raw and decoded spellings are the same.
 */
export function canPrefilterRaw(query: string): boolean {
  for (let i = 0; i < query.length; i += 1) {
    const code = query.charCodeAt(i);
    if (code < 0x20 || code === 0x22 || code === 0x5c || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}

type ArchiveRow = { role?: unknown; content?: unknown; ts?: unknown; toolCalls?: unknown; trailStep?: unknown };

/** The tool calls of an archived message as searchable text: `name arguments`, one per line, arguments decoded. */
function callsText(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) return "";
  return toolCalls
    .map((c) => {
      const call = c as { name?: unknown; arguments?: unknown };
      const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? "");
      return `${String(call.name ?? "")} ${args}`;
    })
    .join("\n");
}

/** The full text of one archived message: its content, or its calls when it has no content. */
function messageText(row: ArchiveRow): string {
  const content = typeof row.content === "string" ? row.content : "";
  return content.length > 0 ? content : callsText(row.toolCalls);
}

/** One page of one archived message, with the exact call that reads the next page. */
function messagePage(rowNo: number, row: ArchiveRow, offset: number): { output: string; isError: boolean } {
  const text = redactSensitiveText(messageText(row));
  if (offset > text.length) {
    return failure(`history_search: row ${rowNo} has ${text.length} characters; offset ${offset} is past the end`);
  }
  const end = Math.min(text.length, offset + MESSAGE_PAGE_CHARS);
  const header = `row ${rowNo} ${String(row.role)} ${String(row.ts ?? "")}: characters ${offset}-${end} of ${text.length}`;
  const more = end < text.length ? `\nnext page: history_search {"row":${rowNo},"offset":${end}}` : "\n(end of message)";
  return { output: `${header}\n${text.slice(offset, end)}${more}`, isError: false };
}

/**
 * `history_search`: case-insensitive search over this session's own archive.jsonl, and the way to read
 * one archived message in full (by row, or by timestamp) when the request carries only a clipped copy.
 */
export function historySearchTool(getSessionDir: () => string | undefined): InteractiveTool {
  return {
    definition: {
      name: "history_search",
      description:
        "Search the full record of this session (every message and tool call, including those that have left the request) for a text, or read one message in full. " +
        `Search: { query: string, limit?: number (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}), role?: 'user'|'assistant'|'tool' } returns the matching entries newest first, each with its row number, role, time and a short snippet. ` +
        `Read: { row: number } or { ts: string, role?: ... } (the time of a message) returns that whole message, ${MESSAGE_PAGE_CHARS} characters per call; { offset: number } continues a long one.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2 },
          limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT },
          role: { type: "string", enum: ["user", "assistant", "tool"] },
          row: { type: "integer", minimum: 1 },
          ts: { type: "string" },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const rowWanted = positiveInt(input.row);
      const tsWanted = typeof input.ts === "string" && input.ts.length > 0 ? input.ts : undefined;
      const recall = rowWanted !== undefined || tsWanted !== undefined;
      if (!recall && query.length < 2) return failure("history_search requires a 'query' of at least 2 characters, or a 'row' / 'ts' to read one message");
      const offset = typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
      const limit = Math.min(positiveInt(input.limit) ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
      const role = typeof input.role === "string" ? input.role : undefined;
      const dir = getSessionDir();
      if (dir === undefined) return failure("history_search: no active session in this run");
      try {
        const file = await confinedFile(dir, path.join(dir, "archive.jsonl"));
        if (file === null) return failure("history_search: this session has no readable archive");
        const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
        let row = 0;
        if (recall) {
          const found: Array<{ no: number; parsed: ArchiveRow }> = [];
          for await (const raw of reader) {
            row += 1;
            if (rowWanted !== undefined && row !== rowWanted) continue;
            if (raw.length === 0 || (tsWanted !== undefined && canPrefilterRaw(tsWanted) && !raw.includes(tsWanted))) continue;
            let parsed: ArchiveRow;
            try {
              parsed = JSON.parse(raw) as ArchiveRow;
            } catch {
              continue;
            }
            if (tsWanted !== undefined && parsed.ts !== tsWanted) continue;
            if (role !== undefined && parsed.role !== role) continue;
            found.push({ no: row, parsed });
            if (rowWanted !== undefined) break;
          }
          const first = found[0];
          if (first === undefined) {
            return failure(`history_search: no archived message matches ${rowWanted !== undefined ? `row ${rowWanted}` : `ts ${tsWanted}`}${role !== undefined ? ` with role ${role}` : ""}`);
          }
          const page = messagePage(first.no, first.parsed, offset);
          const others = found.slice(1).map((f) => f.no);
          return others.length === 0 || page.isError
            ? page
            : { output: `${page.output}\n(${others.length} more message(s) share this timestamp: rows ${others.slice(0, 10).join(", ")}; read one with {"row":N})`, isError: false };
        }
        const hits: string[] = [];
        let matched = 0;
        const prefilter = canPrefilterRaw(query);
        for await (const raw of reader) {
          row += 1;
          if (raw.length === 0 || (prefilter && !raw.toLowerCase().includes(query))) continue;
          let parsed: ArchiveRow;
          try {
            parsed = JSON.parse(raw) as ArchiveRow;
          } catch {
            continue;
          }
          if (role !== undefined && parsed.role !== role) continue;
          const content = typeof parsed.content === "string" ? parsed.content : "";
          const calls = callsText(parsed.toolCalls);
          const inContent = content.toLowerCase().includes(query);
          if (!inContent && !calls.toLowerCase().includes(query)) continue;
          matched += 1;
          hits.push(
            `row ${row} ${String(parsed.role)} ${String(parsed.ts ?? "")}${typeof parsed.trailStep === "number" ? ` step ${parsed.trailStep}` : ""}: ` +
              redactSensitiveText(snippetAround(inContent ? content : calls, query)),
          );
          if (hits.length > SEARCH_MAX_LIMIT * 4) hits.shift();
        }
        if (matched === 0) return { output: `history_search: no match for "${query}" in ${row} archived rows`, isError: false };
        const newest = hits.slice(-limit).reverse();
        const omitted = matched - newest.length;
        return {
          output: `${newest.join("\n")}${omitted > 0 ? `\n... ${omitted} older matches omitted; narrow the query` : ""}\n(read a whole message: history_search {"row":N})`,
          isError: false,
        };
      } catch (cause) {
        return failure(`history_search failed: ${errorText(cause)}`);
      }
    },
  };
}
