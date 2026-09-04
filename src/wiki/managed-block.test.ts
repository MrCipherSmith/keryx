// LWG-5 managed block (flow 227): AC1, AC3, AC4, AC11.

import { describe, expect, test } from "bun:test";
import {
  findManagedBlock,
  hashBlockContent,
  replaceManagedBlock,
  wrapReferenceSection,
} from "./managed-block";

const PAGE = [
  "# src/ctx",
  "Version: 1.0.0",
  "Type: component",
  "Status: accepted",
  "",
  "## Overview",
  "",
  "Prose the machine must never touch.",
  "",
  "## Reference (from code graph)",
  "",
  "### Public API",
  "",
  "- runCtx",
  "",
  "## Related Wiki",
  "",
  "- [Index](../index.md)",
  "",
].join("\n");

describe("wrapReferenceSection", () => {
  test("wraps the section and changes nothing else", () => {
    const wrapped = wrapReferenceSection(PAGE);
    expect(wrapped).not.toBeNull();
    const before = PAGE.split("\n");
    const after = (wrapped as string).split("\n");
    const added = after.filter((line) => !line.startsWith("<!-- keryx:reference:"));
    // Every original line survives in order; only marker lines are new.
    expect(added).toEqual(before);
  });

  test("the block ends before the next heading, not at the page end", () => {
    const wrapped = wrapReferenceSection(PAGE) as string;
    const state = findManagedBlock(wrapped);
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.block.content).toContain("### Public API");
    expect(state.block.content).not.toContain("## Related Wiki");
  });

  test("a page with no Reference section is left alone, not given one", () => {
    // One of this repository's 42 component pages is in exactly this state.
    // Inventing a section would be authoring content, not migrating.
    const bare = "# Page\nVersion: 1.0.0\n\n## Overview\n\nProse.\n";
    expect(wrapReferenceSection(bare)).toBeNull();
    expect(findManagedBlock(bare).kind).toBe("no-reference-section");
  });

  test("running it twice is a no-op (AC4)", () => {
    const once = wrapReferenceSection(PAGE) as string;
    expect(wrapReferenceSection(once)).toBeNull();
  });

  test("a duplicated Reference heading is refused rather than guessed at", () => {
    const doubled = `${PAGE}\n## Reference (from code graph)\n\n- second\n`;
    const state = findManagedBlock(doubled);
    expect(state.kind).toBe("malformed");
    expect(wrapReferenceSection(doubled)).toBeNull();
  });
});

describe("findManagedBlock", () => {
  test("reads the version and recorded hash", () => {
    const wrapped = wrapReferenceSection(PAGE) as string;
    const state = findManagedBlock(wrapped);
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.block.markerVersion).toBe(1);
    expect(state.block.recordedHash).toBe(state.block.currentHash);
    expect(state.block.handEdited).toBe(false);
  });

  test("a hand edit inside the block is detected (AC3)", () => {
    const wrapped = wrapReferenceSection(PAGE) as string;
    const tampered = wrapped.replace("- runCtx", "- runCtx (hand-edited)");
    const state = findManagedBlock(tampered);
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.block.handEdited).toBe(true);
  });

  test("a block with no recorded hash is not treated as tampered", () => {
    // Otherwise every page would demand --force once, immediately after
    // migration, for having been migrated.
    const page = "# P\n<!-- keryx:reference:begin v=1 -->\n## Reference\n\n- x\n<!-- keryx:reference:end -->\n";
    const state = findManagedBlock(page);
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.block.recordedHash).toBeNull();
    expect(state.block.handEdited).toBe(false);
  });

  test("an unknown marker version is refused, not guessed at (AC11)", () => {
    const page = "# P\n<!-- keryx:reference:begin v=99 -->\n## Reference\n<!-- keryx:reference:end -->\n";
    const state = findManagedBlock(page);
    expect(state.kind).toBe("malformed");
    if (state.kind !== "malformed") return;
    expect(state.reason).toContain("unknown marker version 99");
  });

  test.each([
    ["<!-- keryx:reference:begin v=1 -->\n## Reference\n", "opening marker with no closing marker"],
    ["## Reference\n<!-- keryx:reference:end -->\n", "closing marker with no opening marker"],
  ])("damage is reported, not thrown: %p", (body, reason) => {
    const state = findManagedBlock(`# P\n${body}`);
    expect(state.kind).toBe("malformed");
    if (state.kind !== "malformed") return;
    expect(state.reason).toBe(reason);
  });
});

describe("replaceManagedBlock (AC1)", () => {
  test("only bytes between the markers change", () => {
    const wrapped = wrapReferenceSection(PAGE) as string;
    const replaced = replaceManagedBlock(wrapped, "## Reference (from code graph)\n\n### Public API\n\n- runCtx\n- newExport") as string;

    expect(replaced).not.toBeNull();
    // Prose and the following section survive byte-for-byte.
    expect(replaced).toContain("Prose the machine must never touch.");
    expect(replaced.split("## Related Wiki")[1]).toBe(
      wrapped.split("## Related Wiki")[1],
    );
    expect(replaced.split("## Overview")[0]).toBe(wrapped.split("## Overview")[0]);
    expect(replaced).toContain("- newExport");
  });

  test("the recorded hash is updated so the next read sees no tampering", () => {
    const wrapped = wrapReferenceSection(PAGE) as string;
    const replaced = replaceManagedBlock(wrapped, "## Reference\n\n- changed") as string;
    const state = findManagedBlock(replaced);
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.block.handEdited).toBe(false);
    expect(state.block.recordedHash).toBe(hashBlockContent("## Reference\n\n- changed"));
  });

  test("a page with no block cannot be replaced into", () => {
    expect(replaceManagedBlock(PAGE, "anything")).toBeNull();
  });
});
