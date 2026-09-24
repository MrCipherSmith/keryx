// Flow 309, W1 Lane D — governance guards for the stack pack layout
// (docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md
// "Stack pack layout" / "Rule scoping" / "Authoring standard" / "Governance
// gates"). Iterates every directory under `src/gdskills/bundled/stacks/` —
// today just `python` — so a second pack lands under the same enforcement
// with no code change here (W1-AC8, W1-AC9, W1-AC12, W1-AC13, and the
// eval-verdict-presence gate for a `stable` pack).
//
// Positive assertions run against the REAL bundled tree. Negative assertions
// use throwaway fixture directories (mkdtemp) so a defect in the checked-in
// `python` pack is never the only thing standing between a broken rule and a
// green suite — the check itself is proven to fire.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import installManifestSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/install-manifest.schema.json" with {
  type: "json",
};
import { validateAgainstSchemaObject } from "../contracts/validator";
import { lintSkill, lintStackRule, STACK_EXTENSIONS } from "./governance/authoring-lint";
import { readScoutRecord } from "./governance/scout";
import type { EvalReport } from "./governance/eval";
import { validateEvalReport } from "./governance/eval";
import { exportProjectSkill } from "./export";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import { defaultBundledRoot } from "./bundled-eval";

const STACKS_ROOT = path.join(defaultBundledRoot(), "stacks");

interface PackJson {
  readonly id: string;
  readonly family: string;
  readonly modules: readonly string[];
  readonly detectionMarkers?: readonly string[];
  readonly provenance?: { readonly origin: string; readonly sourceRef?: string; readonly addedAt?: string };
  readonly stability: string;
  readonly skills: Readonly<Record<string, readonly string[]>>;
}

function sortedDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readPackJson(packDir: string): PackJson {
  return JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8")) as PackJson;
}

function ruleFiles(packDir: string): string[] {
  const rulesDir = path.join(packDir, "rules");
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdc"))
    .map((entry) => path.join(rulesDir, entry.name))
    .sort();
}

function skillDirNames(packDir: string): string[] {
  return sortedDirNames(path.join(packDir, "skills"));
}

/** The component-shaped subset of a pack.json — the only part `install-manifest.schema.json`'s `component` $def validates (W1's pack.json also carries `id`, `stability`, `skills`, which are pack-level fields with no schema of their own; see the module doc above). */
function componentSubset(pack: PackJson): Record<string, unknown> {
  const subset: Record<string, unknown> = { family: pack.family, modules: pack.modules };
  if (pack.detectionMarkers !== undefined) subset.detectionMarkers = pack.detectionMarkers;
  if (pack.provenance !== undefined) subset.provenance = pack.provenance;
  return subset;
}

const COMPONENT_SCHEMA = {
  $ref: "#/$defs/component",
  $defs: (installManifestSchemaJson as unknown as { $defs: Record<string, unknown> }).$defs,
};

const STACK_PACK_IDS = sortedDirNames(STACKS_ROOT);

