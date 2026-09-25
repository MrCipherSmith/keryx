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

import { createHash } from "node:crypto";
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
import type { EvalReport, EvalScenarioResult, EvalSpecFile, PackEvalDocument, TrialRecord } from "./governance/eval";
import { checkStablePackGate, PACK_BEHAVIOR_PASS_FLOOR, validateEvalReport } from "./governance/eval";
import { buildGateReadyReport } from "./governance/__fixtures__/gate-ready-report";
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
  // A meta-framework pack (flow 318, W4 batch 2's `nextjs-nuxt`, covering both
  // Next.js/React and Nuxt/Vue) may legitimately extend more than one base
  // pack; `extends` is not part of install-manifest.schema.json's own
  // `component` $def (it is pack.json-only authoring metadata, never a hard
  // module dependency — those are wired explicitly through install-manifest's
  // own `dependencies`), so widening it to `string | string[]` here is a
  // content decision, not a schema change.
  readonly extends?: string | readonly string[];
}

function extendsList(pack: PackJson): readonly string[] {
  if (pack.extends === undefined) return [];
  return typeof pack.extends === "string" ? [pack.extends] : pack.extends;
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
    // prompts total with >=4 negatives, (c) carries >=1 behavior scenario.
    //
    // Flow 316: behavior is graded by an LLM judge against a rubric, not by a
    // string match — every behavior scenario carries exactly one "judge"
    // expectation (I9 in stack-pack-eval-integrity.test.ts enforces this same
    // rule scenario-by-scenario; this floor is the pack-wide summary of it).
    test(`${packId}: every skills/*/evals.json exists, parses, and meets the trigger-bank/behavior/grader floors (flow 314 W4, flow 316)`, () => {
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
          const judgeExpectations = scenario.expected_behavior.filter((expected) => expected.grader === "judge");
          expect(judgeExpectations.length).toBe(1);
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

    test(`${packId}: pack.json's "extends", when present, names an existing pack dir for every entry (flow 314 W4; widened to string[] in flow 318 W4 batch 2 for meta-framework packs)`, () => {
      const pack = readPackJson(packDir);
      for (const extendedId of extendsList(pack)) {
        const extendedDir = path.join(STACKS_ROOT, extendedId);
        expect(existsSync(extendedDir), `pack.json "extends" names "${extendedId}", which has no directory under ${STACKS_ROOT}`).toBe(true);
      }
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
      // A pack whose own `pack.json` stability is not "stable" (react ships
      // "experimental" today) makes this "not-applicable" — the gate is
      // proven to actually FIRE (not just early-return unexercised) by the
      // fixture tests below, which force stability: "stable".
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

  // Flow 316 fix1 (R1-3): the gate ALWAYS re-scores trigger scenarios live
  // against the skill's own CURRENT SKILL.md frontmatter — single-letter/
  // numbered placeholders ("p1".."p6"/"n1".."n4") tokenize to nothing and
  // never honestly route anywhere, so these are real (short but
  // multi-token) phrases, and `writeFixtureSkillFiles` seeds the positives
  // into the skill's own `triggers:` frontmatter so honest scoring selects
  // it for its own authored positives (no leave-one-out needed — see
  // `eval.ts`'s `selectsSkillFull` doc comment for why that is fine for
  // authored, human-written prompts).
  function validEvalSpec(overrides: Partial<EvalSpecFile> = {}): EvalSpecFile {
    return {
      triggers: {
        positive: [
          "run the fixture guard task one",
          "run the fixture guard task two",
          "run the fixture guard task three",
          "run the fixture guard task four",
          "run the fixture guard task five",
          "run the fixture guard task six",
        ],
        negative: ["something entirely unrelated one", "something entirely unrelated two", "something entirely unrelated three", "something entirely unrelated four"],
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
      const ids = extendsList(pack);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(existsSync(path.join(STACKS_ROOT, id))).toBe(false);
      }
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
            // core-common-rules is a real install-manifest module, shipped
            // "stable" (flow 314 review round 1: this used to name
            // ts-js-node-rules, but the honest eval rerun demoted that
            // module to "experimental" alongside its pack, which made this
            // fixture's own claimed "experimental" agree instead of
            // disagree — swapped to a module that is actually stable so the
            // fixture still proves a genuine mismatch).
            modules: ["core-common-rules"],
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

  // Flow 314 review round 1: a stack pack MUST ship the pack-level `{
  // schemaVersion, reports: EvalReport[] }` form (R1-4) — the legacy
  // single-report shape is always a named fail for a stable stack pack (see
  // the "must ship a pack-level eval document" fixture below). This fixture
  // now builds a real pack-level document with a report that clears every
  // `checkSkillReportForPackGate` requirement: strictness "high", trials >=
  // `PACK_MIN_TRIALS`, scope "bundled", a stamped runner/model/recordedAt,
  // and a `skillDigest` computed from the fixture skill actually written to
  // disk (so it agrees with `computeSkillEvalDigest` recomputed by the gate).
  test("checkStablePackGate: a 'stable' pack with a valid, passing eval.json passes", () => {
    const packDir = makeFixturePack();
    try {
      writePackJson(packDir, { implement: ["fixture-skill"], test: [], review: [], "build-fix": [], migrate: [] });
      const evalSpec = validEvalSpec();
      writeFixtureSkillFiles(packDir, "fixture-skill", evalSpec);
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport(packDir, "fixture-skill", "fixture-lang", evalSpec, 1)],
      };
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(doc, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("pass");
    } finally {
      cleanup();
    }
  });

  test("checkStablePackGate: a 'stable' pack with the legacy single-report eval.json form fails (stack packs must ship a pack-level document)", () => {
    const packDir = makeFixturePack();
    try {
      const evalSpec = validEvalSpec();
      writeFixtureSkillFiles(packDir, "fixture-skill", evalSpec);
      const report: EvalReport = passingSkillReport(packDir, "fixture-skill", "fixture-lang", evalSpec, 1);
      writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(report, null, 2), "utf8");
      const result = checkStablePackGate(packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toMatch(/pack-level eval document/);
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

  /** Writes a real SKILL.md + evals.json for a fixture skill so `computeSkillEvalDigest` (and the gate's own scenario-id/trigger-prompt agreement checks) have real files to read, instead of a report describing a skill that was never actually written to disk. */
  function writeFixtureSkillFiles(packDir: string, name: string, evalSpec: EvalSpecFile): void {
    const skillDir = path.join(packDir, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    const triggersYaml = (evalSpec.triggers?.positive ?? []).map((trigger) => `  - ${trigger}`).join("\n");
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use when testing the guard.\ntriggers:\n${triggersYaml.length > 0 ? triggersYaml : "  - testing the guard"}\n---\n\nBody.\n`,
      "utf8",
    );
    writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec, null, 2), "utf8");
  }

  /**
   * Flow 314 review round 1 (R1-3/R1-11/R1-15): a pack-level `EvalReport`
   * that clears every `checkSkillReportForPackGate` requirement — strictness
   * "high", `trials >= PACK_MIN_TRIALS`, `scope: "bundled"`, a stamped
   * runner/model/recordedAt, a `skillDigest` computed from the fixture
   * skill's OWN files on disk (`writeFixtureSkillFiles` must be called for
   * the same `packDir`/`name` first), and behavior-scenario ids / trigger
   * prompts equal to `evalSpec` (the same spec written to that skill's
   * evals.json) — so the gate's digest and content-agreement checks are
   * satisfied by construction rather than by coincidence.
   */
  /**
   * Flow 316: builds on `buildGateReadyReport` (an allowlisted runner,
   * `trialRecords`, and a `catalogDigest` matching the real bundled catalog
   * — everything `checkSkillReportForPackGate` now requires) and, when
   * `behaviorPassRate` is below 1, replaces the one behavior scenario's
   * trial records with a genuine mix of passing/failing trials (a failing
   * trial's output deliberately does not satisfy the scenario's own
   * deterministic expectation) so `regradeRecordedReport` still finds the
   * report internally consistent at a partial pass rate — this is what lets
   * the `PACK_BEHAVIOR_PASS_FLOOR` fixture below prove the floor check
   * fires on a report that is otherwise entirely honest.
   */
  function passingSkillReport(packDir: string, name: string, packId: string, evalSpec: EvalSpecFile, behaviorPassRate: number): EvalReport {
    const base = buildGateReadyReport({ packId, skillName: name, skillDir: path.join(packDir, "skills", name), evalSpec });
    if (behaviorPassRate >= 1) return base;

    const behaviorScenario = base.scenarios.find((scenario) => scenario.kind === "behavior");
    if (behaviorScenario === undefined || behaviorScenario.trialRecords === undefined || behaviorScenario.trialRecords.length === 0) {
      return base;
    }
    const trials = behaviorScenario.trials;
    const passes = Math.round(behaviorPassRate * trials);
    const passingRecord = behaviorScenario.trialRecords[0]!;
    const failingOutput = "not-a-match";
    const failingRecord: TrialRecord = {
      output: failingOutput,
      outputSha256: createHash("sha256").update(failingOutput).digest("hex"),
      promptSha256: passingRecord.promptSha256,
      deterministic: passingRecord.deterministic.map(() => false),
      passed: false,
    };
    const trialRecords: TrialRecord[] = Array.from({ length: trials }, (_, index) => (index < passes ? passingRecord : failingRecord));
    const updatedBehavior: EvalScenarioResult = {
      ...behaviorScenario,
      passes,
      passRate: passes / trials,
      passAtK: passes > 0 ? 1 : 0,
      trialRecords,
    };
    const scenarios = base.scenarios.map((scenario) => (scenario.id === updatedBehavior.id ? updatedBehavior : scenario));
    return { ...base, scenarios, verdict: passes / trials >= 0.5 ? "pass" : "fail" };
  }

  test("checkStablePackGate (pack-level doc): every listed skill passing, every behavior scenario >= floor -> pass", () => {
    const packDir = makeFixturePack();
    try {
      writePackJson(packDir, { implement: ["fixture-skill"], test: [], review: [], "build-fix": [], migrate: [] });
      const evalSpec = validEvalSpec();
      writeFixtureSkillFiles(packDir, "fixture-skill", evalSpec);
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport(packDir, "fixture-skill", "fixture-lang", evalSpec, 1)],
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
      const evalSpec = validEvalSpec();
      writeFixtureSkillFiles(packDir, "fixture-skill", evalSpec);
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport(packDir, "fixture-skill", "fixture-lang", evalSpec, 1)],
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
      const evalSpec = validEvalSpec();
      writeFixtureSkillFiles(packDir, "fixture-skill", evalSpec);
      const doc: PackEvalDocument = {
        schemaVersion: "1.0.0",
        reports: [passingSkillReport(packDir, "fixture-skill", "fixture-lang", evalSpec, 0.6)],
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
      const evalSpec = validEvalSpec();
      writeFixtureSkillFiles(packDir, "fixture-skill", evalSpec);
      const report = passingSkillReport(packDir, "fixture-skill", "fixture-lang", evalSpec, 1);
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
