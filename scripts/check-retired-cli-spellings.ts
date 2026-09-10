#!/usr/bin/env bun
// Fail the build when documentation tells a reader to run a retired command
// spelling.
//
// D-04 in docs/requirements/keryx-mcp-servers/decisions.md renamed the
// publisher surface: `keryx mcp serve` -> `keryx serve-mcp`,
// `keryx mcp install|uninstall --runtime <editor>` -> `keryx integrate
// [--remove] <editor>`. The retired spellings still WORK, which is precisely
// why prose drifts back to them unnoticed: nothing breaks, so nothing
// complains, and the documentation slowly re-teaches the name the rename was
// meant to retire.
//
// Two kinds of occurrence are legitimate and must survive:
//
//   1. A was->is row. A table row naming the old spelling AND its replacement
//      is the record OF the rename. It is recognised by its shape, not by its
//      filename, so a new document that records the history is exempt the
//      moment it is written — nobody has to remember to edit this file.
//
//   2. A declared historical passage: a verbatim quote of a superseded draft,
//      a dated changelog entry, a whole document that analyses the old names.
//      Shape cannot distinguish these from drift, so the document declares
//      them in-band, with a written reason. This mirrors the repository's
//      existing `agent-commands.confusable.test.ts` convention, where an
//      exception is allowed only when it is declared and justified.
//
//        <!-- retired-spellings-ok: file    — why -->  whole file
//        <!-- retired-spellings-ok: section — why -->  until the next heading
//        <!-- retired-spellings-ok: line    — why -->  the next non-blank line
//
//      A marker with an unrecognised scope or an empty reason is itself a
//      failure. An exemption that cannot be read is not an exemption.
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** Prose surfaces a reader is expected to follow as instructions. */
const PATTERNS = [
  "README.md",
  "docs/**/*.md",
  "docs/**/*.json",
  ".metaproject/**/*.md",
  // Source too. Eleven places in src/ survived the rename precisely because
  // this gate could not see them — including the template that generates
  // .metaproject/modules/mcp.md, and the message init.ts prints to every new
  // project telling it to run the retired spelling. A gate that only reads
  // documentation cannot stop the code from teaching the old name.
  "src/**/*.ts",
  // `.gitignore` too. It carries prose telling a reader which command wrote the
  // file being ignored and how to regenerate it, and it survived the rename for
  // the same reason the src/ occurrences did: the gate could not see it. A
  // config file that teaches a retired command teaches it just as effectively
  // as a document.
  ".gitignore",
];

// Excluded because they are not reader-facing prose, and scanning them would
// make the gate report on its own exhaust:
//   data/  — gdctx transcripts of executed commands, which include the
//            searches that look for these very spellings.
//   flows/ — per-flow append-only records of work already completed, written
//            by `keryx flow`, describing what was run at the time.
// Both are whole roles, not named files, so new logs and new flows stay
// covered by the same reasoning without anyone editing this list.
const EXCLUDED_ROOTS = [".metaproject/data/", ".metaproject/flows/"];

const RETIRED = /keryx mcp (serve|install|uninstall)\b/g;
const MARKER =
  /(?:<!--|\/\/)\s*retired-spellings-ok:\s*(\w+)\s*[—:-]\s*([^>\n]*?)\s*(?:-->|$)/;
// Two comment syntaxes, one meaning. Markdown cannot carry a `//` comment and
// TypeScript cannot carry an HTML one, and a gate that spans both trees has to
// accept whichever the file it is reading can express. The scope and the
// written reason are required in both forms — an exemption nobody can read is
// not an exemption.

const HEADING = /^#{1,6}\s/;

export type Violation = { file: string; line: number; spelling: string; text: string };

/**
 * Character ranges of the cells that ARE a was->is record: a cell whose subject
 * is a retired spelling, sitting directly beside a cell whose subject is that
 * spelling's replacement. Such a cell records the rename rather than
 * instructing anyone, so it is exempt — recognised by shape, so a document
 * written tomorrow needs no entry in any allowlist.
 *
 * Ranges rather than a boolean, so the exemption can be applied to the cell
 * that earned it instead of to every cell that happens to share its row.
 */
