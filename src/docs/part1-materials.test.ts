// Flow 402: the part 1 materials for the article stay what they claim to be. The directory holds exactly
// the six files, the protocol is the original text plus the two added pieces, the recommendation export
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

// Version 1 of the protocol, as it was handed over. The original file is not in the repository, so the
// comparison is by digest of its exact bytes: any edit to the body changes the digest.
const PROTOCOL_V1_SHA256 = "166dfcaabff3e761120199aa80b096c3ee9777910bae7ab69862ebb955c69e3b";
const ADDED_HEADER = "Version 1, fixed 2026-10-04\n\n";
const ADDED_NOTE =
  "\nПримечание: любое последующее изменение протокола оформляется новой версией файла с новой строкой в таблице выше, а не правкой текста.\n";

const RATING_KEYS = ["rater", "quality", "model", "cleanContext", "modelAgree", "at"];
const FORBIDDEN_KEYS = ["question", "options", "reason", "ownAnswer", "answer", "text", "note", "label", "description"];
const FORBIDDEN_TERMS = ["frontend", "backend", "board", "process-metrics"];

describe("the part 1 materials directory (flow 402)", () => {
  it("holds the six files and nothing else", () => {
    expect(readdirSync(DIR).sort()).toEqual([...FILES].sort());
  });

  it("keeps the protocol equal to version 1 apart from the added header and the version note", () => {
    const text = read("protocol-part2.md");
    expect(text.startsWith(ADDED_HEADER)).toBe(true);
    expect(text.endsWith(ADDED_NOTE)).toBe(true);
    const body = text.slice(ADDED_HEADER.length, text.length - ADDED_NOTE.length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(PROTOCOL_V1_SHA256);
  });

  it("exports only allow-listed keys, with no field that could carry text", () => {
    const lines = read("decisions-export-2026-10-04.jsonl").split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    const allowed = EXPORT_FIELDS as readonly string[];
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(row)) {
        expect(allowed).toContain(key);
        expect(FORBIDDEN_KEYS).not.toContain(key);
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
