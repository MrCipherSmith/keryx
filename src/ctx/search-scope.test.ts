import { expect, test } from "bun:test";
import { cappedHeaderNote, completenessLine, rgSearchScope, scopeLine } from "./search-scope";
import type { SearchScope, SearchTotals } from "./search-scope";

const NO_SCOPE: SearchScope = { hidden: false, ignored: false, capped: false };

// ---------------------------------------------------------------------------
// rgSearchScope — reading the scope out of the caller's own argv.

test("rgSearchScope reads nothing lifted from a plain search", () => {
  expect(rgSearchScope(["pattern", "src"])).toEqual(NO_SCOPE);
});

test("rgSearchScope recognizes --hidden, --no-ignore and --no-ignore-vcs", () => {
  expect(rgSearchScope(["--hidden", "pattern"])).toEqual({
    hidden: true,
    ignored: false,
    capped: false,
  });
  expect(rgSearchScope(["--no-ignore", "pattern"])).toEqual({
    hidden: false,
    ignored: true,
    capped: false,
  });
  expect(rgSearchScope(["--no-ignore-vcs", "pattern"])).toEqual({
    hidden: false,
    ignored: true,
    capped: false,
  });
  expect(rgSearchScope(["--hidden", "--no-ignore", "pattern"])).toEqual({
    hidden: true,
    ignored: true,
    capped: false,
  });
});

test("rgSearchScope recognizes -m and --max-count, short and long, as capped", () => {
  expect(rgSearchScope(["-m", "1", "pattern"]).capped).toBe(true);
  expect(rgSearchScope(["--max-count", "1", "pattern"]).capped).toBe(true);
  expect(rgSearchScope(["--max-count=1", "pattern"]).capped).toBe(true);
});

// This is the property the whole module exists to protect: a literal pattern
// that happens to spell a scope-widening flag must never be misread as one.
// `buildRgCommand` treats everything after the caller's own `--` as operands
// (pattern/paths), never as options, so scope detection has to stop at the
// same boundary or the two would disagree about what ran.
test("rgSearchScope stops scanning at the caller's own --, so a literal pattern is not misread", () => {
  expect(rgSearchScope(["--", "--hidden"])).toEqual(NO_SCOPE);
  expect(rgSearchScope(["--", "-m", "src"])).toEqual(NO_SCOPE);
  // A real flag BEFORE the separator still counts.
  expect(rgSearchScope(["--hidden", "--", "--hidden"])).toEqual({
    hidden: true,
    ignored: false,
    capped: false,
  });
});

// ---------------------------------------------------------------------------
// scopeLine — what a caller learns about what was not searched.

test("scopeLine names every default exclusion when nothing was lifted", () => {
  const line = scopeLine(NO_SCOPE);
  expect(line).toContain("ripgrep defaults");
  expect(line).toContain(".metaproject/");
  expect(line).toContain(".gitignore");
  expect(line).toContain("binary files");
  expect(line).toContain('"not looked at", not "not present"');
  expect(line).toContain("--hidden");
  expect(line).toContain("--no-ignore");
});

test("scopeLine drops an exclusion once its flag was lifted, and stops offering it", () => {
  const line = scopeLine({ hidden: true, ignored: false, capped: false });
  expect(line).toContain("--hidden");
  // The remaining offer is only for the flag that is still unlifted.
  expect(line).not.toContain("Widen with `--hidden`");
  expect(line).toContain("--no-ignore");
  // Hidden paths were included this run, so that clause must not still claim
  // they were excluded.
  expect(line).not.toContain("hidden paths not named on the command line");
});

test("scopeLine still warns about binary files even when every flag was lifted", () => {
  // No rg flag this project forwards changes ripgrep's silent skip of a file
  // holding a NUL byte, so the warning is unconditional.
  const line = scopeLine({ hidden: true, ignored: true, capped: false });
  expect(line).toContain("binary files");
  expect(line).not.toContain("Widen with");
});

// ---------------------------------------------------------------------------
// completenessLine — an enumeration, or not.

test("completenessLine reports complete when the body shows everything", () => {
  const totals: SearchTotals = { shown: 3, total: 3, unit: "matches" };
  const line = completenessLine(totals, NO_SCOPE);
  expect(line).toContain("Completeness: `complete`");
  expect(line).not.toContain("partial");
});

test("completenessLine reports partial and how to get the rest, on a match-count gap", () => {
  const totals: SearchTotals = { shown: 4, total: 50, unit: "matches" };
  const line = completenessLine(totals, NO_SCOPE);
  expect(line).toContain("Completeness: `partial`");
  expect(line).toContain("4 of 50 matches");
  expect(line).toContain("--all");
  expect(line).toContain("--json");
});

test("completenessLine reports partial on a file-count gap even when every shown file is whole", () => {
  // The second axis: every FILE shown carries all of its own matches, but not
  // every file that matched was shown at all. Folding this into one number
  // would hide the harder loss — the measured case had 127 of 139 files named
  // nowhere in the body.
  const totals: SearchTotals = {
    shown: 24,
    total: 24,
    unit: "matches",
    files: { shown: 1, total: 3 },
  };
  const line = completenessLine(totals, NO_SCOPE);
  expect(line).toContain("Completeness: `partial`");
  expect(line).toContain("across 1 of 3 files");
});

test("completenessLine says unknown, outranking the counts, when -m capped ripgrep's own output", () => {
  // Measured: `keryx ctx rg -m 1 "omitted" src/ctx/lines.ts` printed
  // `Matches: 1` for a file holding 19 real matches, with shown === total (1
  // === 1) — nothing else in this module would flag that as a loss. Only the
  // scope knows ripgrep itself, not keryx, did the truncating.
  const totals: SearchTotals = { shown: 1, total: 1, unit: "matches" };
  const scope: SearchScope = { hidden: false, ignored: false, capped: true };
  const line = completenessLine(totals, scope);
  expect(line).toContain("Completeness: `unknown`");
  expect(line).toContain("-m");
  expect(line).not.toContain("complete`");
});

// ---------------------------------------------------------------------------
// cappedHeaderNote — the same warning at the point a reader is most likely to
// stop reading: the header line itself, not just the body below it.

test("cappedHeaderNote is silent when the count is a real total", () => {
  expect(cappedHeaderNote(NO_SCOPE)).toBe("");
  expect(cappedHeaderNote({ hidden: true, ignored: true, capped: false })).toBe("");
});

test("cappedHeaderNote flags a capped header count", () => {
  const note = cappedHeaderNote({ hidden: false, ignored: false, capped: true });
  expect(note).toContain("-m");
  expect(note).toContain("not a total");
});
