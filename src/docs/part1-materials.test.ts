// Flow 402: the part 1 materials for the article stay what they claim to be. The directory holds exactly
// the six files, the protocol is byte-equal to version 2, the recommendation export
// carries no words, and the directory names none of the terms kept out of it.

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { EXPORT_FIELDS } from "../decisions/export";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const DIR = path.join(ROOT, "docs", "research", "role-blurring-part1");
const read = (name: string): string => readFileSync(path.join(DIR, name), "utf8");

const FILES = [
  "README.md",
  "contribution-log.md",
  "decisions-export-2026-10-04.jsonl",
  "part1-counts.json",
  "part1-counts.py",
  "protocol-part2.md",
];

// Version 2 of the protocol, copied unchanged from the operator's attachment. The comparison is by digest of
// the exact bytes: any edit to the file changes the digest, and a later change has to be a new version.
const PROTOCOL_V2_SHA256 = "4ea9dde3b7cd9be948a3bc1fc3b08c70d49c84e2754ce5a6f9d4c5b975f2a5fe";

const PINNED_EXPORT_FIELDS = [
  "answered", "answeredAt", "arm", "backfilled", "changes", "channel", "chosenIndex", "deviation", "eligible",
  "forced", "hasRecommendation", "legacy", "openedAt", "optionCount", "order", "other", "preselected", "ratings",
  "reasonNamed", "reasonRequested", "recommendedIndex", "ref", "seed", "stage", "timeToAnswerMs",
];
const RATING_KEYS =["rater", "quality", "model", "cleanContext", "modelAgree", "at"];
const FORBIDDEN_KEYS = ["question", "options", "reason", "ownAnswer", "answer", "text", "note", "label", "description"];
const FORBIDDEN_TERMS = ["frontend", "backend", "board", "process-metrics"];

describe("the part 1 materials directory (flow 402)", () => {
  it("holds the six files and nothing else", () => {
    expect(readdirSync(DIR).sort()).toEqual([...FILES].sort());
  });

  it("keeps the protocol byte-equal to version 2, with version rows for 1 and 2", () => {
    const text = readFileSync(path.join(DIR, "protocol-part2.md"));
    expect(createHash("sha256").update(text).digest("hex")).toBe(PROTOCOL_V2_SHA256);
    const lines = text.toString("utf8").split("\n");
    expect(lines[0]?.startsWith("# ")).toBe(true);
    expect(lines[0]?.endsWith("версия 2")).toBe(true);
    expect(lines.some((line) => /^\| \d{4}-\d{2}-\d{2} \| 2 \|/.test(line))).toBe(true);
    expect(lines.some((line) => /^\| \d{4}-\d{2}-\d{2} \| 1 \|/.test(line))).toBe(true);
  });

  it("exports only allow-listed keys, with no field that could carry text", () => {
    const lines = read("decisions-export-2026-10-04.jsonl").split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    expect([...EXPORT_FIELDS].sort()).toEqual([...PINNED_EXPORT_FIELDS].sort());
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        expect(PINNED_EXPORT_FIELDS).toContain(key);
        expect(FORBIDDEN_KEYS).not.toContain(key);
        if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(80);
        else expect(["number", "boolean", "object"]).toContain(typeof value);
      }
      const ratings = Array.isArray(row.ratings) ? (row.ratings as Record<string, unknown>[]) : [];
      for (const rating of ratings) {
        for (const key of Object.keys(rating)) expect(RATING_KEYS).toContain(key);
      }
    }
  });

  it("names none of the terms kept out of the directory", () => {
    for (const name of readdirSync(DIR)) {
      const text = read(name).toLowerCase();
      for (const term of FORBIDDEN_TERMS) expect(`${name}: ${text.includes(term)}`).toBe(`${name}: false`);
    }
  });
});
