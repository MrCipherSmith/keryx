import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Flow 387 T10: spill an oversized tool result to a file and hand the model a
 * bounded view of it.
 *
 * Before this, a 20-39K char tool result (a skills listing, a whole SKILL.md, a
 * full source file, lint JSON) entered history verbatim and was re-sent on every
 * later round. Competitors cap the same way (opencode `tool/truncate.ts`: 2000
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
    `[output truncated: ${lines} lines, ${bytes} bytes in total; full output saved to ${filePath} — read it with an offset/limit or search it]`,
    tail,
  ].join("\n");
}

function safeFileStem(toolCallId: string): string {
  const stem = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return stem.length > 0 ? stem : "call";
}

/**
 * Return `text` untouched when it is under both thresholds or there is no
 * session dir; otherwise write it in full to `<sessionDir>/tool-output/<id>.txt`
 * and return the head+tail view. A failed write degrades to the original text —
 * never lose the output because the disk refused it.
 *
 * `text` must already be redacted: the file holds exactly what history would.
 */
export async function spillLargeToolOutput(text: string, ctx: SpillContext): Promise<string> {
  if (ctx.sessionDir === undefined || !exceedsSpillThreshold(text)) {
    return text;
  }
  const dir = path.join(ctx.sessionDir, TOOL_OUTPUT_DIRNAME);
  const filePath = path.join(dir, `${safeFileStem(ctx.toolCallId)}.txt`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, text, "utf8");
  } catch {
    return text;
  }
  return renderSpillPreview(text, filePath);
}
