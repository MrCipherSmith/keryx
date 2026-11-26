// Machine-readable blocks a review report carries for keryx itself: `keryx:findings` (what `keryx review ingest` reads),
// `keryx:premises`, `keryx:verifications`, `keryx:report-slots`. They live in the package's report.md and never in what
// a person reads on the pull request (templates/review-report.md: "The `keryx:findings` block is never posted").

/** The opening line of a fenced block whose info string names a `keryx:<tag>`; CommonMark allows three spaces of indent. */
const OPENING = /^ {0,3}(`{3,}|~{3,})[^\n`]*\bkeryx:[\w-]+\b[^\n]*$/m;

/**
 * `text` without its `keryx:<tag>` fenced blocks. Each block runs from its opening line through the closing fence of the
 * same kind and at least the same length; an unclosed block runs to the end, as Markdown renders it. The blank lines a
 * removed block leaves behind are collapsed, so the prose around it reads as before.
 */
export function stripMachineFences(text: string): string {
  let rest = text;
  let out = "";
  for (;;) {
    const open = OPENING.exec(rest);
    if (open === null) break;
    const marker = open[1] ?? "```";
    const char = marker.startsWith("~") ? "~" : "`";
    const afterOpen = open.index + open[0].length;
    const tail = rest.slice(afterOpen);
    const closing = new RegExp(`^ {0,3}\\${char}{${marker.length},}[ \\t]*$`, "m").exec(tail.replace(/^\r?\n/, ""));
    const skipped = tail.length - tail.replace(/^\r?\n/, "").length;
    const end = closing === null ? rest.length : afterOpen + skipped + closing.index + closing[0].length;
    out += rest.slice(0, open.index);
    rest = rest.slice(end);
  }
  return (out + rest).replace(/\n{3,}/g, "\n\n");
}
