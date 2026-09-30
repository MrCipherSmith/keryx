import { describe, expect, test } from "bun:test";
import { UnterminatedMetaprojectReferenceError } from "./agent-entrypoints";
import {
  hasManagedIndexBlock,
  MANAGED_INDEX_BLOCK_END,
  MANAGED_INDEX_BLOCK_START,
  stripManagedIndexBlock,
} from "./managed-index-block";

const BLOCK = `${MANAGED_INDEX_BLOCK_START}\n## Metaproject\n\nRead \`.metaproject/index.md\`.\n${MANAGED_INDEX_BLOCK_END}\n`;

describe("hasManagedIndexBlock", () => {
  test("true for a real block", () => {
    expect(hasManagedIndexBlock(`# Title\n\n${BLOCK}\nBody\n`)).toBe(true);
  });

  test("false for a prose mention and for a fenced example", () => {
    expect(hasManagedIndexBlock(`The block starts with ${MANAGED_INDEX_BLOCK_START} on its own line.\n`)).toBe(false);
    expect(hasManagedIndexBlock(`# Title\n\n\`\`\`md\n${BLOCK}\`\`\`\n`)).toBe(false);
  });
});

describe("stripManagedIndexBlock", () => {
  test("removes the block and leaves the surrounding bytes identical", () => {
    // Irregular spacing on purpose: three blank lines, trailing spaces, a tab,
    // CRLF — everything `replaceManagedBlock`'s blank-line collapse would touch.
    const before = "# Title\n\n\n\nIntro with trailing spaces   \n\tindented\r\n";
    const after = "\n\n\n## Later\n\n\n\nTail without newline";
    const stripped = stripManagedIndexBlock(`${before}${BLOCK}${after}`, "AGENTS.md");
    expect(stripped).toBe(`${before}${after}`);
  });

  test("content with no block is returned unchanged", () => {
    const content = "# Title\n\n\n\nBody\n";
    expect(stripManagedIndexBlock(content, "AGENTS.md")).toBe(content);
  });

  test("a file holding nothing but the block strips to empty", () => {
    expect(stripManagedIndexBlock(BLOCK, "CLAUDE.md")).toBe("");
  });

  test("a block at end of file with no trailing newline is removed whole", () => {
    const block = BLOCK.slice(0, -1);
    expect(stripManagedIndexBlock(`# Title\n\n${block}`, "CLAUDE.md")).toBe("# Title\n\n");
  });

  test("indented and CRLF marker lines are removed as whole lines", () => {
    const block = `  ${MANAGED_INDEX_BLOCK_START}\r\nbody\r\n${MANAGED_INDEX_BLOCK_END}  \r\n`;
    expect(stripManagedIndexBlock(`a\r\n${block}b\r\n`, "AGENTS.md")).toBe("a\r\nb\r\n");
  });

  test("a fenced example is kept and only the real block is removed", () => {
    const example = `\`\`\`md\n${BLOCK}\`\`\`\n`;
    const content = `# Title\n\n${example}\n${BLOCK}\nBody\n`;
    expect(stripManagedIndexBlock(content, "AGENTS.md")).toBe(`# Title\n\n${example}\n\nBody\n`);
  });

  test("a prose mention of the marker is not a block boundary", () => {
    const content = `Mentions ${MANAGED_INDEX_BLOCK_START} inline.\n\nHuman text\n\n${BLOCK}`;
    expect(stripManagedIndexBlock(content, "AGENTS.md")).toBe(`Mentions ${MANAGED_INDEX_BLOCK_START} inline.\n\nHuman text\n\n`);
  });

  test("an end marker that only appears inside a fence does not terminate the block", () => {
    const content = `${MANAGED_INDEX_BLOCK_START}\n\`\`\`\n${MANAGED_INDEX_BLOCK_END}\n\`\`\`\nHuman text\n`;
    expect(() => stripManagedIndexBlock(content, "AGENTS.md")).toThrow(UnterminatedMetaprojectReferenceError);
  });

  test("refuses an unterminated block and names the file", () => {
    const content = `# Title\n\n${MANAGED_INDEX_BLOCK_START}\nHuman text that must survive\n`;
    expect(() => stripManagedIndexBlock(content, "/repo/AGENTS.md")).toThrow(UnterminatedMetaprojectReferenceError);
    expect(() => stripManagedIndexBlock(content, "/repo/AGENTS.md")).toThrow("/repo/AGENTS.md");
  });

  test("every real block is removed when a file carries two", () => {
    const content = `a\n${BLOCK}b\n${BLOCK}c\n`;
    expect(stripManagedIndexBlock(content, "AGENTS.md")).toBe("a\nb\nc\n");
  });
});
