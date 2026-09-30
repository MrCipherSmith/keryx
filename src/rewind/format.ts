import type { RewindMode } from "./apply";
import type { RewindListing } from "./recorder";

const ALL_MODES: readonly RewindMode[] = ["files", "history", "both"];

export const MODE_LABELS: Record<RewindMode, string> = {
  files: "files only",
  history: "history only",
  both: "files and history",
};

export function availableRewindModes(entry: RewindListing): RewindMode[] {
  return entry.archiveIndex === null ? ["files"] : [...ALL_MODES];
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(empty request)";
  return flat.length > max ? `${flat.slice(0, max - 3)}…` : flat;
}

/** One line per snapshot, newest first. */
export function formatRewindListLines(listings: readonly RewindListing[], selected: number, options: { numbered?: boolean } = {}): string[] {
  if (listings.length === 0) {
    return ["No snapshots yet this session. One is taken before the first file-changing tool call of a turn."];
  }
  return listings.map((entry, index) => {
    const mark = index === selected ? ">" : " ";
    const when = new Date(entry.at).toLocaleTimeString();
    const label = entry.kind === "pre-rewind" ? `(undo point) ${excerpt(entry.prompt, 36)}` : excerpt(entry.prompt, 48);
    const number = options.numbered === true ? `${String(entry.seq).padStart(3)}  ` : "";
    return `${mark} ${number}${when}  ${label}  —  ${fileCount(entry.files)}`;
  });
}

export function formatRewindConfirmLines(entry: RewindListing, mode: RewindMode, question = "Apply this rewind?  y apply   n back"): string[] {
  const lines = [`Rewind to the start of: ${excerpt(entry.prompt, 60)}`, `Rolling back: ${MODE_LABELS[mode]}`, ""];
  if (mode !== "history") {
    const names = entry.changed.slice(0, 8);
    const more = entry.changed.length - names.length;
    lines.push(
      "Files: the work tree goes back to how it was before this turn; later turns are undone too.",
      entry.changed.length > 0 ? `  This turn changed: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "  This turn changed no files.",
      "  A pre-rewind snapshot is taken first, so the rewind itself is an undo point.",
    );
    if (entry.skipped.length > 0) lines.push(`  Not captured (over 5 MB), left as they are: ${entry.skipped.join(", ")}`);
  }
  if (mode !== "files") {
    lines.push("History: the conversation from this turn onward is removed. This cannot be undone.");
  }
  lines.push("", question);
  return lines;
}
