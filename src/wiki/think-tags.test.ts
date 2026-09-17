import { expect, test } from "bun:test";
import { containsThinkTags, stripThinkBlocks } from "./think-tags";

test("stripThinkBlocks removes a complete <think> block", () => {
  const input = "---\nTitle: X\n---\n\n<think>reasoning about the page</think>\n\n# X\n\nBody.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(false);
  expect(content).not.toContain("<think");
  expect(content).not.toContain("</think>");
  expect(content).not.toContain("reasoning about the page");
  expect(content).toContain("# X");
  expect(content).toContain("Body.");
});

test("stripThinkBlocks removes a complete <thinking> block, case-insensitively", () => {
  const input = "<THINKING>\nmulti\nline\nreasoning\n</THINKING>\n\n# X\n\nBody.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(false);
  expect(content.toLowerCase()).not.toContain("<thinking>");
  expect(content).toContain("# X");
});

test("stripThinkBlocks removes multiple blocks", () => {
  const input = "<think>one</think>\n\n# X\n\n<think>two</think>\n\nBody.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(false);
  expect(content).not.toContain("<think>");
  expect(content).toContain("# X");
  expect(content).toContain("Body.");
});

test("stripThinkBlocks reports a stray unclosed opening tag", () => {
  const input = "<think>\nreasoning that never closes\n\n# X\n\nBody.";
  const { hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(true);
});

test("stripThinkBlocks reports a stray closing tag with no matching open", () => {
  const input = "# X\n\nBody.\n</think>\n";
  const { hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(true);
});

test("stripThinkBlocks leaves content with no tags unchanged", () => {
  const input = "---\nTitle: X\n---\n\n# X\n\nOrdinary body, no reasoning tags at all.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(content).toBe(input);
  expect(hasStrayTag).toBe(false);
});

test("containsThinkTags detects <think> and <thinking> tags", () => {
  expect(containsThinkTags("# X\n\n<think>leaked</think>\n")).toBe(true);
  expect(containsThinkTags("# X\n\n<thinking>leaked</thinking>\n")).toBe(true);
  expect(containsThinkTags("# X\n\nordinary body\n")).toBe(false);
});

test("containsThinkTags ignores tags shown inside fenced code blocks", () => {
  const input = "# Docs\n\nExample:\n\n```\n<think>example only</think>\n```\n\nOrdinary body.";
  expect(containsThinkTags(input)).toBe(false);
});
