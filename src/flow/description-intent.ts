import { readFile } from "node:fs/promises";
import path from "node:path";

// The intent a flow's description.md states, read as text. Kept in the flow
// module, not the product module, so `flow init` can say when a fresh
// description states none without the flow module ever importing the product
// module. The product index reads the same text through the same functions.

/** The hint `flow init` writes under `## Outcome criteria`; an untouched hint declares nothing. */
export const OUTCOME_HINT = "State an outcome criterion";

const PLACEHOLDERS = ["Describe the problem precisely", "What must be true when this flow is done"];
const FLOW_STATEMENT_HEADINGS = [/^problem$/i, /^expected outcome$/i];
const STATEMENT_LIMIT = 300;

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match?.[1]?.length ?? 0;
}

/** The fence marker a line opens or closes (` ``` ` or `~~~`, up to three spaces of indent), or null. */
function fenceOf(line: string): { char: string; length: number; rest: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return match === null ? null : { char: (match[1] ?? "")[0] ?? "", length: (match[1] ?? "").length, rest: match[2] ?? "" };
}

/** The level of each line's heading, 0 where the line is not a heading — and always 0 inside a fenced code block. */
function headingLevels(lines: readonly string[]): number[] {
  const levels: number[] = [];
  let open: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fence = fenceOf(line);
    if (open !== null) {
      levels.push(0);
      if (fence !== null && fence.char === open.char && fence.length >= open.length && fence.rest.trim() === "") open = null;
      continue;
    }
    if (fence !== null && !(fence.char === "`" && fence.rest.includes("`"))) {
      open = { char: fence.char, length: fence.length };
      levels.push(0);
      continue;
    }
    levels.push(headingLevel(line));
  }
  return levels;
}

/** Body of the first section whose heading matches, up to the next heading of the same or a higher level. */
export function sectionOf(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split(/\r?\n/);
  const levels = headingLevels(lines);
  const start = lines.findIndex((line, i) => (levels[i] ?? 0) > 0 && heading.test(line.replace(/^#{1,6}\s+/, "").trim()));
  if (start === -1) return null;
  const level = levels[start] ?? 0;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const next = levels[i] ?? 0;
    if (next > 0 && next <= level) break;
    body.push(lines[i] ?? "");
  }
  return body.join("\n");
}

function firstSentence(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  if (PLACEHOLDERS.some((placeholder) => flat.startsWith(placeholder))) return null;
  const sentence = /^(.*?[.!?])(?=\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > STATEMENT_LIMIT ? `${sentence.slice(0, STATEMENT_LIMIT - 1).trimEnd()}…` : sentence;
}

/** The first usable sentence among the named sections, in the order given. */
export function statementFrom(markdown: string, headings: readonly RegExp[]): string | null {
  for (const heading of headings) {
    const body = sectionOf(markdown, heading);
    const sentence = body === null ? null : firstSentence(body);
    if (sentence !== null) return sentence;
  }
  return null;
}

/** The flow's intent statement, as the index reads it; `flow init` reuses it to say when there is none. */
export function flowStatementFrom(description: string): string | null {
  return statementFrom(description, FLOW_STATEMENT_HEADINGS);
}

export const INIT_INTENT_NOTE = "note: no intent statement extractable from description.md — the product index will hold no statement for this flow";

/** The one informational line `flow init` prints when the new description states no intent; `null` when it does. */
export function initIntentNote(description: string): string | null {
  return flowStatementFrom(description) === null ? INIT_INTENT_NOTE : null;
}

/**
 * The note for a flow `flow init` just created (`dir` is relative to `cwd`). It
 * never changes an exit code and never blocks: a description that cannot be read
 * simply gets no note.
 */
export async function intentNoteForNewFlow(cwd: string, dir: string): Promise<string | null> {
  try {
    return initIntentNote(await readFile(path.join(cwd, dir, "description.md"), "utf8"));
  } catch {
    return null;
  }
}
