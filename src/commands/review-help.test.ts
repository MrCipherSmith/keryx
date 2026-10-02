// `keryx review --help` and `keryx review comments --help` both print a usage
// block for `comments collect|reply`. They once disagreed — the group help
// listed --outcomes as the only optional-looking flag set and omitted --result,
// --review, --self and --allow-closed-pr — so an operator reading either saw a
// different command than the parser accepts. These tests pin both texts to the
// flags the parsers accept.

import { afterEach, expect, test } from "bun:test";
import { COMMENTS_COLLECT_FLAGS, COMMENTS_REPLY_FLAGS, printReviewHelpFor } from "./review";

const realLog = console.log;

afterEach(() => {
  console.log = realLog;
});

function helpFor(rest: string[]): string {
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  printReviewHelpFor(rest);
  console.log = realLog;
  return lines.join("\n");
}

/** The usage entry that starts with `keryx review comments <verb>`, continuation lines included, whitespace collapsed. */
function usageEntry(help: string, verb: "collect" | "reply"): string {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(`keryx review comments ${verb} `));
  expect(start).toBeGreaterThanOrEqual(0);
  const entry = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("keryx ") || /^\S/.test(line)) break;
    entry.push(line);
  }
  return entry.join(" ").replace(/\s+/g, " ").trim();
}

const GROUP = (): string => helpFor([]);
const OWN = (): string => helpFor(["comments"]);

test("comments reply lists every flag its parser accepts, in both helps", () => {
  for (const help of [GROUP(), OWN()]) {
    const entry = usageEntry(help, "reply");
    for (const flag of COMMENTS_REPLY_FLAGS) {
      expect(entry).toContain(flag);
    }
  }
});

test("comments collect lists every flag its parser accepts, in both helps", () => {
  for (const help of [GROUP(), OWN()]) {
    const entry = usageEntry(help, "collect");
    for (const flag of COMMENTS_COLLECT_FLAGS) {
      expect(entry).toContain(flag);
    }
  }
});

test("the group help and the comments help print the same usage entry", () => {
  expect(usageEntry(GROUP(), "reply")).toBe(usageEntry(OWN(), "reply"));
  expect(usageEntry(GROUP(), "collect")).toBe(usageEntry(OWN(), "collect"));
});

test("--outcomes is shown as required for reply, as the parser requires it", () => {
  for (const help of [GROUP(), OWN()]) {
    const entry = usageEntry(help, "reply");
    expect(entry).toContain("--outcomes <file|->");
    expect(entry).not.toContain("[--outcomes");
  }
});
