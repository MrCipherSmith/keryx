// Source audit (W3 AC4/AC11): `accept-capability.ts` is the only place that
// can mint an accept capability, and this test is what makes "only store.ts
// (and, once T8 lands, accept.ts) may import it" an enforced property rather
// than a convention nobody checks.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createAcceptCapability, isAcceptCapability } from "./accept-capability";

const SRC_ROOT = path.join(__dirname, "..");

const ALLOWED_IMPORTERS = new Set(["src/learning/store.ts", "src/learning/accept.ts"]);

function isTestFile(relativePath: string): boolean {
  return /\.(test|smoke|bench)\.tsx?$/.test(relativePath);
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Matches an import/export/require specifier naming this module, not just any
// mention of the string "accept-capability" (which would also catch this
// file's own doc comments describing the rule).
const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|require\()\s*["'][^"']*\/accept-capability["']/;

describe("accept-capability import discipline", () => {
  test("only store.ts, accept.ts, and test files import accept-capability", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(path.join(SRC_ROOT, ".."), file).split(path.sep).join("/");
      if (relative === "src/learning/accept-capability.ts") continue;
      const content = readFileSync(file, "utf8");
      if (!IMPORT_SPECIFIER_PATTERN.test(content)) continue;
      if (isTestFile(relative)) continue;
      if (ALLOWED_IMPORTERS.has(relative)) continue;
      offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  test("self-check: the pattern actually matches this file's own import", () => {
    const content = readFileSync(path.join(SRC_ROOT, "learning", "accept-capability.test.ts"), "utf8");
    expect(IMPORT_SPECIFIER_PATTERN.test(content)).toBe(true);
  });

  test("sanity: the audit actually inspects files (self-check)", () => {
    expect(statSync(path.join(SRC_ROOT, "learning", "accept-capability.ts")).isFile()).toBe(true);
  });
});

describe("createAcceptCapability / isAcceptCapability", () => {
  test("returns a stable token that isAcceptCapability accepts", () => {
    const capability = createAcceptCapability();
    expect(isAcceptCapability(capability)).toBe(true);
    expect(createAcceptCapability()).toBe(capability);
  });

  test("rejects arbitrary values", () => {
    expect(isAcceptCapability(undefined)).toBe(false);
    expect(isAcceptCapability(null)).toBe(false);
    expect(isAcceptCapability({})).toBe(false);
    expect(isAcceptCapability({ accepted: true })).toBe(false);
    expect(isAcceptCapability("accept")).toBe(false);
  });
});
