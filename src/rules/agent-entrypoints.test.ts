// Flow 313 (W4 portability), review round 1 fix (F7): tests for
// `ensureMetaprojectReference`'s refuse-on-unterminated-block behavior, and
// that `syncAgentRules` (its only in-repo caller besides `distill.ts`)
// propagates the refusal instead of writing a truncated file.
//
// Before this fix, `replaceManagedBlock` (the private helper
// `ensureMetaprojectReference` uses) returned `content.slice(0, start) +
// block` when a `<!-- keryx:index -->` start marker had no matching
// `<!-- /keryx:index -->` end marker — silently deleting every byte after
// the start marker, including human content. These tests fail on that
// pre-fix behavior: `refuses...` asserts the file is byte-identical to what
// it was before the call (pre-fix, it would have been truncated), and
// `throws UnterminatedMetaprojectReferenceError` pins the specific error.

import { existsSync, symlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureMetaprojectReference,
  SymlinkRefusedError,
  syncAgentRules,
  UnterminatedMetaprojectReferenceError,
} from "./agent-entrypoints";

let projectRoot: string;
let metaprojectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "keryx-agent-entrypoints-"));
  metaprojectRoot = path.join(projectRoot, ".metaproject");
  await mkdir(metaprojectRoot, { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("ensureMetaprojectReference", () => {
  test("refuses, leaving the file byte-identical, when a start marker has no matching end marker", async () => {
    const filePath = path.join(projectRoot, "CLAUDE.md");
    const before = "# Project\n\n<!-- keryx:index -->\norphaned start, never closed\n\nimportant human text after it\n";
    await writeFile(filePath, before, "utf8");

    await expect(ensureMetaprojectReference(filePath)).rejects.toThrow(UnterminatedMetaprojectReferenceError);

    const after = await readFile(filePath, "utf8");
    expect(after).toBe(before);
    expect(after).toContain("important human text after it");
  });

  test("normal case still works: a well-formed existing block is replaced in place", async () => {
    const filePath = path.join(projectRoot, "CLAUDE.md");
    const before = "# Project\n\n<!-- keryx:index -->\nold routing text\n<!-- /keryx:index -->\n\nhuman text below\n";
    await writeFile(filePath, before, "utf8");

    await ensureMetaprojectReference(filePath);

    const after = await readFile(filePath, "utf8");
    expect(after).toContain("<!-- keryx:index -->");
    expect(after).toContain("<!-- /keryx:index -->");
    expect(after).toContain("human text below");
    expect(after).not.toContain("old routing text");
  });

  test("normal case still works: a file with no marker gets the block inserted, not refused", async () => {
    const filePath = path.join(projectRoot, "CLAUDE.md");
    await writeFile(filePath, "# Project\n\nSome human text.\n", "utf8");

    await ensureMetaprojectReference(filePath);

    const after = await readFile(filePath, "utf8");
    expect(after).toContain("<!-- keryx:index -->");
    expect(after).toContain("Some human text.");
  });

  // Review round 2, F15: `content.includes(marker)` used to match a mere
  // SUBSTRING — a sentence that quotes the marker in prose, never using it as
  // a real block delimiter, read as "has a start marker", found no paired end
  // marker anywhere else in the file, and refused the whole operation. Fails
  // on the pre-fix substring check.
  test("F15: a marker merely mentioned in prose (not on its own line) is not treated as a real marker", async () => {
    const filePath = path.join(projectRoot, "CLAUDE.md");
    const before = "# Project\n\nDocs: this file uses the `<!-- keryx:index -->` marker internally.\n";
    await writeFile(filePath, before, "utf8");

    await ensureMetaprojectReference(filePath);

    const after = await readFile(filePath, "utf8");
    // The block was INSERTED (no real marker found), not refused.
    expect(after).toContain("uses the `<!-- keryx:index -->` marker internally");
    // Real (whole-line) start/end markers now bracket a real block, in
    // addition to the untouched prose mention.
    const lines = after.split("\n").map((l) => l.trim());
    expect(lines.filter((l) => l === "<!-- keryx:index -->").length).toBe(1);
    expect(lines.filter((l) => l === "<!-- /keryx:index -->").length).toBe(1);
  });

  // Review round 2, F15: the thrown error used to say only "unterminated
  // <marker> block", with no way to tell WHICH file (of possibly several
  // entrypoints) was at fault. Fails on the pre-fix message.
  test("F15: the unterminated-block error names the file", async () => {
    const filePath = path.join(projectRoot, "CLAUDE.md");
    const before = "# Project\n\n<!-- keryx:index -->\norphaned, never closed\n";
    await writeFile(filePath, before, "utf8");

    await expect(ensureMetaprojectReference(filePath)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining(filePath) }) as unknown as Error,
    );
  });

  // Review round 2, F15 / R1-F20 remainder: a symlinked target whose real
  // path leaves `root` is refused when `root` is passed, and never written
  // through — mirrors `markdown-block.test.ts`'s F20 tests for the sibling
  // `keryx:instructions` writer.
  test("refuses a symlinked target that resolves outside root, when root is given", async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "keryx-agent-entrypoints-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "outside.md");
      await writeFile(outsideFile, "OUTSIDE\n", "utf8");
      const filePath = path.join(projectRoot, "CLAUDE.md");
      symlinkSync(outsideFile, filePath);

      await expect(ensureMetaprojectReference(filePath, { root: projectRoot })).rejects.toThrow(SymlinkRefusedError);
      expect(await readFile(outsideFile, "utf8")).toBe("OUTSIDE\n");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("syncAgentRules propagates the refusal (does not swallow or fall back to truncation)", () => {
  test("a forged/orphaned start marker in an existing entrypoint file aborts the sync", async () => {
    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    const before = "# Project\n\n<!-- keryx:index -->\nno end marker here\n\nimportant human text\n";
    await writeFile(claudeMd, before, "utf8");

    await expect(
      syncAgentRules(projectRoot, metaprojectRoot, { createDefault: false }),
    ).rejects.toThrow(UnterminatedMetaprojectReferenceError);

    // The whole sync aborts before any partial damage: the entrypoint file
    // itself is untouched (this is the file the bad marker lives in).
    const after = await readFile(claudeMd, "utf8");
    expect(after).toBe(before);
  });

  // Review round 2, F15: "check entrypoints before scaffolding" — a bad
  // marker in ONE of several entrypoints used to be discovered mid-loop,
  // after `.metaproject/rules`/`.metaproject/skills/project-rules` were
  // already created AND an earlier, GOOD entrypoint had already been
  // rewritten. Fails on the pre-fix code: before this fix, `agentsMd` below
  // would already contain an inserted `keryx:index` block, and the two
  // `.metaproject` subdirectories would already exist, by the time the
  // rejection is observed.
  test("F15: a bad marker in one entrypoint aborts BEFORE any other entrypoint or .metaproject scaffolding is touched", async () => {
    const agentsMd = path.join(projectRoot, "AGENTS.md");
    const agentsBefore = "# Agents\n\nGood file, no marker at all.\n";
    await writeFile(agentsMd, agentsBefore, "utf8");

    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    const claudeBefore = "# Project\n\n<!-- keryx:index -->\nno end marker here\n";
    await writeFile(claudeMd, claudeBefore, "utf8");

    await expect(
      syncAgentRules(projectRoot, metaprojectRoot, { createDefault: false }),
    ).rejects.toThrow(UnterminatedMetaprojectReferenceError);

    // AGENTS.md (the good entrypoint, alphabetically/discovery-first) was
    // never rewritten — the pre-scaffold pass caught CLAUDE.md's problem
    // before the main loop reached either file.
    expect(await readFile(agentsMd, "utf8")).toBe(agentsBefore);
    expect(await readFile(claudeMd, "utf8")).toBe(claudeBefore);
    // Nothing was scaffolded under .metaproject either.
    expect(existsSync(path.join(metaprojectRoot, "rules"))).toBe(false);
    expect(existsSync(path.join(metaprojectRoot, "skills", "project-rules"))).toBe(false);
  });
});
