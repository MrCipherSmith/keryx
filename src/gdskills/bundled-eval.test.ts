// Flow 207, AC7 + AC8 — the bundled tree is evaluated, and the evaluator bites.
//
// AC7 is the sweep: all 65 shipped `SKILL.md` files, with the denominator
// asserted so a renamed directory cannot turn "nothing found" into a pass.
//
// AC8 is the part that decides whether AC7 means anything. An evaluator that
// approves everything measures nothing, so the fixture below is a skill tree
// built to fail — one violation per check, plus a CONTROL skill in the same tree
// that is correct. Both halves matter: the broken skills prove the checks fire,
// and the control proves they do not fire on everything, which is the same
// defect from the other direction.
//
// The fixture is written into a temp directory rather than committed, for two
// reasons. A broken `SKILL.md` on disk under `src/gdskills/` would be swept by
// `bundled-no-persona.test.ts` and by `model-tier.test.ts`, and a file that
// exists to be wrong is a file somebody eventually ships. Writing it here also
// forces `evaluateBundledTree` to take its root as an argument, which is what
// lets the SAME code evaluate the fixture and the real tree — a second
// implementation for the negative case could pass while the real sweep is broken.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUNDLED_SKILL_CHECKS,
  GENERATED_PATH_ROOTS,
  KNOWN_EXTERNAL_SKILL_REFERENCES,
  type BundledSkillCheck,
  bundledSkillFiles,
  defaultBundledRoot,
  evaluateBundledTree,
  homePathOffenders,
  personaOffenders,
  renderBundledEvaluation,
} from "./bundled-eval";

// ---------------------------------------------------------------------------
// AC7: the real tree
// ---------------------------------------------------------------------------

describe("AC7: the bundled skill tree is evaluated, over a real denominator", () => {
  test("the sweep walks the whole shipped tree", () => {
    // `bundledSkillFiles` returns `[]` for a missing root, so every assertion
    // below would pass vacuously over a renamed directory. The count is the
    // guard on the guard, and 65 is the number the roadmap names.
    const files = bundledSkillFiles(path.join(defaultBundledRoot(), "skills"));
    expect(files.length).toBe(65);

    const evaluation = evaluateBundledTree();
    expect(evaluation.skills).toBe(files.length);
    expect(evaluation.skillNames.length).toBe(files.length);
    // Every category the tree ships is represented, so a sweep that silently
    // walked one subdirectory cannot pass.
    for (const category of ["orchestration", "planning", "platform", "quality", "review"]) {
      expect(files.some((file) => file.includes(`${path.sep}${category}${path.sep}`))).toBe(true);
    }
  });

  test("every shipped skill passes structural validation", () => {
    const evaluation = evaluateBundledTree();
    // Rendered rather than counted: a failure has to name the file and the line,
    // because the only useful form of this failure is one somebody can act on.
    const report = evaluation.findings
      .map((finding) => `${finding.file}:${finding.line ?? "-"} [${finding.check}] ${finding.message}`)
      .join("\n");
    expect(report).toBe("");
    expect(evaluation.findings).toEqual([]);
  });

  test("the report says which layer this is, and which two it is not", () => {
    // AC12: the prose this flow adds must be checkable. A report that lists
    // passing checks and stops reads as a quality verdict; these sentences are
    // the difference, and a rewrite that drops them fails here.
    const rendered = renderBundledEvaluation(evaluateBundledTree());
    expect(rendered).toContain("layer 1 of 3");
    expect(rendered).toContain("STRUCTURAL validation only");
    expect(rendered).toMatch(/judge across named dimensions \(layer 2\)/);
    expect(rendered).toMatch(/reliability over repeated runs \(layer 3\)/);
    expect(rendered).toContain("A clean report here is not a quality claim.");
  });

  test("an empty root reports that nothing was evaluated, not that nothing was wrong", () => {
    const empty = evaluateBundledTree(path.join(tmpdir(), "keryx-bundled-eval-absent-root"));
    expect(empty.skills).toBe(0);
    expect(empty.findings).toEqual([]);
    // `findings: 0` over `skills: 0` is the exact failure this flow exists to
    // stop, so the renderer must refuse to let it read as a pass.
    expect(renderBundledEvaluation(empty)).toContain("NOTHING WAS EVALUATED");
  });
});

// ---------------------------------------------------------------------------
// AC8: a skill that deserves to fail, and the reasons it fails for
// ---------------------------------------------------------------------------

/**
 * One deliberately broken skill.
 *
 * Every line marked `VIOLATION` trips exactly one named check. The comments are
 * not decoration: when a check is later loosened, the assertion below goes red
 * and this file says which sentence stopped being enforced.
 */
const BROKEN_SKILL = `---
name: broken-example
metadata:
  version: 1.0.0
model: claude-opus-5
---

# Broken Example

VIOLATION frontmatter:description — the required field is absent above.
VIOLATION model:concrete-declaration — the frontmatter names a model id.
VIOLATION persona:name — this paragraph asks for a boss review.
VIOLATION persona:marker — and calls the result ducttape.
VIOLATION path:personal-home — read /home/altsay/keryx/notes.md first.
VIOLATION xref:skill — Launch \`does-not-exist\` skill on the diff.
VIOLATION xref:path — write findings per \`skills/review-orchestrator/reviewer-finding.schema.json\`.
`;

