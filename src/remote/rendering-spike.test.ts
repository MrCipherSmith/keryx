// The Bot API 10.3 spike note (flow 395; AC1): docs/requirements/keryx-telegram-rendering/spike.md.
// The note is what the renderer, the fake and the fallback chain were built against, so the test
// holds it to its own rules: every fact names a source anchor, the numbers equal the ones in code,
// and the live probe is either a message id or a recorded reason.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RICH_LIMITS } from "./rich-types";

const SPIKE = path.join(import.meta.dir, "..", "..", "docs", "requirements", "keryx-telegram-rendering", "spike.md");

// The anchors of core.telegram.org/bots/api that the note may cite.
const KNOWN_ANCHORS = new Set([
  "#june-11-2026",
  "#july-14-2026",
  "#august-24-2026",
  "#inputrichmessage",
  "#sendrichmessage",
  "#inputrichblocktable",
  "#richblocktablecell",
  "#inputrichblocklist",
  "#inputrichblocklistitem",
  "#inputrichblocksectionheading",
  "#inputrichblockpreformatted",
  "#inputrichblockparagraph",
  "#inputrichblockdivider",
  "#inputrichblockblockquotation",
  "#inputrichblockexpandableblockquotation",
  "#richtext",
  "#rich-message-limits",
  "#editmessagetext",
]);

interface Fact {
  id: string;
  text: string;
  anchors: string[];
}

function readSpike(): string {
  return readFileSync(SPIKE, "utf8");
}

function facts(): Fact[] {
  const rows: Fact[] = [];
  for (const line of readSpike().split("\n")) {
    const match = /^\| ([VSLAE]\d+) \| (.*) \| ((?:`#[^`]+`(?:, )?)+) \|$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      rows.push({ id: match[1], text: match[2], anchors: [...match[3].matchAll(/`(#[^`]+)`/g)].map((m) => m[1] ?? "") });
    }
  }
  return rows;
}

function section(heading: string): string {
  const text = readSpike();
  const start = text.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("the spike note exists and every fact names a source anchor", () => {
  test("the file is there and covers the five topics", () => {
    expect(existsSync(SPIKE)).toBe(true);
    for (const heading of ["Version history", "Input shape", "Limits", "Who may send them", "Editing", "Live probe"]) {
      expect(readSpike()).toContain(`## ${heading}`);
    }
  });

  test("every table row of facts has an anchor, and every anchor is a known one", () => {
    const rows = facts();
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const row of rows) {
      expect(row.anchors.length).toBeGreaterThan(0);
      for (const anchor of row.anchors) {
        expect(KNOWN_ANCHORS.has(anchor)).toBe(true);
      }
    }
  });

  test("no fact row is left without an anchor: the table rows and the parsed rows agree", () => {
    const tableRows = readSpike()
      .split("\n")
      .filter((line) => /^\| [VSLAE]\d+ \|/.test(line));
    expect(facts().map((row) => row.id)).toEqual(tableRows.map((line) => /^\| ([VSLAE]\d+)/.exec(line)?.[1] ?? ""));
  });

  test("the anchors listed at the end are exactly the ones the facts use", () => {
    const used = new Set(facts().flatMap((row) => row.anchors));
    const listed = new Set([...section("Anchors used").matchAll(/`(#[^`]+)`/g)].map((m) => m[1] ?? ""));
    expect(listed).toEqual(used);
    for (const anchor of listed) {
      expect(KNOWN_ANCHORS.has(anchor)).toBe(true);
    }
  });

  test("a fact the reference does not state is marked, not asserted", () => {
    const rows = facts();
    expect(rows.find((row) => row.id === "A1")?.text).toContain("**no**");
    expect(rows.find((row) => row.id === "E3")?.text).toContain("**Not stated**");
  });
});

describe("the numbers in the note are the ones in the code", () => {
  const limit = (id: string): string => facts().find((row) => row.id === id)?.text ?? "";

  test("characters, blocks, nesting and table columns", () => {
    expect(limit("L1")).toContain(`**${RICH_LIMITS.characters}**`);
    expect(limit("L2")).toContain(`**${RICH_LIMITS.blocks}**`);
    expect(limit("L3")).toContain(`**${RICH_LIMITS.nesting}**`);
    expect(limit("L4")).toContain(`**${RICH_LIMITS.tableColumns}**`);
  });

  test("the values are the documented 32768, 500, 16 and 20", () => {
    expect([RICH_LIMITS.characters, RICH_LIMITS.blocks, RICH_LIMITS.nesting, RICH_LIMITS.tableColumns]).toEqual([32768, 500, 16, 20]);
  });

  test("the ordinary text limit stays 4096 beside them", () => {
    expect(limit("L6")).toContain("4096");
  });
});

describe("the shape the note records", () => {
  test("it names the method, the edit parameter and the one-of rule", () => {
    const text = readSpike();
    expect(text).toContain("sendRichMessage");
    expect(text).toContain("editMessageText");
    expect(text).toContain("rich_message");
    expect(text).toContain("Exactly one of the fields `html`, `markdown` or `blocks`");
  });

  test("it names the three versions that matter", () => {
    const text = section("Version history");
    expect(text).toContain("10.1");
    expect(text).toContain("10.2");
    expect(text).toContain("10.3");
  });

  test("it says what happens when a bot may not send them: feature-detect and fall back", () => {
    const text = section("Who may send them");
    expect(text).toContain("feature-detects");
    expect(text).toContain("HTML");
    expect(text).toContain("plain");
  });
});

describe("the live probe", () => {
  test("is either a recorded message id or a recorded reason it was not run", () => {
    const probe = section("Live probe");
    const messageId = /Message id: (\d+)\s*$/m.exec(probe);
    if (messageId !== null) {
      expect(Number(messageId[1])).toBeGreaterThan(0);
      return;
    }
    expect(probe).toContain("Status: PENDING");
    expect(probe).toContain("Why it was not run");
    expect(probe).toContain("no keryx bot token");
  });

  test("it never contains something shaped like a bot token", () => {
    expect(readSpike()).not.toMatch(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/);
  });
});
