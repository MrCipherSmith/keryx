// Flow 293 T9/T10 — review findings against `writeAcCriterion` directly, the
// function they all live in: CRLF handling, refusing a multi-line criterion
// instead of guessing at it, and preserving a mixed-ending file's untouched
// bytes.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acPath, writeAcCriterion } from "./store";

let ROOT = "";

async function fresh(): Promise<{ cwd: string; dir: string; file: string }> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-write-ac-criterion-"));
  const dir = "001-2026-09-23-write-ac-criterion";
  await mkdir(path.join(ROOT, ".metaproject", "flows", dir), { recursive: true });
  return { cwd: ROOT, dir, file: acPath(ROOT, dir) };
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

// Review finding #1 (CRITICAL): a CRLF file's lines keep a trailing `\r`
// after a naive `split("\n")`, which the old `AC_LINE_PATTERN`'s anchored
// `(.*)$` could never match (`.` excludes `\r`; `$` demands literal end of
// string). Every line silently failed to match, so a "replace" found
// neither a matching line nor a last-AC-line to insert after, and appended
// a duplicate `- ACn:` line past the end of the file while leaving the real
// line untouched — a command reporting an amendment the file does not
// contain, which is exactly the defect class flow 293 exists to fix.
test("CRLF: replacing an existing criterion rewrites the real line, keeps CRLF, and writes no duplicate", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(
    file,
    "# Acceptance Criteria\r\n\r\n## Criteria\r\n\r\n- AC1: First criterion\r\n- AC2: Second criterion\r\n",
    "utf8",
  );

  const { previousText } = await writeAcCriterion(cwd, dir, "AC1", "Rewritten first criterion");
  expect(previousText).toBe("First criterion");

  const content = await readFile(file, "utf8");
  // Whole file stays CRLF.
  expect(content.includes("\r\n")).toBe(true);
  expect(content.split("\n").every((line) => line.length === 0 || line.endsWith("\r"))).toBe(true);
  // The real AC1 line was rewritten in place — not left alone with a
  // duplicate appended after it.
  const ac1Lines = content.split(/\r\n/).filter((line) => /^- AC1:/i.test(line));
  expect(ac1Lines).toEqual(["- AC1: Rewritten first criterion"]);
  expect(content).not.toContain("First criterion");
  // AC2 untouched.
  expect(content).toContain("- AC2: Second criterion\r\n");
});

test("CRLF: appending the next unused criterion keeps CRLF and inserts right after the last AC line", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(file, "# Acceptance Criteria\r\n\r\n## Criteria\r\n\r\n- AC1: Only criterion\r\n", "utf8");

  const { previousText } = await writeAcCriterion(cwd, dir, "AC2", "Second criterion");
  expect(previousText).toBeUndefined();

  const content = await readFile(file, "utf8");
  expect(content.includes("\r\n")).toBe(true);
  expect(content).toBe(
    "# Acceptance Criteria\r\n\r\n## Criteria\r\n\r\n- AC1: Only criterion\r\n- AC2: Second criterion\r\n",
  );
});

// Review finding #1, flow 293 T10 (HIGH — supersedes the T9 "swallow the
// continuation lines" behaviour): there is no heuristic that tells "this
// criterion is wrapped onto the next line" apart from "unrelated indented
// content follows it" — a wrapped sentence, a sub-bullet evidence note, and
// a fenced code block are the identical shape on disk. This repo has 1098
// indented lines under criteria across 224 real `acceptance-criteria.md`
// files, so any heuristic here either orphans that content or deletes it.
// The honest answer: `--criterion`/`--text` replaces ONLY a genuinely
// single-line criterion (the format the file's own Rules section
// prescribes) and REFUSES, naming the criterion, the moment it finds any
// following indented, non-blank line before the next `- ACn:` line, a blank
// line, or a heading. Nothing is written.
test("(a) a criterion wrapped across two lines is refused, and the file is byte-identical", async () => {
  const { cwd, dir, file } = await fresh();
  const original = [
    "# Acceptance Criteria",
    "",
    "## Criteria",
    "",
    "- AC1: The system validates input",
    "  and rejects anything malformed, returning a 400.",
    "- AC2: Second criterion",
    "",
  ].join("\n");
  await writeFile(file, original, "utf8");

  await expect(writeAcCriterion(cwd, dir, "AC1", "Rewritten")).rejects.toThrow(
    /AC1 spans more than one line/,
  );

  expect(await readFile(file, "utf8")).toBe(original);
});