const NO_FRONTMATTER_SKILL = `# No Frontmatter

VIOLATION frontmatter:block — the file opens with a heading, not with \`---\`.
`;

const EMPTY_NAME_SKILL = `---
name:
description: A skill whose name field is present but carries nothing.
metadata:
  version: 1.0.0
---

# Empty Name
`;

const VERSIONLESS_METADATA_SKILL = `---
name: versionless-metadata
description: A skill whose metadata block declares no version.
metadata:
  audience: everyone
---

# Versionless Metadata
`;

const DUPLICATE_NAME_SKILL = `---
name: collides
description: Two skills declaring one name.
metadata:
  version: 1.0.0
---

# Collides
`;

/**
 * The control. Correct in every respect the evaluator checks, and sitting in the
 * SAME fixture tree as the broken ones — so "the evaluator rejected the fixture"
 * cannot be satisfied by an evaluator that rejects everything it is shown.
 */
const CONTROL_SKILL = `---
name: control-example
description: A structurally correct skill, used to prove the checks are selective.
metadata:
  version: 1.0.0
---

# Control Example

Reads \`skills/quality/control-example/SKILL.md\` — a path that resolves inside
this tree — and mentions \`review-logic\` without asking for it as a skill.
`;

let fixtureRoot = "";

function writeSkill(root: string, category: string, name: string, body: string): void {
  const dir = path.join(root, "skills", category, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

beforeAll(() => {
  // Temp root, never the operator's home: this tree exists to be wrong.
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "keryx-bundled-eval-fixture-"));
  writeSkill(fixtureRoot, "quality", "broken-example", BROKEN_SKILL);
  writeSkill(fixtureRoot, "quality", "no-frontmatter", NO_FRONTMATTER_SKILL);
  writeSkill(fixtureRoot, "quality", "empty-name", EMPTY_NAME_SKILL);
  writeSkill(fixtureRoot, "quality", "versionless-metadata", VERSIONLESS_METADATA_SKILL);
  writeSkill(fixtureRoot, "quality", "collides-a", DUPLICATE_NAME_SKILL);
  writeSkill(fixtureRoot, "quality", "collides-b", DUPLICATE_NAME_SKILL);
  writeSkill(fixtureRoot, "quality", "control-example", CONTROL_SKILL);
});

