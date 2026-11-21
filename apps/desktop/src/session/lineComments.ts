// Review remarks on lines of a changed file. They travel as plain text in the user's message (the agent reads
// the file itself), never as an untrusted resource block.

export interface LineComment {
  path: string;
  startLine: number;
  endLine: number;
  side: "new" | "old";
  text: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `path:12-14` or, for a single line, `path:12`. */
export function lineCommentRange(c: Pick<LineComment, "path" | "startLine" | "endLine">): string {
  return c.endLine > c.startLine ? `${c.path}:${c.startLine}-${c.endLine}` : `${c.path}:${c.startLine}`;
}

/** The text block that goes out with the message; empty when there are no comments. */
export function formatLineComments(comments: readonly LineComment[]): string {
  if (comments.length === 0) return "";
  return ["Line comments:", ...comments.map((c) => `- ${lineCommentRange(c)} (${c.side}): ${oneLine(c.text)}`)].join("\n");
}

/** The user's text with the comments block appended (alone when the user typed nothing). */
export function textWithLineComments(text: string, comments: readonly LineComment[]): string {
  const block = formatLineComments(comments);
  if (!block) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${block}` : block;
}
