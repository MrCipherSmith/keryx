// Flow 293 T9 — review findings #1 (CRLF) and #2 (multi-line criteria)
// against `writeAcCriterion` directly, the function both bugs live in.
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

// Review finding #2 (HIGH): a criterion written across several lines — the
// `- ACn:` line plus indented continuation lines, a real shape used
// elsewhere in this repo's own drafts. A replace used to touch only the
// first line, orphaning the continuation lines under the new (unrelated)
// text, and `previousText` captured only the first line, under-recording
// the amendment in history.
test("multi-line: replacing a criterion removes its continuation lines too, and previousText joins all of them", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(
    file,
    [
      "# Acceptance Criteria",
      "",
      "## Criteria",
      "",
      "- AC1: The system validates input",
      "  and rejects anything malformed,",
      "  returning a 400 with a clear reason.",
      "- AC2: Second criterion",
      "",
    ].join("\n"),
    "utf8",
  );

  const { previousText } = await writeAcCriterion(cwd, dir, "AC1", "Rewritten, single line now");
  expect(previousText).toBe(
    "The system validates input and rejects anything malformed, returning a 400 with a clear reason.",
  );

  const content = await readFile(file, "utf8");
  // Exactly one AC1 line, no orphaned continuation lines.
  expect(content).toContain("- AC1: Rewritten, single line now\n- AC2: Second criterion");
  expect(content).not.toContain("and rejects anything malformed");
  expect(content).not.toContain("returning a 400");
});

test("multi-line: a criterion's continuation lines stop at the next ACn line, a blank line, or a heading", async () => {
  const { cwd, dir, file } = await fresh();
  await writeFile(
    file,
    [
      "# Acceptance Criteria",
      "",
      "## Criteria",
      "",
      "- AC1: First line",
      "  second line of AC1",
      "- AC2: Starts right after, no continuation",
      "",
      "## Notes",
      "",
      "- AC3: After a blank line and a heading",
      "  its own continuation",
      "",
    ].join("\n"),
    "utf8",
  );

  const ac1 = await writeAcCriterion(cwd, dir, "AC1", "AC1 rewritten");
  expect(ac1.previousText).toBe("First line second line of AC1");

  const ac2 = await writeAcCriterion(cwd, dir, "AC2", "AC2 rewritten");
  expect(ac2.previousText).toBe("Starts right after, no continuation");

  const ac3 = await writeAcCriterion(cwd, dir, "AC3", "AC3 rewritten");
  expect(ac3.previousText).toBe("After a blank line and a heading its own continuation");

  const content = await readFile(file, "utf8");
  expect(content).toContain("- AC1: AC1 rewritten");
  expect(content).toContain("- AC2: AC2 rewritten");
  expect(content).toContain("- AC3: AC3 rewritten");
});
