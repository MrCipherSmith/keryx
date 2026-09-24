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
import type { EvalReport, EvalSpecFile, PackEvalDocument } from "./governance/eval";
import { checkStablePackGate, PACK_BEHAVIOR_PASS_FLOOR, validateEvalReport } from "./governance/eval";
import { exportProjectSkill } from "./export";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import { defaultBundledRoot } from "./bundled-eval";
import { loadBundledManifest } from "./manifest/manifest";
import { parseAgentFrontmatter } from "../agents/frontmatter";
import { buildAgentDefinition } from "../agents/schema";

const STACKS_ROOT = path.join(defaultBundledRoot(), "stacks");

interface PackJson {
  readonly id: string;
  readonly family: string;
  readonly modules: readonly string[];
  readonly detectionMarkers?: readonly string[];
  readonly provenance?: { readonly origin: string; readonly sourceRef?: string; readonly addedAt?: string };
  readonly stability: string;
  readonly skills: Readonly<Record<string, readonly string[]>>;
  readonly extends?: string;
}

/** The five lifecycle buckets every pack.json's `skills` map must carry a key for (flow 314, W4 Wave 4) — an empty array is fine, a missing key is not. */
const PACK_SKILL_LIFECYCLE_KEYS = ["implement", "test", "review", "build-fix", "migrate"] as const;

interface AgentRefsJson {
  readonly agents: readonly string[];
  readonly note?: string;
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

/** Loaded once — every real-tree test below reads the same bundled `install-manifest.json` (flow 314, T13b). */
const BUNDLED_MANIFEST = loadBundledManifest();

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

    // Flow 314, W4 Wave 4: every skill under stacks/*/skills/* ships an
    // `evals.json` beside SKILL.md that (a) parses, (b) carries >=10 trigger
    // prompts total with >=4 negatives, (c) carries >=1 behavior scenario,
    // and (d) never names a "model" grader in any behavior scenario's
    // `expected_behavior` — every grader is deterministic
    // (contains|regex|not-contains) so a scenario is machine-checkable
    // without a human-in-the-loop judge.
    test(`${packId}: every skills/*/evals.json exists, parses, and meets the trigger-bank/behavior/grader floors (flow 314 W4)`, () => {
      for (const name of skillDirNames(packDir)) {
        const evalsPath = path.join(packDir, "skills", name, "evals.json");
        expect(existsSync(evalsPath)).toBe(true);
        let spec: EvalSpecFile;
        expect(() => {
          spec = JSON.parse(readFileSync(evalsPath, "utf8")) as EvalSpecFile;
        }).not.toThrow();
        spec = JSON.parse(readFileSync(evalsPath, "utf8")) as EvalSpecFile;

        const positives = spec.triggers?.positive ?? [];
        const negatives = spec.triggers?.negative ?? [];
        expect(positives.length + negatives.length).toBeGreaterThanOrEqual(10);
        expect(negatives.length).toBeGreaterThanOrEqual(4);

        const scenarios = spec.scenarios ?? [];
        expect(scenarios.length).toBeGreaterThanOrEqual(1);

        for (const scenario of scenarios) {
          for (const expected of scenario.expected_behavior) {
            expect(expected.grader).not.toBe("model");
            expect(["contains", "regex", "not-contains"]).toContain(expected.grader);
          }
        }
      }
    });