export function pairedCellRanges(line: string): Array<{ start: number; end: number }> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];

  // Cells must PAIR, not merely co-occur. Requiring only "a retired spelling
  // and some replacement appear somewhere on a line starting with |" exempted
  // this, which is a live instruction wearing a table's clothes:
  //
  //   | Tip | run `keryx mcp install --runtime cursor` (or `keryx integrate cursor`) |
  //
  // Found by review and confirmed by running it: the gate reported zero
  // undeclared. That is precisely the "documentation quietly re-teaches the
  // retired name" failure this file exists to prevent, so the shape rule has to
  // be a shape rule — a cell that IS the old spelling beside a cell that IS its
  // own replacement.
  // Offsets into the ORIGINAL line are kept, because the exemption is decided
  // per OCCURRENCE, not per row. Returning one boolean for the whole row was a
  // second hole of the same shape as the first, found by independent
  // verification of the first fix:
  //
  //   | keryx mcp install | keryx integrate | Also run `keryx mcp uninstall` |
  //
  // The first two cells are a genuine was->is pair, so the row was exempt
  // wholesale — and the third cell, a live instruction to run a retired
  // spelling, rode out on their exemption. Confirmed by running it: occurrences
  // rose 59 -> 61 while undeclared stayed 0. A pair excuses the cells that ARE
  // the pair, and nothing else on the line.
  const cells: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  for (const raw of line.split("|")) {
    const start = cursor;
    cursor += raw.length + 1; // + the delimiter that split consumed
    const text = raw.replace(/`/g, "").replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    cells.push({ start, end: start + raw.length, text });
  }

  const paired: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i] as { start: number; end: number; text: string };
    // startsWith, not equality: real rows carry argument suffixes such as
    // `keryx mcp uninstall --runtime <editor>`. Not `includes` either — that is
    // the hole. In the instruction that slipped through, the cell begins "run",
    // and a cell whose subject is the command begins with the command.
    const entry = [...RETIREMENTS].find(([retired]) => cell.text.startsWith(retired));
    if (entry === undefined) continue;
    const replacement = entry[1];
    // The pair may run either way round; some tables read "is | was".
    for (const neighbour of [cells[i - 1], cells[i + 1]]) {
      if (neighbour !== undefined && neighbour.text.startsWith(replacement)) {
        paired.push({ start: cell.start, end: cell.end });
        break;
      }
    }
  }
  return paired;
}

/**
 * True when the row contains at least one genuine was->is pair. Kept for the
 * tests that ask about a row as a whole; the scan itself asks the narrower
 * question — which cell is the occurrence sitting in.
 */
export function isWasIsRow(line: string): boolean {
  return pairedCellRanges(line).length > 0;
}

/**
 * Each retired spelling and the one thing it became.
 *
 * A map rather than two loose regexes, so `keryx mcp serve` cannot be excused
 * by sitting next to `keryx integrate` — a pairing that is wrong but that a
 * "both appear somewhere" rule accepted.
 */
const RETIREMENTS = new Map<string, string>([
  ["keryx mcp serve", "keryx serve-mcp"],
  ["keryx mcp install", "keryx integrate"],
  ["keryx mcp uninstall", "keryx integrate --remove"],
]);

/**
 * Resolve declared exemptions to the set of line numbers (1-based) they cover.
 * Returns `"file"` when the whole file is declared, so the caller can skip it
 * without materialising a line for every occurrence.
 */
export function exemptions(lines: string[]): { whole: boolean; lines: Set<number>; errors: string[] } {
  const covered = new Set<number>();
  const errors: string[] = [];
  let whole = false;

  for (let i = 0; i < lines.length; i += 1) {
    const found = MARKER.exec(lines[i]!);
    if (!found) continue;
    const [, scope, reason] = found;

    if (reason === undefined || reason.trim() === "") {
      errors.push(`line ${i + 1}: retired-spellings-ok marker carries no reason`);
      continue;
    }

    if (scope === "file") {
      whole = true;
    } else if (scope === "section") {
      // A heading ends the section; an unterminated marker runs to the end of
      // the file, which is what "the rest of this document" means.
      for (let j = i; j < lines.length; j += 1) {
        if (j > i && HEADING.test(lines[j]!)) break;
        covered.add(j + 1);
      }
    } else if (scope === "line") {
      covered.add(i + 1);
      const next = lines.findIndex((text, idx) => idx > i && text.trim() !== "");
      if (next !== -1) covered.add(next + 1);
    } else {
      errors.push(`line ${i + 1}: unknown retired-spellings-ok scope "${scope}"`);
    }
  }

  return { whole, lines: covered, errors };
}

export type ScanResult = {
  violations: Violation[];
  /** Every retired spelling seen, exempt or not — a dead matcher reports zero. */
  occurrences: number;
  markerErrors: string[];
};

export function scanText(file: string, text: string): ScanResult {
  const lines = text.split("\n");
  const declared = exemptions(lines);
  const violations: Violation[] = [];
  let occurrences = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    RETIRED.lastIndex = 0;
    const paired = pairedCellRanges(line);
    for (const hit of line.matchAll(RETIRED)) {
      occurrences += 1;
      // The occurrence is excused only if IT sits inside a paired cell — not
      // because some other cell on the same row is a was->is record.
      const at = hit.index ?? 0;
      const inPairedCell = paired.some((range) => at >= range.start && at < range.end);
      if (declared.whole || declared.lines.has(i + 1) || inPairedCell) continue;
      violations.push({ file, line: i + 1, spelling: hit[0]!, text: line.trim().slice(0, 160) });
    }
  }

  return { violations, occurrences, markerErrors: declared.errors.map((e) => `${file}: ${e}`) };
}

export function collectFiles(root = ROOT): string[] {
  const files = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const rel of new Glob(pattern).scanSync({ cwd: root, dot: true })) {
      const normalised = rel.split(path.sep).join("/");
      if (EXCLUDED_ROOTS.some((prefix) => normalised.startsWith(prefix))) continue;
      files.add(normalised);
    }
  }
  return [...files].sort();
}

export function scanTree(root = ROOT): ScanResult & { filesScanned: number } {
  const files = collectFiles(root);
  const violations: Violation[] = [];
  const markerErrors: string[] = [];
  let occurrences = 0;

  for (const rel of files) {
    const result = scanText(rel, readFileSync(path.join(root, rel), "utf8"));
    violations.push(...result.violations);
    markerErrors.push(...result.markerErrors);
    occurrences += result.occurrences;
  }

  return { violations, occurrences, markerErrors, filesScanned: files.length };
}

function main(): void {
  const { violations, occurrences, markerErrors, filesScanned } = scanTree();

  for (const v of violations) {
    console.log(`RETIRED  ${v.file}:${v.line}  ${v.spelling}\n         ${v.text}`);
  }
  for (const e of markerErrors) console.log(`MARKER   ${e}`);
  console.log(
    `scanned ${filesScanned} files, saw ${occurrences} retired spellings, ` +
      `${violations.length} of them undeclared`,
  );

  // A scanner that matches nothing reports "clean" exactly like a clean tree.
  // The corpus is large and the was->is tables are permanent, so both of these
  // are non-zero in any tree where the gate is doing its job.
  if (filesScanned === 0) {
    console.log("FAIL: the collector matched no files at all.");
    process.exitCode = 1;
    return;
  }
  if (occurrences === 0) {
    console.log("FAIL: no retired spelling was seen anywhere, not even in the was->is tables.");
    process.exitCode = 1;
    return;
  }
  if (violations.length > 0 || markerErrors.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
