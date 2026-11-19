// Unified diff / patch text, split into lines a view can colour. No DOM, so it is unit-tested alone.

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const FILE_HEADER = /^(?:diff |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files )/;

/**
 * Each line with its role. Hunk headers carry the line counts, so a `--- ` or `+++ ` line inside a hunk
 * is read as a removed or added line, and only outside one as a file header.
 */
export function diffLines(text: string): DiffLine[] {
  const lines = text.replace(/\n$/, "").split("\n");
  const out: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    const hunk = HUNK.exec(line);
    if (hunk && !inHunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (inHunk) {
      if (line.startsWith("+")) {
        newLeft -= 1;
        out.push({ kind: "add", text: line });
      } else if (line.startsWith("-")) {
        oldLeft -= 1;
        out.push({ kind: "del", text: line });
      } else if (line.startsWith("\\")) {
        out.push({ kind: "meta", text: line });
      } else {
        oldLeft -= 1;
        newLeft -= 1;
        out.push({ kind: "ctx", text: line });
      }
      if (oldLeft < 0) oldLeft = 0;
      if (newLeft < 0) newLeft = 0;
      continue;
    }
    // "\ No newline at end of file" follows the hunk's last line, after its counts ran out.
    out.push({ kind: FILE_HEADER.test(line) || line.startsWith("\\") ? "meta" : "ctx", text: line });
  }
  return out;
}

/** Text that reads as a unified diff: at least one hunk, under file headers or as bare hunks. */
export function looksLikeUnifiedDiff(text: string): boolean {
  const lines = text.split("\n", 400);
  const hunk = lines.findIndex((l) => HUNK.test(l));
  if (hunk < 0) return false;
  if (lines.some((l) => l.startsWith("diff --git ") || l.startsWith("--- ") || l.startsWith("+++ "))) return true;
  // Bare hunks: everything from the first one on is diff-shaped.
  return lines.slice(hunk).every((l) => l === "" || /^[-+ @\\]/.test(l));
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added += 1;
    else if (l.kind === "del") removed += 1;
  }
  return { added, removed };
}
