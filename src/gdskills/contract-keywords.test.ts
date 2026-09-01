// No shipped contract schema may declare a validation keyword the validator
// ignores.
//
// This is the structural answer to a defect that has now been found THREE times,
// each time as a different keyword:
//
//   1. `minItems` — `subagent-dispatch` and `review-finding` relied on it while
//      `validateValue` had no branch for it.
//   2. `maximum` — `task-implementer`'s input contract carried
//      `max_self_fix_attempts: { maximum: 5 }`, likewise ignored.
//   3. `maxItems` — 0.2.74 registered `review-pr-feedback-output`, whose schema
//      says `excluded_for_injection: { maxItems: 0 }` when `screen_status` is
//      `"unavailable"`. That is the machine form of "if the injection screen
//      never ran, you may not claim it excluded anything" — and a record
//      asserting BOTH validated clean.
//
// Fixing the third instance by hand would guarantee a fourth. The failure is not
// forgetfulness: adding a keyword to a JSON schema and adding it to the
// validator are separate acts, and nothing forced the second one. This guard
// forces it.
//
// The implemented set is derived from the validator SOURCE rather than
// hand-listed here, because a hand-listed set is one more thing that drifts —
// the very mechanism being guarded against.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONTRACTS, contractPath } from "./contracts";

const repoRoot = path.join(import.meta.dir, "..", "..");

/**
 * Keywords `validateValue` actually reads, scraped from `schema.<name>` in the
 * validator's own source. `properties`/`items`/`required` and friends are read
 * the same way, so they come along for free.
 */
function implementedKeywords(): Set<string> {
  const source = readFileSync(path.join(repoRoot, "src", "gdskills", "contracts.ts"), "utf8");
  const found = new Set<string>();
  // `$` must be in the leading class: `$ref` IS implemented (validateValue
  // resolves it before anything else), and the first draft of this guard
  // reported it as unimplemented because the pattern started at [a-zA-Z]. A
  // guard that cries wolf gets an allow-list entry and then gets deleted, so
  // the false positive matters as much as the miss.
  for (const match of source.matchAll(/\bschema\.([$a-zA-Z][a-zA-Z0-9_]*)/g)) found.add(match[1]!);
  return found;
}

/** Every keyword position in a schema document, walked structurally. */
function declaredKeywords(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) declaredKeywords(entry, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "properties" || key === "definitions" || key === "$defs") {
      // The keys here are FIELD NAMES, not keywords; only their values are schemas.
      for (const child of Object.values((value ?? {}) as Record<string, unknown>)) declaredKeywords(child, into);
      continue;
    }
    into.add(key);
    declaredKeywords(value, into);
  }
}

/**
 * Annotations carry no validation obligation, so ignoring them is correct rather
 * than a silent pass. Everything NOT listed here is treated as a promise the
 * validator has to keep.
 */
const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly",
  // `$defs` holds subschemas that are only reached through `$ref`; it asserts
  // nothing where it sits.
  "$defs", "definitions",
  // `format` is an ANNOTATION in JSON Schema by default — the specification
  // makes assertion behaviour opt-in (`format-assertion`), and implementations
  // are explicitly permitted to treat it as documentation. Every use here is
  // `date-time` on a field whose `type: "string"` IS enforced. So this is a
  // deliberate, spec-backed exemption rather than a keyword we quietly dropped.
  // If a schema ever needs `format` to actually reject, the honest move is to
  // implement it, not to widen this list.
  "format",
]);

test("no shipped contract schema declares a validation keyword the validator ignores", () => {
  const implemented = implementedKeywords();
  const offenders: string[] = [];

  for (const contract of CONTRACTS) {
    // Resolved through the registry's own helper, not by joining sourcePath:
    // several contracts ship by fileName alone, and a guard that silently
    // skipped those would be checking a subset while reporting a clean sweep.
    const file = contractPath(contract);
    const declared = new Set<string>();
    declaredKeywords(JSON.parse(readFileSync(file, "utf8")), declared);
    for (const keyword of [...declared].sort()) {
      if (ANNOTATIONS.has(keyword) || implemented.has(keyword)) continue;
      offenders.push(`${contract.name} (${path.relative(repoRoot, file)}) declares \`${keyword}\`, which validateValue never reads`);
    }
  }

  expect(offenders).toEqual([]);
});

test("the guard reads real schemas — an empty denominator would pass vacuously", () => {
  // Every previous instance of this defect class hid behind a check that looked
  // clean because it never looked at anything. This is the fifth place that
  // assertion has been needed and it is cheaper than the sixth time it is absent.
  expect(CONTRACTS.length).toBeGreaterThan(5);
  const implemented = implementedKeywords();
  expect(implemented.has("minItems")).toBe(true);
  expect(implemented.has("maxItems")).toBe(true);
  expect(implemented.size).toBeGreaterThan(8);
});

test("the guard fires on a keyword the validator does not implement", () => {
  // Non-vacuity from the other side: a fabricated schema using a keyword that is
  // genuinely absent must be caught. `multipleOf` is real JSON Schema and is not
  // implemented here — if someone implements it later, this assertion flips and
  // tells them to pick a different unimplemented keyword, which is the correct
  // amount of noise.
  const implemented = implementedKeywords();
  expect(implemented.has("multipleOf")).toBe(false);

  const declared = new Set<string>();
  declaredKeywords({ type: "object", properties: { n: { type: "number", multipleOf: 3 } } }, declared);
  expect(declared.has("multipleOf")).toBe(true);
  // And a FIELD called "multipleOf" must not be mistaken for the keyword.
  const fieldNamed = new Set<string>();
  declaredKeywords({ type: "object", properties: { multipleOf: { type: "number" } } }, fieldNamed);
  expect(fieldNamed.has("multipleOf")).toBe(false);
});
