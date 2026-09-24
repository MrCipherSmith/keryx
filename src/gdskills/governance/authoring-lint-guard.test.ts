// Flow 309, W1 Lane C — the authoring lint, run over the real shipped
// catalog rather than only fixtures.
//
// Two different bars, on purpose (per the dispatch's own instruction: "don't
// mass-edit the 72 skills"):
//
//   - STACK PACK skills (`stacks/*/skills/**`) are linted STRICT — every
//     rule is an error, `metadata.origin` included. None ship yet, so this
//     loop runs zero iterations today; it starts enforcing the moment the
//     first pack (Lane D's `python` pack) lands, with no code change needed
//     here.
//   - LEGACY bundled skills (the 72 under `skills/<category>/<name>/`) are
//     held to the checks they ALREADY pass today (measured below: name
//     shape, description shape/length, references depth) — those must stay
//     at zero findings, full stop. The rules today's tree does not yet
//     satisfy (`metadata.origin`, a handful of over-length bodies, one
//     "Use when"-less description, one reserved-word name) are a counted
//     RATCHET: the pinned ceiling here is today's count, and it may only be
//     lowered by a real fix, never raised to clear a finding — the same
//     rule `skill-length-ceilings.ts`'s header states for line-count
//     ceilings, applied to lint finding counts instead.

import { describe, expect, test } from "bun:test";
import { lintSkill, lintStackRule, STACK_EXTENSIONS } from "./authoring-lint";
import { loadSkillCatalog } from "./catalog-index";

const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
const legacySkills = catalog.filter((entry) => !(entry.category in STACK_EXTENSIONS) || isKnownLegacyCategory(entry.category));
const stackPackSkills = catalog.filter((entry) => entry.category in STACK_EXTENSIONS && !isKnownLegacyCategory(entry.category));

/** The 6 legacy categories `BUNDLED_GDSKILLS` ships under — everything else is a stack pack id. */
function isKnownLegacyCategory(category: string): boolean {
  return ["core", "orchestration", "review", "quality", "planning", "platform"].includes(category);
}

/** Rules the whole legacy catalog already satisfies today — regressing any of these to non-zero is a real defect, not a ratchet. */
const LEGACY_ZERO_FINDING_RULES = [
  "name-required",
  "name-length",
  "name-format",
  "name-matches-directory",
  "description-required",
  "description-length",
  "references-one-level",
] as const;

/**
 * Rules the legacy catalog does NOT yet satisfy, pinned to today's count.
 * Lower only when a real fix lands; never raise to silence a regression.
 * Measured 2026-09-24 (flow 309 T7) via `lintSkill(..., {strict:false})`
 * over all 72 bundled skills.
 */
const LEGACY_LINT_RATCHET: Readonly<Record<string, number>> = {
  "metadata-origin": 72,
  "body-length": 9,
  "description-use-when": 1,
  "name-reserved-word": 1,
};

describe("authoring lint over the real bundled catalog", () => {
  test("catalog is non-empty (denominator check)", () => {
    expect(legacySkills.length).toBeGreaterThan(50);
  });

  test("legacy skills: zero findings on the rules the catalog already satisfies", () => {
    const byRule: Record<string, number> = {};
    for (const entry of legacySkills) {
      const findings = lintSkill(entry.body, { path: entry.path, strict: false });
      for (const finding of findings) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
      }
    }
    for (const rule of LEGACY_ZERO_FINDING_RULES) {
      expect(byRule[rule] ?? 0).toBe(0);
    }
  });

  test("legacy skills: the not-yet-clean rules stay within their pinned ratchet", () => {
    const byRule: Record<string, number> = {};
    for (const entry of legacySkills) {
      const findings = lintSkill(entry.body, { path: entry.path, strict: false });
      for (const finding of findings) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
      }
    }
    for (const [rule, ceiling] of Object.entries(LEGACY_LINT_RATCHET)) {
      expect(byRule[rule] ?? 0).toBeLessThanOrEqual(ceiling);
    }
    // Every rule that actually fired on the legacy tree must be accounted for
    // by either the zero-finding set or the ratchet — an unlisted rule
    // firing means a NEW defect class the ratchet is silently swallowing.
    for (const rule of Object.keys(byRule)) {
      const isZeroRule = (LEGACY_ZERO_FINDING_RULES as readonly string[]).includes(rule);
      const isRatchetRule = rule in LEGACY_LINT_RATCHET;
      expect(isZeroRule || isRatchetRule).toBe(true);
    }
  });

  test("stack pack skills are linted strict (no packs ship yet, so this is a zero-iteration assertion of readiness)", () => {
    for (const entry of stackPackSkills) {
      const findings = lintSkill(entry.body, { path: entry.path, strict: true });
      const errors = findings.filter((finding) => finding.severity === "error");
      expect(errors).toEqual([]);
    }
  });

  test("STACK_EXTENSIONS names every stack this dispatch requires", () => {
    for (const stackId of ["python", "ts-js-node", "react", "go", "rust"]) {
      expect(STACK_EXTENSIONS[stackId]).toBeDefined();
    }
  });

  test("lintStackRule integrates cleanly with a well-formed fixture", () => {
    const rule = `---\nextends: common\npaths: ["**/*.py"]\nmetadata:\n  origin: authored\n---\n\nBody.\n`;
    expect(lintStackRule(rule, { path: "/tmp/pack/rules/coding-style.mdc", allowedExtensions: STACK_EXTENSIONS.python! })).toEqual([]);
  });
});
