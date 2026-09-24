// Flow 307 (W5-b) review round 1 fixes — F1, F8, F9: this file pins the
// managed-markdown-block helper's own behaviour directly (as opposed to
// `w5b-adapters.test.ts`, which pins it end to end through the
// gemini-cli/kiro/github-copilot-agent instructions surfaces).

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  INSTRUCTIONS_END_MARKER,
  INSTRUCTIONS_START_MARKER,
  UnterminatedInstructionsBlockError,
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
// F8: kiro-style front matter is only prepended when the file does not
// already start with SOME front-matter block; a file Keryx itself created
// (front matter + only the block) is deleted on uninstall, a file whose
// front matter Keryx did not write is not.
// ---------------------------------------------------------------------------

describe("F8: front matter is prepended once, never doubled, and only Keryx's own is deleted with the file", () => {
  const FRONT_MATTER = "---\ninclusion: always\n---\n\n";

  test("file does not exist: front matter is written, file created", async () => {
    await withTempDir(async (root) => {
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const content = await readFile(path.join(root, RELATIVE_PATH), "utf8");
      expect(content.startsWith(FRONT_MATTER)).toBe(true);
    });
  });

  test("file already starts with a DIFFERENT front-matter block: Keryx's is never prepended a second time", async () => {
    await withTempDir(async (root) => {
      const original = "---\ntitle: My Doc\n---\n\n# Hello\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);

      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const content = await readFile(file, "utf8");
      expect(content.startsWith("---\ntitle: My Doc\n---")).toBe(true);
      expect(content.startsWith(FRONT_MATTER)).toBe(false);
      expect(content).toContain("# Hello");
      expect(content).toContain(INSTRUCTIONS_START_MARKER);

      // Idempotent: re-running does not double the block or the front matter.
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const second = await readFile(file, "utf8");
      expect(second).toBe(content);
    });
  });

  test("uninstall deletes the file only when what remains is exactly Keryx's own front matter", async () => {
    await withTempDir(async (root) => {
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(path.join(root, RELATIVE_PATH))).toBe(false);
    });
  });

  test("uninstall keeps the file when a DIFFERENT front matter (not Keryx's own) would remain", async () => {
    await withTempDir(async (root) => {
      const original = "---\ntitle: My Doc\n---\n\n# Hello\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      const content = await readFile(file, "utf8");
      expect(content).toContain("title: My Doc");
      expect(content).toContain("# Hello");
      expect(content).not.toContain(INSTRUCTIONS_START_MARKER);
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
// N4 (review round 2): uninstall deletes the file ONLY when install itself
// created it — a pre-existing empty/whitespace-only file always survives,
// byte-identical, even though nothing but the block would otherwise remain.
// Mixed-EOL files are untouched outside the block, and kiro's prepended
// front matter round-trips byte-identical on a file that already had content.
// ---------------------------------------------------------------------------

describe("N4: uninstall deletes the file only when install created it", () => {
  test("file did not exist before install: uninstall deletes it (unchanged from before)", async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, RELATIVE_PATH);
      await installMarkdownBlock(root, RELATIVE_PATH);
      expect(existsSync(file)).toBe(true);
      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  test("pre-existing EMPTY file (0 bytes): survives uninstall, byte-identical to \"\"", async () => {
    await withTempDir(async (root) => {
      const file = await writeRaw(root, RELATIVE_PATH, "");
      await installMarkdownBlock(root, RELATIVE_PATH);
      expect(await readFile(file, "utf8")).not.toBe("");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("");
    });
  });

  test("pre-existing WHITESPACE-only file (\"  \\n\"): survives uninstall, byte-identical", async () => {
    await withTempDir(async (root) => {
      const original = "  \n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH);

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  });

  test("kiro (front matter): pre-existing EMPTY steering file survives uninstall, byte-identical to \"\"", async () => {
    const FRONT_MATTER = "---\ninclusion: always\n---\n\n";
    await withTempDir(async (root) => {
      const file = await writeRaw(root, RELATIVE_PATH, "");
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(await readFile(file, "utf8")).not.toBe("");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("");
    });
  });

  test("kiro (front matter): a file that pre-existed with real content ('mine\\n') round-trips byte-identical — front matter added by install is removed again, file is never deleted", async () => {
    const FRONT_MATTER = "---\ninclusion: always\n---\n\n";
    await withTempDir(async (root) => {
      const original = "mine\n";
      const file = await writeRaw(root, RELATIVE_PATH, original);
      await installMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      const afterInstall = await readFile(file, "utf8");
      expect(afterInstall).toContain(FRONT_MATTER);
      expect(afterInstall).toContain("mine\n");

      const removed = await uninstallMarkdownBlock(root, RELATIVE_PATH, FRONT_MATTER);
      expect(removed).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, "utf8")).toBe(original);
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
