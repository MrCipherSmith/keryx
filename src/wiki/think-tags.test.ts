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

// --- flow 268 T26: fence/inline-code-aware stripping (`stripThinkBlocks`) --

test("stripThinkBlocks preserves a complete <think> example inside a fenced code block, untouched", () => {
  const input =
    "---\nTitle: Reasoning-leak guard\n---\n\n" +
    "# Reasoning-leak guard\n\n" +
    "Example of a leaked block this guard removes:\n\n" +
    "```\n<think>example reasoning</think>\n```\n\n" +
    "Ordinary body.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(false);
  // The fenced example survives byte-for-byte — it is documentation, not a leak.
  expect(content).toContain("```\n<think>example reasoning</think>\n```");
  expect(content).toContain("Ordinary body.");
});

test("stripThinkBlocks accepts an inline-code <think> mention, untouched", () => {
  const input =
    "---\nTitle: X\n---\n\n# X\n\nThis guard strips a bare `<think>` tag from model output.\n\nBody.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(false);
  expect(content).toBe(input);
  expect(content).toContain("`<think>`");
});

test("stripThinkBlocks still strips a bare (outside-code) leaked block, even alongside a fenced example", () => {
  const input =
    "---\nTitle: X\n---\n\n<think>real leaked reasoning</think>\n\n" +
    "# X\n\nExample of what this guard removes:\n\n```\n<think>example only</think>\n```\n\nBody.";
  const { content, hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(false);
  expect(content).not.toContain("real leaked reasoning");
  // The fenced EXAMPLE block is untouched.
  expect(content).toContain("```\n<think>example only</think>\n```");
  expect(content).toContain("# X");
  expect(content).toContain("Body.");
});

test("stripThinkBlocks still reports a bare (outside-code) stray tag, even alongside a fenced example", () => {
  const input =
    "# X\n\n" +
    "Documented example:\n\n```\n<think>example only</think>\n```\n\n" +
    "Body.\n</think>\n";
  const { hasStrayTag } = stripThinkBlocks(input);
  expect(hasStrayTag).toBe(true);
});

// --- flow 268 T26: fence/inline-code-aware detection (`containsThinkTags`) -

test("containsThinkTags ignores an inline-code <think> mention", () => {
  const input = "# Docs\n\nThis guard strips a bare `<think>` tag.\n\nOrdinary body.";
  expect(containsThinkTags(input)).toBe(false);
});

test("containsThinkTags still detects a bare stray tag alongside a fenced example", () => {
  const input = "# X\n\n```\n<think>example only</think>\n```\n\nBody.\n</think>\n";
  expect(containsThinkTags(input)).toBe(true);
});

test("wiki status detector (containsThinkTags) and enrich's guard (stripThinkBlocks) agree: a fenced example is never flagged, a bare tag always is", () => {
  const fencedOnly = "# X\n\n```\n<think>example</think>\n```\n\nBody.";
  expect(containsThinkTags(fencedOnly)).toBe(false);
  expect(stripThinkBlocks(fencedOnly).hasStrayTag).toBe(false);

  const bareLeak = "# X\n\n<think>real</think>\n\nBody.";
  expect(containsThinkTags(bareLeak)).toBe(true); // before stripping
  expect(stripThinkBlocks(bareLeak).hasStrayTag).toBe(false); // fully removed, no stray left
  expect(containsThinkTags(stripThinkBlocks(bareLeak).content)).toBe(false); // consistent afterward
});