    test(`${packId}: pack.json's skills map carries all five lifecycle keys (flow 314 W4)`, () => {
      const pack = readPackJson(packDir);
      for (const key of PACK_SKILL_LIFECYCLE_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(pack.skills, key)).toBe(true);
      }
    });

    // Flow 314, T13b: install-manifest.json and pack.json must agree on
    // which modules exist and what stability each one claims — a pack.json
    // hand-edited to "stable" while its install-manifest module is left
    // "experimental" (or vice versa) is exactly the drift that let
    // go/python ship "experimental" packs whose eval already cleared the
    // stable-pack gate.
    test(`${packId}: every install-manifest module in pack.json's "modules" exists in install-manifest.json with matching stability (flow 314 T13b)`, () => {
      const pack = readPackJson(packDir);
      for (const moduleId of pack.modules) {
        const module = BUNDLED_MANIFEST.modules[moduleId];
        expect(module, `install-manifest.json has no module "${moduleId}" (referenced by ${packId}/pack.json)`).toBeDefined();
        expect(
          String(module?.stability),
          `install-manifest.json module "${moduleId}" has stability "${module?.stability}" but ${packId}/pack.json says "${pack.stability}"`,
        ).toBe(String(pack.stability));
      }
    });

    test(`${packId}: pack.json's "extends", when present, names an existing pack dir (flow 314 W4)`, () => {
      const pack = readPackJson(packDir);
      if (pack.extends === undefined) return;
      const extendedDir = path.join(STACKS_ROOT, pack.extends);
      expect(existsSync(extendedDir)).toBe(true);
    });

    test(`${packId}: agent-refs.json's listed agents each resolve to a generated agent file with a matching origin.sourceRef (flow 314 W4)`, () => {
      const refsPath = path.join(packDir, "agent-refs.json");
      if (!existsSync(refsPath)) return;
      const pack = readPackJson(packDir);
      const refs = JSON.parse(readFileSync(refsPath, "utf8")) as AgentRefsJson;
      for (const agentName of refs.agents) {
        const agentPath = path.join(defaultBundledRoot(), "agents", `${agentName}.md`);
        expect(existsSync(agentPath)).toBe(true);
        const parsed = parseAgentFrontmatter(readFileSync(agentPath, "utf8"));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        const definition = buildAgentDefinition(parsed.result.data, parsed.result.body);
        expect(definition.origin?.kind).toBe("generated");
        expect(definition.origin?.sourceRef).toBe(pack.id);
      }
    });

    test(`${packId}: the stable-pack eval gate is not-applicable or passing (never a silent fail)`, () => {
      const pack = readPackJson(packDir);
      const result = checkStablePackGate(packDir, pack.stability);
      // python ships "experimental" today, so this is "not-applicable" — the
      // gate is proven to actually FIRE (not just early-return unexercised)
      // by the fixture tests below, which force stability: "stable".
      expect(result.status).not.toBe("fail");
    });

    // F21 (flow 309 review round 1): a new skill may be created on a scout
    // `create` decision freely, or on `use`/`fork` only with a recorded,
    // non-empty `justification` explaining why the existing match(es) were
    // not enough — see `scout.ts`'s `ScoutRecordEntry.justification` doc
    // comment for the policy statement. Enforced here over every scout
    // record this pack shipped, not just python-testing's.
    test(`${packId}: every non-"create" scout record carries a non-empty justification (F21 policy)`, () => {
      const record = readScoutRecord(packDir);
      for (const entry of record) {
        if (entry.decision === "create") continue;
        expect(entry.justification?.trim().length ?? 0).toBeGreaterThan(0);
      }
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

  // Flow 314, W4 Wave 4: negative fixtures proving the four new real-tree
  // checks above actually fire (missing evals.json, too few trigger prompts,
  // a "model" grader in a behavior scenario, a pack.json missing a lifecycle
  // key, a dangling "extends", and an agent-refs.json entry that does not
  // resolve/does not carry the right origin).

  function validEvalSpec(overrides: Partial<EvalSpecFile> = {}): EvalSpecFile {
    return {
      triggers: {
        positive: ["p1", "p2", "p3", "p4", "p5", "p6"],
        negative: ["n1", "n2", "n3", "n4"],
      },
      scenarios: [
        { id: "s1", prompt: "do the thing", strictness: "low", expected_behavior: [{ grader: "contains", value: "ok" }] },
      ],
      ...overrides,
    };
  }

  test("negative: a skill directory with no evals.json fails the evals.json-exists check", () => {
    const packDir = makeFixturePack();
    try {
      // fixture-skill has no SKILL.md/evals.json beyond the empty dir makeFixturePack created.
      expect(existsSync(path.join(packDir, "skills", "fixture-skill", "evals.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("negative: fewer than 10 total trigger prompts fails the trigger-bank-size check", () => {
    const spec = validEvalSpec({ triggers: { positive: ["p1", "p2"], negative: ["n1", "n2"] } });
    expect((spec.triggers?.positive.length ?? 0) + (spec.triggers?.negative.length ?? 0)).toBeLessThan(10);
  });

  test("negative: fewer than 4 negative trigger prompts fails the negatives-floor check", () => {
    const spec = validEvalSpec({
      triggers: { positive: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"], negative: ["n1", "n2"] },
    });
    expect(spec.triggers?.negative.length ?? 0).toBeLessThan(4);
  });

  test("negative: zero behavior scenarios fails the >=1-behavior-scenario check", () => {
    const spec = validEvalSpec({ scenarios: [] });
    expect(spec.scenarios?.length ?? 0).toBe(0);
  });

  test("negative: a 'model' grader in expected_behavior fails the deterministic-grader check", () => {
    const spec = validEvalSpec({
      scenarios: [
        { id: "s1", prompt: "do the thing", strictness: "low", expected_behavior: [{ grader: "model", value: "looks right" }] },
      ],
    });
    const graders = (spec.scenarios ?? []).flatMap((scenario) => scenario.expected_behavior.map((e) => e.grader));
    expect(graders).toContain("model");
  });

  test("negative: pack.json missing a lifecycle key fails the five-keys check", () => {
    const packDir = makeFixturePack();
    try {
      writeFileSync(
        path.join(packDir, "pack.json"),
        JSON.stringify({ id: "fixture-lang", family: "language", modules: [], stability: "experimental", skills: { implement: [], test: [] } }, null, 2),
        "utf8",
      );
      const pack = readPackJson(packDir);
      const missing = PACK_SKILL_LIFECYCLE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(pack.skills, key));
      expect(missing.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("negative: pack.json's 'extends' naming a nonexistent pack fails the extends-exists check", () => {
    const packDir = makeFixturePack();
    try {
      writeFileSync(
        path.join(packDir, "pack.json"),
        JSON.stringify(
          { id: "fixture-lang", family: "language", modules: [], stability: "experimental", skills: { implement: [], test: [], review: [], "build-fix": [], migrate: [] }, extends: "no-such-pack" },
          null,
          2,
        ),
        "utf8",
      );
      const pack = readPackJson(packDir);
      expect(pack.extends).toBeDefined();
      expect(existsSync(path.join(STACKS_ROOT, pack.extends!))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("negative: an agent-refs.json entry naming a nonexistent agent file fails the agent-refs check", () => {
    const packDir = makeFixturePack();
    try {
      writeFileSync(
        path.join(packDir, "agent-refs.json"),
        JSON.stringify({ agents: ["no-such-agent"] }, null, 2),
        "utf8",
      );
      const refs = JSON.parse(readFileSync(path.join(packDir, "agent-refs.json"), "utf8")) as AgentRefsJson;
      expect(existsSync(path.join(defaultBundledRoot(), "agents", `${refs.agents[0]}.md`))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("negative: an agent-refs.json entry resolving to an 'authored' (not 'generated') agent fails the origin check", () => {
    // A real shipped agent (e.g. codebase-navigator) is origin "authored", not
    // "generated" — using it as a stand-in agent-ref proves the origin check
    // fires against a real file, not just a fixture that was never written.
    const agentPath = path.join(defaultBundledRoot(), "agents", "codebase-navigator.md");
    expect(existsSync(agentPath)).toBe(true);
    const parsed = parseAgentFrontmatter(readFileSync(agentPath, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const definition = buildAgentDefinition(parsed.result.data, parsed.result.body);
    expect(definition.origin?.kind).not.toBe("generated");
  });

  // Flow 314, T13b: prove the pack.json / install-manifest.json stability
  // agreement check (added to the real-tree describe above) actually fires
  // — a fixture pack.json claiming "stable" while the real bundled manifest
  // module it names (ts-js-node-rules, itself "stable") is deliberately
  // compared against a mismatched claim to show the check would catch drift.
  test("negative: a pack.json module whose install-manifest stability disagrees with pack.json's own stability fails the agreement check", () => {
    const packDir = makeFixturePack();
    try {
      writeFileSync(
        path.join(packDir, "pack.json"),
        JSON.stringify(
          {
            id: "fixture-lang",
            family: "language",
            // ts-js-node-rules is a real install-manifest module, shipped "stable".
            modules: ["ts-js-node-rules"],
            stability: "experimental",
            skills: { implement: [], test: [], review: [], "build-fix": [], migrate: [] },
          },
          null,
          2,
        ),
        "utf8",
      );
      const pack = readPackJson(packDir);
      const module = BUNDLED_MANIFEST.modules[pack.modules[0]!];
      expect(module).toBeDefined();
      expect(module?.stability).not.toBe(pack.stability);
    } finally {
      cleanup();
    }
  });

  test("negative: a pack.json module that does not exist in install-manifest.json fails the agreement check", () => {
    const packDir = makeFixturePack();
    try {
      writeFileSync(
        path.join(packDir, "pack.json"),
        JSON.stringify(
          {
            id: "fixture-lang",
            family: "language",
            modules: ["no-such-manifest-module"],
            stability: "stable",
            skills: { implement: [], test: [], review: [], "build-fix": [], migrate: [] },
          },
          null,
          2,
        ),
        "utf8",
      );
      const pack = readPackJson(packDir);
      expect(BUNDLED_MANIFEST.modules[pack.modules[0]!]).toBeUndefined();
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

  // F19 (flow 309 review round 1): the ORIGINAL version of this test never
  // actually called the stable-pack gate — it wrote a fixture `pack.json`
  // with `stability: "stable"` and then only asserted the FIXTURE'S OWN
  // shape (`reread.stability === "stable"`, `eval.json` absent from disk).
  // It could not have caught a broken gate: nothing here invoked the gate
  // logic at all, and the real-tree test right above it never exercises the
  // "stable" branch either (python ships "experimental"). This is now a
  // fixture that IS "stable" run through the extracted `checkStablePackGate`
  // itself, alongside a companion "stable + passing eval.json" fixture that
  // proves the gate can also return "pass" — a gate that never once returns
  // "pass" in its own test suite is unproven in the other direction too.
  test("checkStablePackGate: a 'stable' pack with no governance/eval.json fails", () => {
    const packDir = makeFixturePack();
    try {
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toMatch(/missing/);
    } finally {
      cleanup();
    }
  });

  test("checkStablePackGate: a 'stable' pack with a valid, passing eval.json passes", () => {
    const packDir = makeFixturePack();
    try {
      const report: EvalReport = {
        schemaVersion: "1.0.0",
        skillId: "fixture-lang/fixture-skill",
        strictness: "low",
        trials: 3,
        triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 1 },
        evidence: "authored",
        scenarios: [
          { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
          { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        ],
        verdict: "pass",
      };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(report, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("pass");
    } finally {
      cleanup();
    }
  });

  test("checkStablePackGate: a non-'stable' pack is not-applicable, never a silent pass or fail", () => {
    const packDir = makeFixturePack();
    try {
      const result = checkStablePackGate(packDir, "experimental");
      expect(result.status).toBe("not-applicable");
    } finally {
      cleanup();
    }
  });

  test("checkStablePackGate: a 'stable' pack whose eval.json verdict is 'fail' fails the gate", () => {
    const packDir = makeFixturePack();
    try {
      const report: EvalReport = {
        schemaVersion: "1.0.0",
        skillId: "fixture-lang/fixture-skill",
        strictness: "low",
        trials: 3,
        triggerAccuracy: { truePositive: 0, falsePositive: 1, positives: 1, negatives: 1 },
        evidence: "authored",
        scenarios: [
          { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 0, passRate: 0, passAtK: 0, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
          { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 0, passRate: 0, passAtK: 0, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        ],
        verdict: "fail",
      };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(report, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("fail");
    } finally {
      cleanup();
    }
  });

  // Flow 314, W4 Wave 4: the pack-level eval.json form (`{ schemaVersion,
  // reports: EvalReport[] }`) — `checkStablePackGate` must require every
  // skill pack.json lists to carry a passing, authored report with every ran
  // behavior scenario clearing `PACK_BEHAVIOR_PASS_FLOOR` (>= 0.8, citing
  // metrics-and-validation.md's "pass@3 >= 80%").

  function writePackJson(packDir: string, skills: Readonly<Record<string, readonly string[]>>): void {
    writeFileSync(
      path.join(packDir, "pack.json"),
      JSON.stringify(
        { id: "fixture-lang", family: "language", modules: [], stability: "stable", skills },
        null,
        2,
      ),
      "utf8",
    );
  }

  function passingSkillReport(skillId: string, behaviorPassRate: number): EvalReport {
    return {
      schemaVersion: "1.0.0",
      skillId,
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 1 },
      evidence: "authored",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        { id: "behavior-1", kind: "behavior", prompt: "do the thing", strictness: "low", trials: 3, passes: Math.round(behaviorPassRate * 3), passRate: behaviorPassRate, passAtK: behaviorPassRate > 0 ? 1 : 0, grader: "contains", status: "ran" },
      ],
      verdict: behaviorPassRate >= 0.5 ? "pass" : "fail",
    };
  }

  test("checkStablePackGate (pack-level doc): every listed skill passing, every behavior scenario >= floor -> pass", () => {
    const packDir = makeFixturePack();
    try {
      writePackJson(packDir, { implement: ["fixture-skill"], test: [], review: [], "build-fix": [], migrate: [] });
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport("fixture-lang/fixture-skill", 1)],
      };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(doc, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("pass");
    } finally {
      cleanup();
    }
  });

  test("checkStablePackGate (pack-level doc): a skill listed in pack.json with no matching report fails, naming the skill", () => {
    const packDir = makeFixturePack();
    try {
      writePackJson(packDir, { implement: ["fixture-skill", "second-skill"], test: [], review: [], "build-fix": [], migrate: [] });
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport("fixture-lang/fixture-skill", 1)],
      };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(doc, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("second-skill");
    } finally {
      cleanup();
    }
  });

  test(`checkStablePackGate (pack-level doc): a behavior scenario below PACK_BEHAVIOR_PASS_FLOOR (${PACK_BEHAVIOR_PASS_FLOOR}) fails`, () => {
    const packDir = makeFixturePack();
    try {
      writePackJson(packDir, { implement: ["fixture-skill"], test: [], review: [], "build-fix": [], migrate: [] });
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport("fixture-lang/fixture-skill", 0.6)],
      };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(doc, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toMatch(/below the pack floor/);
    } finally {
      cleanup();
    }
  });

  test("checkStablePackGate (pack-level doc): a report with synthesized evidence fails even if its verdict were 'pass'", () => {
    const packDir = makeFixturePack();
    try {
      writePackJson(packDir, { implement: ["fixture-skill"], test: [], review: [], "build-fix": [], migrate: [] });
      const report = passingSkillReport("fixture-lang/fixture-skill", 1);
      // A synthesized-evidence report is REFUSED verdict "pass" by
      // `validateEvalReport` itself (F5) — so a hand-edited doc claiming both
      // is caught either by that contract check or by the evidence check;
      // this fixture proves the pack gate rejects it either way (never a
      // silent pass through the pack-level branch).
      const synthesized: EvalReport = { ...report, evidence: "synthesized" };
      const doc: PackEvalDocument = { schemaVersion: "1.0.0", reports: [synthesized] };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(doc, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("fail");
    } finally {
      cleanup();
    }
  });

  // F19: "empty scenarios must not pass" — a report whose `triggerAccuracy`
  // CLAIMS prompts were checked but carries no matching `scenarios` entries
  // used to validate clean (`validateEvalReport(report)` returned `[]`).
  test("validateEvalReport rejects a report whose scenarios are empty but triggerAccuracy claims otherwise", () => {
    const report: EvalReport = {
      schemaVersion: "1.0.0",
      skillId: "fixture/fixture-skill",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 0, falsePositive: 1, positives: 1, negatives: 1 },
      evidence: "authored",
      scenarios: [],
      verdict: "fail",
    };
    const errors = validateEvalReport(report);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.includes("trigger scenario"))).toBe(true);
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
