import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";

/**
 * Flow 387 T10: spill an oversized tool result to a file and hand the model a
 * bounded view of it.
 *
 * Before this, a 20-39K char tool result (a skills listing, a whole SKILL.md, a
 * full source file, lint JSON) entered history verbatim and was re-sent on every
 * later round. Other agent tools cap the same way (opencode `tool/truncate.ts`: 2000
 * lines / 50KB; pi `tools/truncate.ts`: same caps; gemini-cli: head+tail with the
 * path shown).
 *
 * This module is pure path-given fs: it never resolves a config-dir path itself
 * (the caller passes the live session dir), so the config-dir source guards
 * (`src/lib/config-dir.*.test.ts`) have nothing here to flag.
 */

/** A result with more lines than this is spilled. */
export const TOOL_OUTPUT_SPILL_MAX_LINES = 2000;
/** A result with more UTF-8 bytes than this is spilled. */
export const TOOL_OUTPUT_SPILL_MAX_BYTES = 50 * 1024;
/** Characters of preview the model sees (head + tail), well under the threshold. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 16 * 1024;
/** Share of the preview budget given to the head; the tail gets the rest. */
export const TOOL_OUTPUT_HEAD_SHARE = 0.4;
/** Subdirectory of the session dir that holds spilled outputs. */
export const TOOL_OUTPUT_DIRNAME = "tool-output";

export interface SpillContext {
  /** Live session directory, or undefined when there is none (no file, no change). */
  sessionDir: string | undefined;
  toolCallId: string;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lines += 1;
  }
  return lines;
}

/** True when `text` crosses either spill threshold. */
export function exceedsSpillThreshold(text: string): boolean {
  // Cheap bound: N chars are at most N lines and at most 3N UTF-8 bytes, so a
  // short string can exceed neither cap and needs no measuring.
  if (text.length <= TOOL_OUTPUT_SPILL_MAX_LINES && text.length * 3 <= TOOL_OUTPUT_SPILL_MAX_BYTES) {
    return false;
  }
  return Buffer.byteLength(text, "utf8") > TOOL_OUTPUT_SPILL_MAX_BYTES || countLines(text) > TOOL_OUTPUT_SPILL_MAX_LINES;
}

/**
 * Build the model-visible text: head, a marker with the original counts and the
 * file path, then tail. Exported for tests; `spillLargeToolOutput` is the entry.
 */
export function renderSpillPreview(text: string, filePath: string): string {
  const headBudget = Math.floor(TOOL_OUTPUT_PREVIEW_CHARS * TOOL_OUTPUT_HEAD_SHARE);
  const tailBudget = TOOL_OUTPUT_PREVIEW_CHARS - headBudget;
  let head = text.slice(0, headBudget);
  // Never let the tail overlap the head (a many-short-lines output can be
  // spilled while smaller than the preview budget).
  let tail = text.slice(Math.max(headBudget, text.length - tailBudget));
  // Snap to a line boundary when one exists so neither half ends mid-line.
  const headCut = head.lastIndexOf("\n");
  if (headCut > 0) {
    head = head.slice(0, headCut);
  }
  const tailCut = tail.indexOf("\n");
  if (tailCut !== -1 && tailCut < tail.length - 1) {
    tail = tail.slice(tailCut + 1);
  }
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text, "utf8");
  return [
    head,
    // Flow 387 T14: name the exact tools and arguments. `read_file` and `search_code`
    // accept this one absolute path (see `resolveSpillReadable`); the inputs below
    // are their real schemas ({ path, start_line } and { pattern, path }).
    `[output truncated: ${lines} lines, ${bytes} bytes in total; full output saved to ${filePath} — ` +
      `read it with read_file {"path": ${JSON.stringify(filePath)}, "start_line": <line>} ` +
      `(each call returns up to 20000 characters and names the next start_line), ` +
      `or search it with search_code {"pattern": "<regex>", "path": ${JSON.stringify(filePath)}}]`,
    tail,
  ].join("\n");
}

/**
 * Flow 387 T14 (SECURITY BOUNDARY): the ONE place outside the project root that
 * `read_file` / `search_code` may read.
 *
 * `read_file`, `list_dir` and `search_code` confine every path to the project root,
 * so a spill file under the user data dir was a path the model was told about and
 * could not open. This resolves `candidate` to its REAL path and returns it only
 * when that path is `<sessionDir>/tool-output` itself or something inside it:
 *
 * - the path must be ABSOLUTE (a relative path keeps meaning "relative to the
 *   project root", exactly as before);
 * - it is realpath'd, so a symlink inside `tool-output` that points elsewhere, and
 *   a `..` that climbs out of it, both resolve outside and are refused;
 * - it must already exist (no nearest-ancestor guessing — nothing here ever writes);
 * - the check is segment-wise (`relative`), so a sibling `tool-output-evil` is not
 *   mistaken for the directory.
 *
 * Nothing else under the data dir (other sessions, config, credentials) becomes
 * readable. Read-only callers only: no write tool may use this.
 */