test("(b) a criterion followed by indented sub-bullet evidence notes is refused, and the sub-bullets survive", async () => {
  const { cwd, dir, file } = await fresh();
  const original = [
    "# Acceptance Criteria",
    "",
    "## Criteria",
    "",
    "- AC1: Login succeeds within 500ms",
    "  - measured via the p95 dashboard",
    "  - excludes cold-start requests",
    "- AC2: Second criterion",
    "",
  ].join("\n");
  await writeFile(file, original, "utf8");

  await expect(writeAcCriterion(cwd, dir, "AC1", "Rewritten")).rejects.toThrow(
    /AC1 spans more than one line/,
  );

  const content = await readFile(file, "utf8");
  expect(content).toBe(original);
  expect(content).toContain("- measured via the p95 dashboard");
  expect(content).toContain("- excludes cold-start requests");
});

test("a criterion followed by an indented fenced code block is refused, and the block survives", async () => {
  const { cwd, dir, file } = await fresh();
  const original = [
    "# Acceptance Criteria",
    "",
    "## Criteria",
    "",
    "- AC1: The endpoint returns this shape",
    "  ```json",
    '  { "ok": true }',
    "  ```",
    "- AC2: Second criterion",
    "",
  ].join("\n");
  await writeFile(file, original, "utf8");

  await expect(writeAcCriterion(cwd, dir, "AC1", "Rewritten")).rejects.toThrow(
    /AC1 spans more than one line/,
  );
  expect(await readFile(file, "utf8")).toBe(original);
});

test("(c) a single-line criterion followed by a blank line and then an unrelated indented block still replaces fine", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(
    file,
    [
      "# Acceptance Criteria",
      "",
      "## Criteria",
      "",
      "- AC1: First line, nothing follows it directly",
      "",
      "  This indented paragraph belongs to the file's prose, not to AC1 —",
      "  a blank line already ended AC1's block before this starts.",
      "",
      "- AC2: Second criterion",
      "",
    ].join("\n"),
    "utf8",
  );

  const { previousText } = await writeAcCriterion(cwd, dir, "AC1", "Rewritten, replaced fine");
  expect(previousText).toBe("First line, nothing follows it directly");

  const content = await readFile(file, "utf8");
  expect(content).toContain("- AC1: Rewritten, replaced fine");
  // The unrelated indented paragraph after the blank line is untouched.
  expect(content).toContain("This indented paragraph belongs to the file's prose, not to AC1 —");
  expect(content).toContain("a blank line already ended AC1's block before this starts.");
});

// A criterion truly on one line, immediately followed by another criterion
// (no blank line, no continuation at all) still replaces normally — the
// refusal is specifically about CONTINUATION lines existing, not about
// what comes after the block.
test("a single-line criterion immediately followed by the next criterion (no continuation) still replaces fine", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(
    file,
    ["# Acceptance Criteria", "", "## Criteria", "", "- AC1: First", "- AC2: Second", ""].join("\n"),
    "utf8",
  );

  const { previousText } = await writeAcCriterion(cwd, dir, "AC1", "First rewritten");
  expect(previousText).toBe("First");

  const content = await readFile(file, "utf8");
  expect(content).toContain("- AC1: First rewritten\n- AC2: Second");
});

