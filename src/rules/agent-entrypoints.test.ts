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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureMetaprojectReference, syncAgentRules, UnterminatedMetaprojectReferenceError } from "./agent-entrypoints";

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
});
