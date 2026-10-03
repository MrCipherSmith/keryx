// Flow 393: `/trail` and `/notes`, the operator's view of the session's working memory.
//
// The Trail (what the harness recorded for every tool call) and the Notes (what the model chose to
// keep) decide what the model still has after older rounds leave the request. Without a surface the
// operator could not see either, so these two text commands print them. Both read the live session's
// slate.json; neither writes. The model reads the same Trail through `slate_trail`, so the two views
// cannot disagree.

import { slateTrailTool } from "../harness/tool/builtin/slate-memory-tools";
import { NOTES_MAX_TOKENS, estimateNoteTokens, readSlate } from "../session/slate";

export const TRAIL_COMMAND = "/trail";
export const NOTES_COMMAND = "/notes";
export const TRAIL_SUMMARY = `The tool calls the harness recorded: ${TRAIL_COMMAND} [count] [tool=NAME] [file=TEXT] [from=STEP] [to=STEP]`;
export const NOTES_SUMMARY = `The notes the model keeps for itself: ${NOTES_COMMAND} [key]`;

function firstToken(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

export function isTrailCommand(line: string): boolean {
  return firstToken(line) === TRAIL_COMMAND;
}

export function isNotesCommand(line: string): boolean {
  return firstToken(line) === NOTES_COMMAND;
}

/** The session dir was not available (no open session yet). */
const NO_SESSION = "No session is open yet, so there is no working memory to show.\n";

/** `[count] key=value ...` as the input of `slate_trail`, or the reason it is not understood. */
export function parseTrailArgs(argText: string): { input: Record<string, unknown> } | { error: string } {
  const input: Record<string, unknown> = {};
  for (const part of argText.trim().split(/\s+/).filter((p) => p.length > 0)) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1) return { error: `'${part}' is not a count. Usage: ${TRAIL_SUMMARY}` };
      input.limit = n;
      continue;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (value.length === 0) return { error: `'${part}' has no value. Usage: ${TRAIL_SUMMARY}` };
    if (key === "tool" || key === "file") {
      input[key] = value;
    } else if (key === "from" || key === "to") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return { error: `'${part}' is not a step number. Usage: ${TRAIL_SUMMARY}` };
      input[key === "from" ? "from_step" : "to_step"] = n;
    } else {
      return { error: `Unknown filter '${key}'. Usage: ${TRAIL_SUMMARY}` };
    }
  }
  return { input };
}

/** The text to print for `/trail`. Never throws. */
export async function runTrailCommand(argText: string, sessionDir: string | undefined): Promise<string> {
  if (sessionDir === undefined) return NO_SESSION;
  const parsed = parseTrailArgs(argText);
  if ("error" in parsed) return `${TRAIL_COMMAND}: ${parsed.error}\n`;
  try {
    const slate = await readSlate(sessionDir);
    const total = slate?.trail?.length ?? 0;
    const result = await slateTrailTool(() => sessionDir).invoke(parsed.input);
    return [
      `Trail: ${total} recorded tool call${total === 1 ? "" : "s"} (the model reads the same list with slate_trail)`,
      result.output.replace(/^slate_trail: /, ""),
      "",
    ].join("\n");
  } catch (error) {
    return `${TRAIL_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}

/** The text to print for `/notes`. Never throws. */
export async function runNotesCommand(argText: string, sessionDir: string | undefined): Promise<string> {
  if (sessionDir === undefined) return NO_SESSION;
  const key = argText.trim();
  try {
    const slate = await readSlate(sessionDir);
    const notes = Object.entries(slate?.notes ?? {});
    if (key.length > 0) {
      const note = slate?.notes?.[key];
      return note === undefined
        ? `${NOTES_COMMAND}: no note named '${key}'. Names: ${notes.map(([k]) => k).join(", ") || "(none)"}\n`
        : `Note ${key} (${note.ts}):\n${note.text}\n`;
    }
    if (notes.length === 0) {
      return "Notes: none yet. The model writes one with slate_note when a fact has to outlive the older rounds that leave the request.\n";
    }
    const tokens = notes.reduce((sum, [k, n]) => sum + estimateNoteTokens(k, n.text), 0);
    return [
      `Notes: ${notes.length} (about ${tokens} of ${NOTES_MAX_TOKENS} tokens); read one with ${NOTES_COMMAND} <key>`,
      ...notes.map(
        ([k, n]) => `  ${k} (${n.text.length} chars, ${n.ts}): ${n.text.replace(/\s+/g, " ").slice(0, 100)}${n.text.length > 100 ? "..." : ""}`,
      ),
      "",
    ].join("\n");
  } catch (error) {
    return `${NOTES_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}
