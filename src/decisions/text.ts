// Flow 392: free text from the human or the agent that ends up on ONE line of
// journal.md or of the report. A newline inside it would start a line of its own
// (a forged journal entry, a forged report row), so whitespace and control
// characters of every kind are collapsed to single spaces and the length is capped.
// Applied when a record is written and again when it is rendered, so a record
// written by an older version (or edited by hand) cannot inject lines either.

export const MAX_TEXT_LENGTH = 300;

export function oneLine(text: string, max: number = MAX_TEXT_LENGTH): string {
  const flat = text.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