export function resolveSpillReadable(sessionDir: string | undefined, candidate: string): string | null {
  if (sessionDir === undefined || !path.isAbsolute(candidate)) {
    return null;
  }
  try {
    const dirReal = realpathSync(path.join(sessionDir, TOOL_OUTPUT_DIRNAME));
    const real = realpathSync(path.resolve(candidate));
    if (real === dirReal) {
      return real;
    }
    const rel = path.relative(dirReal, real);
    if (rel === "" || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
      return null;
    }
    return real;
  } catch {
    return null; // missing dir/file, dangling link, or unreadable: refuse
  }
}

function safeFileStem(toolCallId: string): string {
  const stem = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return stem.length > 0 ? stem : "call";
}

/** Directory mode of `tool-output/` and file mode of what it holds: owner only, like the session store. */
const TOOL_OUTPUT_DIR_MODE = 0o700;
const TOOL_OUTPUT_FILE_MODE = 0o600;
/** Most numeric suffixes tried when a generated name already exists. */
const MAX_NAME_ATTEMPTS = 50;

/**
 * Flow 387 review r1 F-004 + F-011: write `text` to a NEW file under
 * `<sessionDir>/tool-output/` and return its path, or `undefined` on failure.
 *
 * The name is `<ms>-<sha256[0..8]>-<stem>.txt`, not just the tool-call id: the Gemini
 * fallback id (`read_file#0`) and the compat fallback id (`call_idx:0`) repeat every
 * round, and a later file overwrote the one an earlier placeholder named. It is opened
 * exclusively (`wx`) and retried with a `-<n>` suffix on collision, so an existing file
 * is never replaced. Dir 0700 / file 0600 (the session store's modes).
 */
async function writeUniqueOutputFile(sessionDir: string, toolCallId: string, text: string): Promise<string | undefined> {
  const dir = path.join(sessionDir, TOOL_OUTPUT_DIRNAME);
  try {
    await mkdir(dir, { recursive: true, mode: TOOL_OUTPUT_DIR_MODE });
    await chmod(dir, TOOL_OUTPUT_DIR_MODE);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
    const base = `${Date.now()}-${hash}-${safeFileStem(toolCallId)}`;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const filePath = path.join(dir, `${base}${attempt === 0 ? "" : `-${attempt}`}.txt`);
      let handle;
      try {
        handle = await open(filePath, "wx", TOOL_OUTPUT_FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
      try {
        await handle.writeFile(text, "utf8");
      } finally {
        await handle.close();
      }
      return filePath;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Flow 387 T11: write `text` in full to a fresh file under `<sessionDir>/tool-output/`
 * regardless of size and return the path, or `undefined` when the write failed.
 * Used before an old tool result is cleared from the request, so the placeholder
 * can always name a file `read_file` can open. `text` is already redacted history.
 */
export async function writeToolOutputFile(
  sessionDir: string,
  toolCallId: string,
  text: string,
): Promise<string | undefined> {
  return writeUniqueOutputFile(sessionDir, toolCallId, text);
}

/**
 * True when `candidate` is lexically inside `<sessionDir>/tool-output`. Prune takes a
 * message's `spillPath` only when it passes this, so a tampered `context.jsonl` cannot
 * point a placeholder elsewhere either.
 */
export function isInsideToolOutputDir(sessionDir: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) {
    return false;
  }
  const rel = path.relative(path.join(sessionDir, TOOL_OUTPUT_DIRNAME), path.resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export interface SpillResult {
  /** What the model sees: `text` itself, or head + marker + tail. */
  text: string;
  /** The file holding the full text; set only when this call spilled it. */
  spillPath?: string;
}

/**
 * Return `text` untouched when it is under both thresholds or there is no
 * session dir; otherwise write it in full to a fresh file under
 * `<sessionDir>/tool-output/` and return the head+tail view together with the file's
 * path. A failed write degrades to the original text — never lose the output because
 * the disk refused it.
 *
 * Flow 387 review r1 F-002: the path is returned as DATA for the caller to record on
 * the tool message; nothing ever parses it back out of the text.
 *
 * `text` must already be redacted: the file holds exactly what history would.
 */
export async function spillToolOutput(text: string, ctx: SpillContext): Promise<SpillResult> {
  if (ctx.sessionDir === undefined || !exceedsSpillThreshold(text)) {
    return { text };
  }
  const filePath = await writeUniqueOutputFile(ctx.sessionDir, ctx.toolCallId, text);
  if (filePath === undefined) {
    return { text };
  }
  return { text: renderSpillPreview(text, filePath), spillPath: filePath };
}

/** {@link spillToolOutput} when only the model-visible text is needed. */
export async function spillLargeToolOutput(text: string, ctx: SpillContext): Promise<string> {
  return (await spillToolOutput(text, ctx)).text;
}
