import { readFile } from "node:fs/promises";
import path from "node:path";

// The intent a flow's description.md states, read as text. Kept in the flow
// module, not the product module, so `flow init` can say when a fresh
// description states none without the flow module ever importing the product
// module. The product index reads the same text through the same functions.

/** The exact hint line `flow init` writes under `## Outcome criteria`; an untouched hint declares nothing. */
export const OUTCOME_HINT = 'State an outcome criterion: what you would look at afterwards to see this helped, as a bullet. Or write "- not measured — <reason>".';

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

/** True for each line that is part of a fenced code block, the fence lines themselves included. */
export function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fence = fenceOf(line);
    if (open !== null) {
      fenced.push(true);
      if (fence !== null && fence.char === open.char && fence.length >= open.length && fence.rest.trim() === "") open = null;
      continue;
    }
    if (fence !== null && !(fence.char === "`" && fence.rest.includes("`"))) {
      open = { char: fence.char, length: fence.length };
      fenced.push(true);
      continue;
    }
    fenced.push(false);
  }
  return fenced;
}

/** The text with fenced code blocks and HTML comments removed; what is left is what a reader of the page sees as prose. */
export function proseOutsideFences(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const fenced = fencedLines(lines);
  return lines
    .filter((_, i) => !fenced[i])
    .join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/** The level of each line's heading, 0 where the line is not a heading — and always 0 inside a fenced code block. */
function headingLevels(lines: readonly string[]): number[] {
  const fenced = fencedLines(lines);
  return lines.map((line, i) => (fenced[i] === true ? 0 : headingLevel(line)));
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

/** What the flow delivers, for a one-line summary: Expected outcome first, then Problem. */
export function flowDeliveryStatementFrom(description: string): string | null {
  return statementFrom(description, [/^expected outcome$/i, /^problem$/i]);
}

/**
 * The bullets of an `Outcome criteria` section, each continuation line folded
 * into its bullet; `null` when there is no such section. The untouched
 * `OUTCOME_HINT` is skipped, so a section holding only the hint yields `[]`.
 * The product index and the governance report read bullets through this one
 * function; the governance report alone also reads a section written as prose
 * or a numbered list, which the product index does not count as a criterion.
 */
export function outcomeBulletsFrom(markdown: string): string[] | null {
  const body = sectionOf(markdown, /^outcome criteri(?:a|on)$/i);
  if (body === null) return null;
  const bullets: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    // Only the exact template line is skipped: a real bullet that starts with the same words is a criterion.
    if ((bullet?.[1] ?? line).trim() === OUTCOME_HINT) continue;
    if (bullet !== null) bullets.push((bullet[1] ?? "").trim());
    else if (line.trim().length > 0 && bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return bullets.filter((bullet) => bullet.length > 0);
}

export const INIT_INTENT_NOTE ="note: no intent statement extractable from description.md — the product index will hold no statement for this flow";

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
