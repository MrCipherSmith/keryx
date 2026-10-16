// Flow 454 AC9: the guide, the CLI reference and the changelog describe the automatic orchestrator log and carry its four
// honest limits.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const read = (...parts: string[]): string => readFileSync(path.join(REPO, ...parts), "utf8");

const GUIDE = read("docs", "docs", "guides", "review-with-a-record.md");
const CLI = read("docs", "docs", "cli-reference.md");
const CHANGELOG = read("CHANGELOG.md");

const LIMITS = [
  "only calls through keryx are visible",
  "unmarked calls outside the keryx shell are `unattributed`",
  "the log is not a sandbox",
  "the log is a plain editable file",
];

/** The guide spells the limits as a list, with the first letter capitalised and a full stop; compare case-insensitively. */
const flat = (text: string): string => text.replace(/\s+/g, " ").toLowerCase();

describe("AC9: the automatic orchestrator log is documented", () => {
  test("the guide says keryx writes the log, the agent must not edit it, and how a call is attributed", () => {
    const text = flat(GUIDE);
    expect(text).toContain("keryx writes the orchestrator log");
    expect(text).toContain("must not edit it");
    expect(text).toContain("keryx review attach");
    expect(text).toContain("`keryx_review_caller`");
    expect(text).toContain("`unattributed`");
    expect(text).toContain("orchestrator log: recorded");
  });

  test("the guide carries the four limits", () => {
    const text = flat(GUIDE);
    expect(text).toContain("only calls through keryx are visible");
    expect(text).toContain("unmarked calls outside the keryx shell are `unattributed`");
    expect(text).toContain("the log is not a sandbox");
    expect(text).toContain("the log is a plain editable file");
  });

  test("the CLI reference describes the log on review start, attach and readiness, and carries the four limits", () => {
    const text = flat(CLI);
    expect(text).toContain("which keryx writes itself");
    expect(text).toContain("`.metaproject/data/review-active/active-review.json`");
    for (const limit of LIMITS) expect(text).toContain(limit);
  });

  test("the changelog entry carries the four limits and the unattributed rule", () => {
    // Any section: a release moves the entry out of [Unreleased].
    const entry = CHANGELOG.split("\n").find((line) => line.startsWith("- **keryx writes the review orchestrator's call log"));
    expect(entry).toBeDefined();
    for (const limit of LIMITS) expect(flat(entry!)).toContain(limit);
    expect(entry).toContain("warns in the item's detail and never blocks");
  });
});
