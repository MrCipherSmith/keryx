// Flow 307 (W5-b) review round 1 fixes — F1, F8, F9: this file pins the
// managed-markdown-block helper's own behaviour directly (as opposed to
// `w5b-adapters.test.ts`, which pins it end to end through the
// gemini-cli/kiro/github-copilot-agent instructions surfaces).

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  INSTRUCTIONS_END_MARKER,
  INSTRUCTIONS_START_MARKER,
  SymlinkRefusedError,
  UnterminatedInstructionsBlockError,
  inspectMarkdownBlock,
  installMarkdownBlock,
  probeMarkdownBlock,
  renderInstructionsBlock,
  uninstallMarkdownBlock,
} from "./markdown-block";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-markdown-block-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const RELATIVE_PATH = "NOTES.md";

async function writeRaw(root: string, relativePath: string, content: string): Promise<string> {
  const file = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// F1: a start marker with no matching end marker (or an orphan end marker, or
// markers inside a fenced code block) must never delete content — every one
// of install/uninstall/probe refuses with a precise error and leaves the
// file byte-for-byte untouched.
// ---------------------------------------------------------------------------

describe("F1: unterminated/unpairable blocks never delete content", () => {
  test("start marker with no end marker: install refuses (returns the error, does not write), file untouched", async () => {
    await withTempDir(async (root) => {
      const original = `# Notes\n\n${INSTRUCTIONS_START_MARKER}\nSome hand-edited or truncated content that must survive.\n`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      const errors = await installMarkdownBlock(root, RELATIVE_PATH);
      expect(errors.length).toBe(1);
      expect(errors[0]).toBe(`${RELATIVE_PATH}: unterminated ${INSTRUCTIONS_START_MARKER} block — fix it by hand`);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("start marker with no end marker: uninstall throws UnterminatedInstructionsBlockError, file untouched", async () => {
    await withTempDir(async (root) => {
      const original = `# Notes\n\n${INSTRUCTIONS_START_MARKER}\nUser content that must not be deleted.\n`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await expect(uninstallMarkdownBlock(root, RELATIVE_PATH)).rejects.toThrow(UnterminatedInstructionsBlockError);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("start marker with no end marker: probe refuses with the same precise error, file untouched", async () => {
    await withTempDir(async (root) => {
      const original = `${INSTRUCTIONS_START_MARKER}\nno end marker here\n`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      const problems = await probeMarkdownBlock(root, RELATIVE_PATH);
      expect(problems).toEqual([`${RELATIVE_PATH}: unterminated ${INSTRUCTIONS_START_MARKER} block — fix it by hand`]);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("end marker before any start marker: install/uninstall/probe all refuse, file untouched", async () => {
    await withTempDir(async (root) => {
      const original = `# Notes\n\n${INSTRUCTIONS_END_MARKER}\nstray end marker, no start\n`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      expect((await installMarkdownBlock(root, RELATIVE_PATH)).length).toBe(1);
      expect(await readFile(file, "utf8")).toBe(original);

      await expect(uninstallMarkdownBlock(root, RELATIVE_PATH)).rejects.toThrow(UnterminatedInstructionsBlockError);
      expect(await readFile(file, "utf8")).toBe(original);

      expect((await probeMarkdownBlock(root, RELATIVE_PATH)).length).toBe(1);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("markers quoted inside a fenced code block refuse rather than being treated as real", async () => {
    await withTempDir(async (root) => {
      const original = [
        "# Docs",
        "",
        "Example of the block this tool writes:",
        "",
        "```md",
        INSTRUCTIONS_START_MARKER,
        "## Keryx",
        INSTRUCTIONS_END_MARKER,
        "```",
        "",
      ].join("\n");
      const file = await writeRaw(root, RELATIVE_PATH, original);

      expect((await installMarkdownBlock(root, RELATIVE_PATH)).length).toBe(1);
      expect(await readFile(file, "utf8")).toBe(original);

      await expect(uninstallMarkdownBlock(root, RELATIVE_PATH)).rejects.toThrow(UnterminatedInstructionsBlockError);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });
});

// ---------------------------------------------------------------------------
// Re-plan (round 3, M1/M4): front matter is written ONLY when install itself
// creates the file — never prepended to a file that already exists, even
// one that is empty, one with no front matter of its own, or one whose
// front matter happens to be byte-identical to Keryx's. There is no
// created-file marker any more: uninstall decides whether to delete the
// file purely by what is LEFT once the block (and its one separator line)
// is removed — empty/whitespace-only, or exactly Keryx's own front matter.
// ---------------------------------------------------------------------------

describe("front matter: written only on file creation, never added to an existing file", () => {
  const FRONT_MATTER = "---\ninclusion: always\n---\n\n";

  test("file does not exist: front matter is written, file created, and is deleted again on uninstall", async () => {
    await withTempDir(async (root) => {
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const content = await readFile(path.join(root, RELATIVE_PATH), "utf8");
      expect(content.startsWith(FRONT_MATTER)).toBe(true);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(path.join(root, RELATIVE_PATH))).toBe(false);
    });
  });

  test("file already exists (even with no front matter of its own): Keryx's front matter is never prepended", async () => {
    await withTempDir(async (root) => {
      const original = "# Hello\n\nSome existing text.\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const content = await readFile(file, "utf8");
      expect(content.startsWith(FRONT_MATTER)).toBe(false);
      expect(content.startsWith("# Hello")).toBe(true);
      expect(content).toContain(INSTRUCTIONS_START_MARKER);

      // Idempotent: re-running does not double the block.
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const second = await readFile(file, "utf8");
      expect(second).toBe(content);
    });
  });

  test("file already starts with a DIFFERENT front-matter block: it is preserved untouched, exactly as any other pre-existing content", async () => {
    await withTempDir(async (root) => {
      const original = "---\ntitle: My Doc\n---\n\n# Hello\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const content = await readFile(file, "utf8");
      expect(content.startsWith("---\ntitle: My Doc\n---")).toBe(true);
      expect(content).toContain("# Hello");
      expect(content).toContain(INSTRUCTIONS_START_MARKER);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      // Other content survives, front matter and all — never deleted.
      expect(existsSync(file)).toBe(true);
      const after = await readFile(file, "utf8");
      expect(after).toContain("title: My Doc");
      expect(after).toContain("# Hello");
      expect(after).not.toContain(INSTRUCTIONS_START_MARKER);
    });
  });

  test("file already starts with front matter IDENTICAL to Keryx's own: it is preserved, not mistaken for something Keryx wrote", async () => {
    await withTempDir(async (root) => {
      const original = `${FRONT_MATTER}# Hello\n`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      // The file pre-existed with real content beyond the front matter —
      // never deleted, and the (user's own) front matter survives.
      expect(existsSync(file)).toBe(true);
      const after = await readFile(file, "utf8");
      expect(after).toContain(FRONT_MATTER.trim());
      expect(after).toContain("# Hello");
      expect(after).not.toContain(INSTRUCTIONS_START_MARKER);
    });
  });
});

// ---------------------------------------------------------------------------
// F9: CRLF normalised for detection/comparison but preserved on write;
// duplicate complete blocks collapse (install) / are all removed (uninstall);
// install -> uninstall on content without the block is byte-identical.
// ---------------------------------------------------------------------------

describe("F9: CRLF handling, duplicate blocks, byte-identical round trip", () => {
  test("CRLF file: install detects correctly and writes CRLF back, not LF", async () => {
    await withTempDir(async (root) => {
      const original = "# Notes\r\n\r\nSome notes.\r\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH);
      const content = await readFile(file, "utf8");
      expect(content).toContain("\r\n");
      expect(content.includes("\n") && !content.match(/[^\r]\n/)).toBe(true); // every \n is preceded by \r
      expect(content).toContain("Some notes.");
      expect(content).toContain(INSTRUCTIONS_START_MARKER);

      // Idempotent re-install on the CRLF file: no spurious second block.
      await installMarkdownBlock(root, RELATIVE_PATH);
      const second = await readFile(file, "utf8");
      expect(second).toBe(content);
      expect(second.split(INSTRUCTIONS_START_MARKER).length - 1).toBe(1);
    });
  });

  test("CRLF file with an existing block: probe detects it as healthy (CRLF normalised for comparison)", async () => {
    await withTempDir(async (root) => {
      const lf = `# Notes\n\n${renderInstructionsBlock()}`;
      const crlf = lf.replace(/\n/g, "\r\n");
      await writeRaw(root, RELATIVE_PATH, crlf);
      expect(await probeMarkdownBlock(root, RELATIVE_PATH)).toEqual([]);
    });
  });

  test("CRLF file: uninstall removes the block and preserves CRLF line endings", async () => {
    await withTempDir(async (root) => {
      const original = "# Notes\r\n\r\nSome notes.\r\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      const content = await readFile(file, "utf8");
      expect(content).toContain("\r\n");
      expect(content).toContain("Some notes.");
      expect(content).not.toContain(INSTRUCTIONS_START_MARKER);
    });
  });

  test("CRLF file ending with CRLF: install -> uninstall round trip is byte-identical", async () => {
    await withTempDir(async (root) => {
      const original = "# Notes\r\n\r\nSome notes.\r\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH);
      const afterInstall = await readFile(file, "utf8");
      expect(afterInstall).not.toBe(original);
      expect(afterInstall.startsWith(original)).toBe(true);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("duplicate complete blocks: install collapses them into one (replacing the first, removing the rest)", async () => {
    await withTempDir(async (root) => {
      const block = renderInstructionsBlock();
      const original = `# Notes\n\n${block}\nSome text in between.\n\n${block}`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      const errors = await installMarkdownBlock(root, RELATIVE_PATH);
      expect(errors).toEqual([]);
      const content = await readFile(file, "utf8");
      expect(content.split(INSTRUCTIONS_START_MARKER).length - 1).toBe(1);
      expect(content).toContain("Some text in between.");
    });
  });

  test("duplicate complete blocks: uninstall removes all of them", async () => {
    await withTempDir(async (root) => {
      const block = renderInstructionsBlock();
      const original = `# Notes\n\n${block}\nSome text in between.\n\n${block}`;
      const file = await writeRaw(root, RELATIVE_PATH, original);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      const content = await readFile(file, "utf8");
      expect(content).not.toContain(INSTRUCTIONS_START_MARKER);
      expect(content).toContain("Some text in between.");
    });
  });

  test("install -> uninstall round trip on content without the block (single trailing newline) is byte-identical", async () => {
    await withTempDir(async (root) => {
      const original = "# Existing\n\nSome notes that were already here.\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH);
      const afterInstall = await readFile(file, "utf8");
      expect(afterInstall).not.toBe(original);
      expect(afterInstall.startsWith(original)).toBe(true);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      const afterUninstall = await readFile(file, "utf8");
      expect(afterUninstall).toBe(original);
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-install (general, beyond the CRLF/front-matter cases above).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Re-plan (round 3, M1): uninstall deletes the file whenever what is LEFT
// once the block (and its one separator line) is removed is empty/
// whitespace-only, or exactly Keryx's own front matter — never by asking
// whether install itself created the file. This means a pre-existing empty
// (or whitespace-only) file install wrote the block into is now removed on
// uninstall too, same as one install created outright — an accepted,
// documented trade-off for dropping the created-file marker (see the module
// header and docs/docs/integrations.md). A file with REAL content beyond the
// block is still never deleted.
// ---------------------------------------------------------------------------

describe("uninstall deletes the file once nothing but the block/front matter is left", () => {
  test("file did not exist before install: uninstall deletes it", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, RELATIVE_PATH);
      await installMarkdownBlock(root, RELATIVE_PATH);
      expect(existsSync(file)).toBe(true);
      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  test("pre-existing EMPTY file (0 bytes): install wrote only the block into it, so uninstall removes the file too", async () => {
    await withTempDir(async (root) => {
      const file = await writeRaw(root, RELATIVE_PATH, "");
      await installMarkdownBlock(root, RELATIVE_PATH);
      expect(await readFile(file, "utf8")).not.toBe("");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  test("pre-existing WHITESPACE-only file (\"  \\n\"): same treatment as empty — nothing but the block was ever added, so uninstall removes the file", async () => {
    await withTempDir(async (root) => {
      const original = "  \n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  test("pre-existing file with REAL content: never deleted, block removed, content preserved", async () => {
    await withTempDir(async (root) => {
      const original = "# Existing\n\nSome notes that were already here.\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("kiro (front matter): pre-existing EMPTY steering file — install wrote only front matter + block, uninstall removes the file", async () => {
    const FRONT_MATTER = "---\ninclusion: always\n---\n\n";
    await withTempDir(async (root) => {
      const file = await writeRaw(root, RELATIVE_PATH, "");
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const afterInstall = await readFile(file, "utf8");
      // Existing file: front matter is NEVER prepended, even for kiro.
      expect(afterInstall.startsWith(FRONT_MATTER)).toBe(false);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  test("kiro (front matter): a file that pre-existed with real content ('mine\\n') round-trips byte-identical — no front matter is ever added to it", async () => {
    const FRONT_MATTER = "---\ninclusion: always\n---\n\n";
    await withTempDir(async (root) => {
      const original = "mine\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const afterInstall = await readFile(file, "utf8");
      expect(afterInstall.startsWith(FRONT_MATTER)).toBe(false);
      expect(afterInstall.startsWith("mine\n")).toBe(true);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("kiro: a NEW file install creates, with user lines added around the block, keeps the file with user lines intact and no Keryx leftovers on uninstall", async () => {
    const FRONT_MATTER = "---\ninclusion: always\n---\n\n";
    await withTempDir(async (root) => {
      const file = path.join(root, RELATIVE_PATH);
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const created = await readFile(file, "utf8");

      // The user hand-edits the file Keryx created, adding their own lines
      // both before and after the block (front matter stays first).
      const withUserLines = created.replace(
        INSTRUCTIONS_START_MARKER,
        `user note before the block\n\n${INSTRUCTIONS_START_MARKER}`,
      ) + "\nuser note after the block\n";
      await writeFile(file, withUserLines, "utf8");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      const after = await readFile(file, "utf8");
      expect(after).toContain("user note before the block");
      expect(after).toContain("user note after the block");
      expect(after).not.toContain(INSTRUCTIONS_START_MARKER);
      expect(after).not.toContain(INSTRUCTIONS_END_MARKER);
      expect(after).not.toContain("keryx:created-file");
    });
  });

  test("kiro: a CREATED file, whose whole-file line endings are later converted to CRLF, is still deleted on uninstall once only front matter+block are left", async () => {
    const FRONT_MATTER = "---\ninclusion: always\n---\n\n";
    await withTempDir(async (root) => {
      const file = path.join(root, RELATIVE_PATH);
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const created = await readFile(file, "utf8");

      // Simulate a whole-file CRLF conversion (e.g. a git autocrlf checkout)
      // happening to the file Keryx just created.
      await writeFile(file, created.replace(/\n/g, "\r\n"), "utf8");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });
});

describe("N4: mixed-EOL files are untouched outside the block", () => {
  test("a file with both CRLF and bare LF lines: install inserts an LF-or-CRLF block (per majority) without rewriting the other lines' own endings", async () => {
    await withTempDir(async (root) => {
      // Majority LF (2 bare \n vs 1 \r\n).
      const original = "line one\r\nline two\nline three\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH);
      const afterInstall = await readFile(file, "utf8");
      // Every byte of the original content, in its ORIGINAL mixed-EOL form, survives untouched.
      expect(afterInstall.startsWith(original)).toBe(true);
      expect(afterInstall).toContain(INSTRUCTIONS_START_MARKER);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("a CRLF-majority file: install renders the block in CRLF", async () => {
    await withTempDir(async (root) => {
      const original = "line one\r\nline two\r\nline three\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH);
      const afterInstall = await readFile(file, "utf8");
      expect(afterInstall.startsWith(original)).toBe(true);
      // The block itself uses CRLF (the file's dominant style).
      const blockRegion = afterInstall.slice(original.length);
      expect(blockRegion).toContain("\r\n");
      expect(blockRegion).toContain(INSTRUCTIONS_START_MARKER);
    });
  });
});

// ---------------------------------------------------------------------------
// R4-1: appending the block after a file that ends inside an UNCLOSED fence
// (e.g. GEMINI.md left as "# x\n```\ncode\n") used to succeed, but placed the
// new block INSIDE the fence as `computeFencedRanges` sees it — so the very
// next probe/uninstall found the block's markers "inside a fenced code
// block" and refused as unterminated. install/inspect now catch this UP
// FRONT and refuse with a precise, actionable error instead, leaving the
// file untouched; inspect/probe agree with install (so a dry-run predicts
// the same refusal) even for a file with no block yet.
// ---------------------------------------------------------------------------

describe("R4-1: a file ending inside an unclosed code fence is refused, not silently mis-fenced", () => {
  const UNCLOSED_FENCE_FILE = "# x\n```\ncode\n";

  test("install refuses with a precise error and leaves the file byte-identical", async () => {
    await withTempDir(async (root) => {
      const file = await writeRaw(root, RELATIVE_PATH, UNCLOSED_FENCE_FILE);

      const errors = await installMarkdownBlock(root, RELATIVE_PATH);
      expect(errors).toEqual([
        `${RELATIVE_PATH}: ends inside an unclosed code fence — close it (or add the Keryx block by hand) before installing`,
      ]);
      expect(await readFile(file, "utf8")).toBe(UNCLOSED_FENCE_FILE);
    });
  });

  test("inspect reports the same condition (no block yet) so a dry-run install agrees install would fail", async () => {
    await withTempDir(async (root) => {
      await writeRaw(root, RELATIVE_PATH, UNCLOSED_FENCE_FILE);

      const expectedMessage = `${RELATIVE_PATH}: ends inside an unclosed code fence — close it (or add the Keryx block by hand) before installing`;
      const inspection = await inspectMarkdownBlock(root, RELATIVE_PATH);
      // Reported as "malformed" — the same state a real parse failure uses —
      // so `installer.ts`'s existing "malformed" -> dry-run-`failed` handling
      // already covers this case with no further changes there.
      expect(inspection.state).toBe("malformed");
      expect(inspection.message).toBe(expectedMessage);

      // What install itself reports must match: a dry-run built on `inspect`
      // must not promise `would-install` for a file the real install refuses.
      const errors = await installMarkdownBlock(root, RELATIVE_PATH);
      expect(errors).toEqual([expectedMessage]);
    });
  });

  test("a file with a CLOSED fence (not the last thing in the file) still installs fine", async () => {
    await withTempDir(async (root) => {
      const original = "# x\n\n```\ncode\n```\n\nmore text after the fence closes.\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      const errors = await installMarkdownBlock(root, RELATIVE_PATH);
      expect(errors).toEqual([]);
      const content = await readFile(file, "utf8");
      expect(content.startsWith(original)).toBe(true);
      expect(content).toContain(INSTRUCTIONS_START_MARKER);

      const inspection = await inspectMarkdownBlock(root, RELATIVE_PATH);
      expect(inspection.state).toBe("present");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });
});

describe("idempotent re-install", () => {
  test("re-running install on an already-installed file changes nothing", async () => {
    await withTempDir(async (root) => {
      const original = "# Doc\n\nBody text.\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH);
      const first = await readFile(file, "utf8");

      await installMarkdownBlock(root, RELATIVE_PATH);
      const second = await readFile(file, "utf8");
      expect(second).toBe(first);
    });
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F20: install/uninstall used to `lstat`/`readFile`/
// `writeFile` straight through a symlink — a symlinked TARGET FILE, or a
// symlinked PARENT DIRECTORY of the target — letting a symlink planted under
// the project root redirect a managed-block write to a file outside the
// project root entirely. These reproduce the exact reviewer scenarios (a
// symlinked CLAUDE.md, and a symlinked `.cursor/rules` directory) and fail on
// the pre-fix code: before this fix, the "outside" file below ends up
// containing the rendered block.
// ---------------------------------------------------------------------------

describe("F20: install/uninstall refuse a symlink anywhere in the target's path", () => {
  test("install refuses a symlinked target file, and never writes through it", async () => {
    await withTempDir(async (root) => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-markdown-block-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "outside-target.md");
        await writeFile(outsideFile, "OUTSIDE FILE\n", "utf8");
        await mkdir(root, { recursive: true });
        symlinkSync(outsideFile, path.join(root, RELATIVE_PATH));

        const errors = await installMarkdownBlock(root, RELATIVE_PATH);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("symlink");

        const outsideContent = await readFile(outsideFile, "utf8");
        expect(outsideContent).toBe("OUTSIDE FILE\n");
        expect(outsideContent).not.toContain(INSTRUCTIONS_START_MARKER);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("install refuses a symlinked parent directory, and never creates a file under it", async () => {
    await withTempDir(async (root) => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-markdown-block-outside-"));
      try {
        await mkdir(path.join(root, ".cursor"), { recursive: true });
        symlinkSync(outsideDir, path.join(root, ".cursor", "rules"));

        const relativePath = ".cursor/rules/keryx-rules.mdc";
        const errors = await installMarkdownBlock(root, relativePath);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("symlink");
        expect(existsSync(path.join(outsideDir, "keryx-rules.mdc"))).toBe(false);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("uninstall throws SymlinkRefusedError for a symlinked target file, and never touches it", async () => {
    await withTempDir(async (root) => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-markdown-block-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "outside-target.md");
        const outsideOriginal = `${INSTRUCTIONS_START_MARKER}\nsomething\n${INSTRUCTIONS_END_MARKER}\n`;
        await writeFile(outsideFile, outsideOriginal, "utf8");
        await mkdir(root, { recursive: true });
        symlinkSync(outsideFile, path.join(root, RELATIVE_PATH));

        await expect(uninstallMarkdownBlock(root, RELATIVE_PATH)).rejects.toThrow(SymlinkRefusedError);
        expect(await readFile(outsideFile, "utf8")).toBe(outsideOriginal);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("inspect reports a symlinked target as malformed (dry-run parity with the real refusal)", async () => {
    await withTempDir(async (root) => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-markdown-block-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "outside-target.md");
        await writeFile(outsideFile, "OUTSIDE FILE\n", "utf8");
        await mkdir(root, { recursive: true });
        symlinkSync(outsideFile, path.join(root, RELATIVE_PATH));

        const inspection = await inspectMarkdownBlock(root, RELATIVE_PATH);
        expect(inspection.state).toBe("malformed");
        expect(inspection.message).toContain("symlink");
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("a non-symlinked, ordinary nested target is unaffected (no false positive)", async () => {
    await withTempDir(async (root) => {
      const relativePath = "docs/nested/NOTES.md";
      const errors = await installMarkdownBlock(root, relativePath);
      expect(errors).toEqual([]);
      expect(existsSync(path.join(root, ...relativePath.split("/")))).toBe(true);
    });
  });
});