// Appending a criterion that does not exist yet is unaffected by any of the
// above: it is always a brand-new line, so it never has continuation lines
// of its own to lose. Insertion still has to skip PAST an existing
// criterion's continuation lines (it must not land in the middle of one),
// without touching or refusing on them.
test("appending a new criterion is unaffected, even when the last existing criterion has continuation lines", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(
    file,
    [
      "# Acceptance Criteria",
      "",
      "## Criteria",
      "",
      "- AC1: Wrapped across two lines",
      "  and this second one.",
      "",
    ].join("\n"),
    "utf8",
  );

  const { previousText } = await writeAcCriterion(cwd, dir, "AC2", "Brand new criterion");
  expect(previousText).toBeUndefined();

  const content = await readFile(file, "utf8");
  expect(content).toBe(
    [
      "# Acceptance Criteria",
      "",
      "## Criteria",
      "",
      "- AC1: Wrapped across two lines",
      "  and this second one.",
      "- AC2: Brand new criterion",
      "",
    ].join("\n"),
  );
});

// Review finding #2, flow 293 T10 (LOW-MEDIUM): the T9 version's `detectEol`
// picked ONE ending for the whole file (CRLF if it appeared anywhere), so a
// mixed-ending file was rewritten wholesale on write — every `\n`-terminated
// line silently became `\r\n` (or vice versa), changing bytes nobody asked
// to change. Every untouched line must now keep its own original ending
// byte-for-byte; the replaced line keeps the ending it had; an appended line
// takes the ending of the line it follows.
test("mixed line endings: only the target line's bytes change; every other line's ending is preserved exactly", async () => {
  const { cwd, dir, file } = await fresh();
  // AC1 ends in \r\n, AC2 ends in \n, AC3 ends in \r\n, trailing lines \n.
  const original =
    "# Acceptance Criteria\n" +
    "\n" +
    "## Criteria\n" +
    "\n" +
    "- AC1: First\r\n" +
    "- AC2: Second\n" +
    "- AC3: Third\r\n" +
    "\n";
  await writeFile(file, original, "utf8");

  const { previousText } = await writeAcCriterion(cwd, dir, "AC2", "Second, rewritten");
  expect(previousText).toBe("Second");

  const content = await readFile(file, "utf8");
  const expected =
    "# Acceptance Criteria\n" +
    "\n" +
    "## Criteria\n" +
    "\n" +
    "- AC1: First\r\n" +
    "- AC2: Second, rewritten\n" + // replaced line keeps ITS OWN original ending (\n)
    "- AC3: Third\r\n" +
    "\n";
  expect(content).toBe(expected);
});

test("mixed line endings: an appended line takes the ending of the line it follows", async () => {
  const { cwd, dir, file } = await fresh();
  const original =
    "# Acceptance Criteria\n" +
    "\n" +
    "## Criteria\n" +
    "\n" +
    "- AC1: First\n" +
    "- AC2: Second\r\n"; // last existing line ends CRLF
  await writeFile(file, original, "utf8");

  const { previousText } = await writeAcCriterion(cwd, dir, "AC3", "Third, appended");
  expect(previousText).toBeUndefined();

  const content = await readFile(file, "utf8");
  expect(content).toBe(
    "# Acceptance Criteria\n" +
      "\n" +
      "## Criteria\n" +
      "\n" +
      "- AC1: First\n" + // untouched, still \n
      "- AC2: Second\r\n" + // untouched, still \r\n
      "- AC3: Third, appended\r\n", // took the ending of the line it follows (AC2's \r\n)
  );
});

test("mixed line endings: appending after a file with no trailing newline still separates the two lines correctly", async () => {
  const { cwd, dir, file } = await fresh();
  // No trailing "\n" at all -- AC1 is the literal end of the file's bytes.
  const original = "# Acceptance Criteria\n\n## Criteria\n\n- AC1: First";
  await writeFile(file, original, "utf8");

  const { previousText } = await writeAcCriterion(cwd, dir, "AC2", "Second, appended");
  expect(previousText).toBeUndefined();

  const content = await readFile(file, "utf8");
  // AC1 must end up on its own line (a real newline was added after it, not
  // merged with AC2's text), and the file still parses as two criteria.
  expect(content).toBe("# Acceptance Criteria\n\n## Criteria\n\n- AC1: First\n- AC2: Second, appended\n");
});