afterAll(() => {
  if (fixtureRoot.length > 0) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("AC8: the evaluator fails a skill that deserves to fail", () => {
  function findingsFor(skill: string): { check: BundledSkillCheck; message: string }[] {
    return evaluateBundledTree(fixtureRoot)
      .findings.filter((finding) => finding.skill === skill)
      .map((finding) => ({ check: finding.check, message: finding.message }));
  }

  test("the fixture tree is non-empty, or the rejection below proves nothing", () => {
    const evaluation = evaluateBundledTree(fixtureRoot);
    expect(evaluation.skills).toBe(7);
    expect(evaluation.findings.length).toBeGreaterThan(0);
  });

  test("an empty `name` and a versionless `metadata` are each rejected", () => {
    expect(findingsFor("empty-name").map((finding) => finding.check)).toContain("frontmatter:name");
    const versionless = findingsFor("versionless-metadata");
    expect(versionless.map((finding) => finding.check)).toContain("frontmatter:metadata");
    expect(versionless.find((finding) => finding.check === "frontmatter:metadata")?.message).toContain(
      "declares no `version`",
    );
  });

  test("the broken skill is rejected, and rejected for each named reason", () => {
    const found = findingsFor("broken-example");
    const checks = found.map((finding) => finding.check);

    // The rejection, check by check. Asserting the SET rather than a count is
    // what makes this a proof: a check that silently stopped firing shows up as
    // a missing member rather than as a number that still looks plausible.
    expect(checks).toContain("frontmatter:description");
    expect(checks).toContain("model:concrete-declaration");
    expect(checks).toContain("persona:name");
    // A name and a speech marker are two findings, not one. A rename that keeps
    // the catchphrase is the half-fix flow 206 refused.
    expect(checks).toContain("persona:marker");
    expect(checks).toContain("path:personal-home");
    expect(checks).toContain("xref:skill");
    expect(checks).toContain("xref:path");

    // …and the reasons, in the words an operator reads.
    const reason = (check: BundledSkillCheck): string =>
      found.find((finding) => finding.check === check)?.message ?? "";
    expect(reason("frontmatter:description")).toContain("missing the required `description` field");
    expect(reason("model:concrete-declaration")).toContain("declare a model_tier, never a model id");
    expect(reason("persona:name")).toContain("the reviewer's handle");
    expect(reason("persona:marker")).toContain("the reviewer's own term");
    expect(reason("path:personal-home")).toContain("absolute path into altsay's home directory");
    expect(reason("xref:skill")).toContain("names a skill `does-not-exist` that this tree does not ship");
    expect(reason("xref:path")).toContain("skills/review-orchestrator/reviewer-finding.schema.json");
    expect(reason("xref:path")).toContain("resolves to nothing under the shipped tree");
  });

  test("a file with no frontmatter block is rejected as such", () => {
    const found = findingsFor("no-frontmatter");
    expect(found.map((finding) => finding.check)).toContain("frontmatter:block");
    expect(found.find((finding) => finding.check === "frontmatter:block")?.message).toContain(
      "no YAML frontmatter block",
    );
  });

  test("two skills declaring one name are rejected as ambiguous", () => {
    const evaluation = evaluateBundledTree(fixtureRoot);
    const duplicates = evaluation.findings.filter((finding) => finding.check === "frontmatter:name-unique");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.message).toContain("`name: collides` is already declared by");
    expect(duplicates[0]?.message).toContain("cannot tell two of them apart");
  });

  test("a directory the install catalogue does not name is rejected", () => {
    // `installGdskills` copies only what `BUNDLED_GDSKILLS` names, so an
    // uncatalogued directory ships inside the package and reaches nobody.
    const found = findingsFor("control-example").filter((f) => f.check === "catalog:registered");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("never copies this directory");
  });

  test("the CONTROL skill draws only the catalogue finding — the checks are selective", () => {
    // The other half of AC8. A rejection is evidence only if the same evaluator
    // can pass something; every content check must stay silent here.
    const checks = new Set(findingsFor("control-example").map((finding) => finding.check));
    expect([...checks]).toEqual(["catalog:registered"]);
  });

  test("every declared check is exercised by this file", () => {
    // Otherwise a check can be added, never fire, and be reported as passing
    // forever — the vacuous-sweep defect one level up.
    const exercised = new Set(evaluateBundledTree(fixtureRoot).findings.map((finding) => finding.check));
    // Every declared check, with no exemption list. A check that cannot be made
    // to fire is a check that reports "pass" forever, which is the vacuous
    // sweep one level up.
    const missing = BUNDLED_SKILL_CHECKS.filter((check) => !exercised.has(check));
    expect(missing).toEqual([]);
  });

  test("the shared persona predicates fire on the markers flow 206 removed", () => {
    expect(personaOffenders("we ship a b091 profile").map((o) => o.line)).toEqual([1]);
    expect(personaOffenders("that is ducttape thinking")[0]?.why).toContain("spelled their way");
    expect(personaOffenders("a mechanism, described plainly")).toEqual([]);

    // Harness config roots are correct paths, not personal ones.
    expect(homePathOffenders("install into ~/.claude/skills")).toEqual([]);
    expect(homePathOffenders("${CODEX_HOME:-~/.codex}/agents")).toEqual([]);
    expect(homePathOffenders("see /Users/dev/<PROJECT>/src")).toEqual([]);
    expect(homePathOffenders("see /home/altsay/keryx/src")[0]?.why).toContain("altsay's home");
    expect(homePathOffenders("open ~/notes/todo.md")[0]?.why).toContain("outside the known harness roots");
  });
});

// ---------------------------------------------------------------------------
// The two rules this file REUSES rather than restates
// ---------------------------------------------------------------------------

describe("every allowance states why it is one", () => {
  // The pattern `command-registry.coverage.test.ts` established: an exemption
  // without a reason is indistinguishable from an oversight, and the reason has
  // to be asserted or it is a comment nobody has to keep true.
  test("an allowed external skill reference names where the referent lives", () => {
    expect(KNOWN_EXTERNAL_SKILL_REFERENCES.size).toBeGreaterThan(0);
    for (const [name, why] of KNOWN_EXTERNAL_SKILL_REFERENCES) {
      expect(name.length).toBeGreaterThan(0);
      expect(why.trim().length).toBeGreaterThan(0);
    }
  });

  test("an allowed generated path names the command that produces it", () => {
    expect(GENERATED_PATH_ROOTS.length).toBeGreaterThan(0);
    for (const entry of GENERATED_PATH_ROOTS) {
      expect(entry.prefix.endsWith("/")).toBe(true);
      expect(entry.producedBy).toMatch(/^keryx /);
    }
  });
});

describe("the evaluator composes the existing rules instead of copying them", () => {
  test("bundled-no-persona.test.ts and this sweep share one definition", () => {
    // If the persona rule were restated here, the two could drift and the older
    // guard would keep passing on a tree this one rejects. Imported, they
    // cannot. Asserted on the source so deleting the import is a red test
    // rather than a silent fork.
    const guard = readFileSync(path.join(import.meta.dir, "bundled-no-persona.test.ts"), "utf8");
    expect(guard).toContain('from "./bundled-eval"');
    expect(guard).toContain("personaOffenders");
    expect(guard).toContain("homePathOffenders");

    const evaluator = readFileSync(path.join(import.meta.dir, "bundled-eval.ts"), "utf8");
    expect(evaluator).toContain('import { concreteModelDeclarations } from "./model-tier"');
  });
});