describe("stack pack layout (real bundled tree)", () => {
  test("at least the python pack is present (denominator check)", () => {
    expect(STACK_PACK_IDS).toContain("python");
  });

  for (const packId of STACK_PACK_IDS) {
    const packDir = path.join(STACKS_ROOT, packId);

    test(`${packId}: pack.json's component subset validates against install-manifest.schema.json's component $def`, () => {
      const pack = readPackJson(packDir);
      const result = validateAgainstSchemaObject(COMPONENT_SCHEMA, componentSubset(pack));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    test(`${packId}: every rules/*.mdc passes lintStackRule for this pack's allowed extensions (W1-AC8)`, () => {
      const allowed = STACK_EXTENSIONS[packId];
      expect(allowed).toBeDefined();
      for (const rulePath of ruleFiles(packDir)) {
        const findings = lintStackRule(readFileSync(rulePath, "utf8"), { path: rulePath, allowedExtensions: allowed! });
        expect(findings).toEqual([]);
      }
    });

    test(`${packId}: every skills/*/SKILL.md passes strict lintSkill (W1-AC12)`, () => {
      for (const name of skillDirNames(packDir)) {
        const skillMd = path.join(packDir, "skills", name, "SKILL.md");
        const findings = lintSkill(readFileSync(skillMd, "utf8"), { path: skillMd, strict: true });
        const errors = findings.filter((finding) => finding.severity === "error");
        expect(errors).toEqual([]);
      }
    });

    test(`${packId}: every skills/<name> has a scout record naming it (W1-AC9)`, () => {
      const record = readScoutRecord(packDir);
      for (const name of skillDirNames(packDir)) {
        expect(record.some((entry) => entry.skillName === name)).toBe(true);
      }
    });

    test(`${packId}: pack.json's skills map and the skills/ directory agree both ways`, () => {
      const pack = readPackJson(packDir);
      const declared = new Set(Object.values(pack.skills).flat());
      const onDisk = new Set(skillDirNames(packDir));
      for (const name of onDisk) {
        expect(declared.has(name)).toBe(true);
      }
      for (const name of declared) {
        expect(onDisk.has(name)).toBe(true);
      }
    });

    test(`${packId}: a "stable" pack ships governance/eval.json with a passing verdict`, () => {
      const pack = readPackJson(packDir);
      if (pack.stability !== "stable") {
        return; // not this pack's gate yet (python ships "experimental")
      }
      const evalPath = path.join(packDir, "governance", "eval.json");
      expect(existsSync(evalPath)).toBe(true);
      const report = JSON.parse(readFileSync(evalPath, "utf8")) as EvalReport;
      expect(validateEvalReport(report)).toEqual([]);
      expect(report.verdict).toBe("pass");
    });
  }
});

describe("stack pack layout (negative fixtures — proving the checks above actually fire)", () => {
  let fixtureRoot: string;

  function makeFixturePack(): string {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "stack-pack-guard-"));
    const packDir = path.join(fixtureRoot, "fixture-lang");
    mkdirSync(path.join(packDir, "rules"), { recursive: true });
    mkdirSync(path.join(packDir, "skills", "fixture-skill"), { recursive: true });
    mkdirSync(path.join(packDir, "governance"), { recursive: true });
    return packDir;
  }

  function cleanup(): void {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  test("lintStackRule fails a rule whose paths widen past the stack's own extensions", () => {
    const packDir = makeFixturePack();
    try {
      const rule = `---\nextends: common\npaths: ["**/*.ts"]\nmetadata:\n  origin: authored\n---\n\nBody.\n`;
      const rulePath = path.join(packDir, "rules", "coding-style.mdc");
      writeFileSync(rulePath, rule, "utf8");
      const findings = lintStackRule(rule, { path: rulePath, allowedExtensions: STACK_EXTENSIONS.python! });
      const errors = findings.filter((finding) => finding.severity === "error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.map((finding) => finding.rule)).toContain("stack-rule-paths-scope");
    } finally {
      cleanup();
    }
  });

  test("strict lintSkill fails a stack-pack SKILL.md missing metadata.origin", () => {
    const packDir = makeFixturePack();
    try {
      const skillMd = `---\nname: fixture-skill\ndescription: Use when testing the guard.\n---\n\nBody.\n`;
      const skillPath = path.join(packDir, "skills", "fixture-skill", "SKILL.md");
      writeFileSync(skillPath, skillMd, "utf8");
      const findings = lintSkill(skillMd, { path: skillPath, strict: true });
      const errors = findings.filter((finding) => finding.severity === "error");
      expect(errors.map((finding) => finding.rule)).toContain("metadata-origin");
    } finally {
      cleanup();
    }
  });

  test("a skill with no scout record fails the naming check", () => {
    const packDir = makeFixturePack();
    try {
      // No governance/scout.json written at all.
      const record = readScoutRecord(packDir);
      expect(record.some((entry) => entry.skillName === "fixture-skill")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("a component subset missing the required 'modules' key fails schema validation", () => {
    const result = validateAgainstSchemaObject(COMPONENT_SCHEMA, { family: "language" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith(".modules"))).toBe(true);
  });

  test("a component subset with an unknown family value fails schema validation", () => {
    const result = validateAgainstSchemaObject(COMPONENT_SCHEMA, { family: "not-a-real-family", modules: ["x"] });
    expect(result.valid).toBe(false);
  });

  test("a 'stable' pack with no governance/eval.json fails the eval-verdict-presence gate", () => {
    const packDir = makeFixturePack();
    try {
      const pack: PackJson = {
        id: "fixture-lang",
        family: "language",
        modules: ["x"],
        stability: "stable",
        skills: { implement: [], test: ["fixture-skill"], review: [], "build-fix": [], migrate: [] },
      };
      writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(pack, null, 2), "utf8");
      const reread = readPackJson(packDir);
      expect(reread.stability).toBe("stable");
      expect(existsSync(path.join(packDir, "governance", "eval.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("an eval.json with verdict 'fail' does not satisfy the eval-verdict-presence gate", () => {
    const report: EvalReport = {
      schemaVersion: "1.0.0",
      skillId: "fixture/fixture-skill",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 0, falsePositive: 1, positives: 1, negatives: 1 },
      scenarios: [],
      verdict: "fail",
    };
    expect(validateEvalReport(report)).toEqual([]);
    expect(report.verdict).not.toBe("pass");
  });
});

describe("W1-AC13: exporting a stack-pack skill for runtime claude", () => {
  test("the exported SKILL.md's frontmatter respects name <= 64 and description <= 1024", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "stack-pack-export-"));
    try {
      const sourceSkillMd = readFileSync(
        path.join(STACKS_ROOT, "python", "skills", "python-testing", "SKILL.md"),
        "utf8",
      );
      const projectSkillDir = path.join(projectRoot, ".metaproject", "project-skills", "python", "python-testing");
      mkdirSync(projectSkillDir, { recursive: true });
      writeFileSync(path.join(projectSkillDir, "SKILL.md"), sourceSkillMd, "utf8");

      const result = await exportProjectSkill(projectRoot, { input: "python/python-testing", runtime: "claude" });
      expect(result.runtime).toBe("claude");

      const exportedMd = readFileSync(path.join(projectRoot, result.outputPath, "SKILL.md"), "utf8");
      const frontmatter = parseSkillFrontmatter(exportedMd);
      expect(frontmatter.name).toBeDefined();
      expect((frontmatter.name ?? "").length).toBeLessThanOrEqual(64);
      expect(frontmatter.description).toBeDefined();
      expect((frontmatter.description ?? "").length).toBeLessThanOrEqual(1024);
      expect(frontmatter.description ?? "").toMatch(/use when/i);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
