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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ANATOMY_RED_FLAGS_MIN_ROWS,
  BUNDLED_SKILL_CHECKS,
  DESCRIPTION_COLLISION_THRESHOLD,
  GENERATED_PATH_ROOTS,
  KNOWN_DESCRIPTION_COLLISIONS,
  KNOWN_EXTERNAL_SKILL_REFERENCES,
  KNOWN_SKILL_COMPANION_DOCUMENTS,
  PENDING_ANATOMY_BACKFILL,
  PERMANENT_ANATOMY_EXEMPTIONS,
  type BundledSkillCheck,
  bareImperativeOpening,
  bundledSkillDocuments,
  bundledSkillFiles,
  collisionPairKey,
  collisionPairs,
  collisionReasonNamesOwner,
  defaultBundledRoot,
  descriptionRouteTokens,
  evaluateBundledTree,
  hasNotForClause,
  hasRedFlagsSection,
  hasVerificationSection,
  homePathOffenders,
  jaccardSimilarity,
  pendingReasonNamesBackfillTask,
  personaOffenders,
  renderBundledEvaluation,
} from "./bundled-eval";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";

// ---------------------------------------------------------------------------
// AC7: the real tree
// ---------------------------------------------------------------------------

describe("AC7: the bundled skill tree is evaluated, over a real denominator", () => {
  test("the sweep walks the whole shipped tree", () => {
    // `bundledSkillFiles` returns `[]` for a missing root, so every assertion
    // below would pass vacuously over a renamed directory. The count is the
    // guard on the guard: 65 from the roadmap, plus `review-layout` and
    // `reviewer-skill-creator`, both added after a review round measured what
    // the shipped set could not reach.
    const files = bundledSkillFiles(path.join(defaultBundledRoot(), "skills"));
    expect(files.length).toBe(67);

    const evaluation = evaluateBundledTree();
    expect(evaluation.skills).toBe(files.length);
    expect(evaluation.skillNames.length).toBe(files.length);
    // Every category the tree ships is represented, so a sweep that silently
    // walked one subdirectory cannot pass.
    for (const category of ["orchestration", "planning", "platform", "quality", "review"]) {
      expect(files.some((file) => file.includes(`${path.sep}${category}${path.sep}`))).toBe(true);
    }
  });

  test("the sweep reads harness builds, not only SKILL.md", () => {
    // AC5. The tree shipped 65 `SKILL.md` and 100-odd harness builds; the sweep
    // used to walk the first set only, so `xref:path` reported clean over 65 of
    // 167 shipped documents and said nothing about the rest. That is how
    // `task-implementer` shipped four builds missing their whole reporting
    // contract with every check green. Flow 257 deleted the builds that were
    // byte-identical to their SKILL.md, so fewer ship now (the seven gproject-*
    // skills' codex/cursor builds) — which is why the named files below are
    // derived from the tree instead of pinned to task-implementer.
    const skillsRoot = path.join(defaultBundledRoot(), "skills");
    const canonical = bundledSkillFiles(skillsRoot);
    const documents = bundledSkillDocuments(skillsRoot);

    // Strictly more documents than skills, or the walker is still canonical-only.
    expect(documents.length).toBeGreaterThan(canonical.length);
    // Every canonical file is still in the set — a walker that swapped one set
    // for the other would satisfy the line above and check less than before.
    for (const file of canonical) expect(documents).toContain(file);

    const evaluation = evaluateBundledTree();
    expect(evaluation.documents).toBe(documents.length);
    expect(evaluation.skills).toBe(canonical.length);

    // Named files, so a walker that finds builds "somewhere" cannot pass while
    // missing some. Every build that exists beside a SKILL.md, found per
    // directory by exact name rather than by the walker under test, is in the
    // set — and there is at least one, or "strictly more" above is the only
    // thing standing between this test and vacuity.
    const shippedBuilds = canonical.flatMap((file) =>
      HARNESS_SKILL_RUNTIMES.map((runtime) => path.join(path.dirname(file), skillBuildFileName(runtime)))
        .filter((build) => build !== file && existsSync(build)),
    );
    expect(shippedBuilds.length).toBeGreaterThan(0);
    for (const build of shippedBuilds) expect(documents).toContain(build);
    expect(documents.length).toBe(canonical.length + shippedBuilds.length);
    // …and the denominator is printed, not just returned.
    expect(renderBundledEvaluation(evaluation)).toContain(
      `documents_evaluated: ${documents.length}`,
    );
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
VIOLATION xref:path — write findings per \`skills/gdskills/review/does-not-exist.schema.json\`.
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

/**
 * The shape that shipped: a block scalar with nothing under it. The shallow key
 * read sees the non-empty value "|" and passes; the runtime parse resolves it to
 * nothing and the catalog serves a bare indicator as the skill's description.
 * Only a check that reads what the runtime reads can tell these apart.
 */
const EMPTY_BLOCK_DESCRIPTION_SKILL = `---
name: empty-block-description
description: |
metadata:
  version: 1.0.0
---

# Empty Block Description

VIOLATION frontmatter:description — the block scalar above carries no text.
`;

const VERSIONLESS_METADATA_SKILL = `---
name: versionless-metadata
description: A skill whose metadata block declares no version.
metadata:
  audience: everyone
---

# Versionless Metadata
`;

/**
 * Two DIFFERENT descriptions on purpose — only the `name: collides` field is
 * supposed to match here; flow 257 T11's `description:collision` sweep would
 * otherwise also fire on this pair (an identical description trivially
 * collides at similarity 1.0), which is a real defect this fixture is not
 * trying to demonstrate and would confuse "two checks fired" with "one check
 * fired and a coincidence also did".
 */
const DUPLICATE_NAME_SKILL_A = `---
name: collides
description: Two skills declare the identical frontmatter name for this ambiguity fixture.
metadata:
  version: 1.0.0
---

# Collides (first)
`;

const DUPLICATE_NAME_SKILL_B = `---
name: collides
description: A harness cannot tell two skills apart when they share one frontmatter name.
metadata:
  version: 1.0.0
---

# Collides (second)
`;

/**
 * `SKILL.md` IS the Claude build (`skillBuildFileName("claude") === "SKILL.md"`),
 * so a `compatible_harnesses` list that excludes `claude` is this file lying
 * about the harness that loads it — the defect twelve shipped skills had.
 */
const HARNESS_EXCLUDES_CLAUDE_SKILL = `---
name: harness-excludes-claude
description: A SKILL.md whose compatible_harnesses list omits claude.
metadata:
  version: 1.0.0
  compatible_harnesses: "cursor,codex,zed,opencode"
---

# Harness Excludes Claude

VIOLATION frontmatter:harness-claude — compatible_harnesses above never names
claude, and this file IS the Claude build.
`;

/**
 * `metadata.category` free text drifted from the directory a skill actually
 * ships under on 23 shipped skills. Ground truth is the directory, which
 * \`catalog:registered\` already ties to \`BUNDLED_GDSKILLS\`.
 */
const CATEGORY_MISMATCH_SKILL = `---
name: category-mismatch
description: A SKILL.md whose metadata.category does not match its directory.
metadata:
  version: 1.0.0
  category: "workflow"
---

# Category Mismatch

VIOLATION frontmatter:category — this skill ships under
\`quality/category-mismatch\`, not "workflow".
`;

/**
 * Flow 257 T7 — the `description:*` family. Each fixture below trips exactly
 * one of the three new checks; `CONTROL_SKILL`'s rewritten description (below)
 * is the control that passes all three at once.
 */

/** No "Use when"/"Use to"/"Use for" anywhere in the description. */
const NO_TRIGGER_PHRASE_SKILL = `---
name: no-trigger-phrase
description: Reviews pull requests for correctness and style before merge.
metadata:
  version: 1.0.0
---

# No Trigger Phrase

VIOLATION description:trigger-phrase — the description above never says
"Use when", "Use to", or "Use for"; an agent has no situational cue for when
to reach for this skill, only a summary of what it does.
`;

/**
 * "Use when <bare imperative verb>" — the shape flow 257 T6 removed. Must NOT
 * fire on a gerund ("Use when reviewing…"), a colon-led gerund ("Use when:
 * reviewing…"), or a noun-phrase opening ("Use when a request…") — those three
 * shapes are exactly what the shipped tree's 67 descriptions already use, and
 * a check that flagged any of them would fail on the real tree, not the
 * fixture.
 */
const BARE_IMPERATIVE_SKILL = `---
name: bare-imperative-example
description: Use when implement a feature end-to-end, from task breakdown to a merge-ready PR.
metadata:
  version: 1.0.0
---

# Bare Imperative Example

VIOLATION description:bare-imperative — "Use when implement" is a command
aimed at the skill, not a description of the triggering situation; it should
read "Use when implementing".
`;

/**
 * Over the 1024-character cap agentskills.io's skill spec sets. Written with a
 * trigger phrase and a gerund opening so this fixture trips ONLY
 * \`description:length\`, proving the three checks are independent rather than
 * one long broken description satisfying all three by accident.
 */
const LONG_DESCRIPTION_TEXT =
  "Use when reviewing a fixture description deliberately padded well past the length a routing prompt can afford. " +
  ("Repeating harmless filler words about the eleven hundred and twenty four character cap that agentskills.io's " +
    "skill specification sets for every description field, so that this one check and only this one check has " +
    "something real to reject. ").repeat(6) +
  "The end.";

const TOO_LONG_DESCRIPTION_SKILL = `---
name: too-long-description
description: ${LONG_DESCRIPTION_TEXT}
metadata:
  version: 1.0.0
---

# Too Long Description

VIOLATION description:length — the description above is over 1024 characters.
`;

/**
 * Flow 257 T11 — `description:collision`. Two descriptions differing by a
 * single word — "timeout" vs "outage" — collide at Jaccard similarity ~0.818
 * on `routeTokens`, well past `DESCRIPTION_COLLISION_THRESHOLD` (0.75).
 * Deliberately distinctive vocabulary ("triaging", "escalation", "gateway")
 * absent from every other fixture in this file, so the pair's own collision
 * is the only one this addition can introduce — the CONTROL skill and every
 * other fixture below stay unaffected, which the exhaustive "CONTROL skill
 * draws only the catalogue finding" test downstream would otherwise catch.
 */
const DESCRIPTION_COLLISION_A_SKILL = `---
name: description-collision-a
description: Use when triaging incoming support escalation tickets that mention a payment gateway timeout.
metadata:
  version: 1.0.0
---

# Description Collision A

VIOLATION description:collision — this description and
\`description-collision-b\`'s differ by one word and collide at Jaccard
similarity >= 0.75 on the router's own tokenisation.
`;

/** The other half of the colliding pair — see `DESCRIPTION_COLLISION_A_SKILL`. */
const DESCRIPTION_COLLISION_B_SKILL = `---
name: description-collision-b
description: Use when triaging incoming support escalation tickets that mention a payment gateway outage.
metadata:
  version: 1.0.0
---

# Description Collision B

VIOLATION description:collision — see \`description-collision-a\`.
`;

/**
 * Flow 257 T8 — the `anatomy:sections` family. Each fixture below trips
 * exactly one of the three anatomy checks; `CONTROL_SKILL`'s rewritten body
 * (below) is the control that passes all three at once, alongside every
 * other check this file exercises.
 */

/**
 * No "NOT for" anywhere — trips exactly `trigger-not-for`. Carries a
 * qualifying Red Flags table and a Verification heading so the other two
 * anatomy legs stay silent, proving the three are independent.
 */
const NO_NOT_FOR_SKILL = `---
name: no-not-for-example
description: Use when a fixture must prove the anatomy sweep catches a document with no NOT-for disambiguation anywhere in it.
metadata:
  version: 1.0.0
---

# Missing Disambiguation Fixture

VIOLATION anatomy:sections (trigger-not-for) — nothing in this document, not
the description and not the body, ever says what this skill excludes.

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "This fixture doesn't need three rows" | \`ANATOMY_RED_FLAGS_MIN_ROWS\` requires at least three |
| "One row would already prove the table works" | A single row reads as a scattered callout, not a table |
| "The heading alone should be enough" | A heading with no table is what \`job-orchestrator\`'s two \`### Red Flag\` callouts ship, and must not pass |

## Verification

- [ ] This fixture trips only the \`trigger-not-for\` leg of \`anatomy:sections\`
`;

/**
 * No Red Flags heading anywhere — trips exactly `red-flags`. The description
 * carries a NOT-for clause and the body a Verification heading, so those two
 * legs stay silent.
 */
const NO_RED_FLAGS_SKILL = `---
name: no-red-flags-example
description: Use when a fixture must prove the anatomy sweep catches a document with no Red Flags table. NOT for anything real — this skill only exists to trip one check.
metadata:
  version: 1.0.0
---

# No Consolidated Warnings Fixture

## Verification

Nothing to verify — this fixture exists only to trip \`anatomy:sections\` on
its missing Red Flags table.
`;

/**
 * A Red Flags heading with a table below the row threshold — still trips
 * `red-flags`, proving the check enforces the row count and not merely the
 * heading's presence. Two data rows, one short of \`ANATOMY_RED_FLAGS_MIN_ROWS\`.
 */
const TOO_FEW_RED_FLAGS_ROWS_SKILL = `---
name: too-few-red-flags-rows-example
description: Use when a fixture must prove the row-count threshold is enforced, not just the heading. NOT for anything real.
metadata:
  version: 1.0.0
---

# Sparse Warnings Table Fixture

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "Two rows should already count" | \`ANATOMY_RED_FLAGS_MIN_ROWS\` is three |
| "A heading with any table passes" | The single scattered callouts this check exists to reject also have "a table", of sorts, at one row |

## Verification

- [ ] Confirms two data rows still trips \`anatomy:sections\` (\`red-flags\`)
`;

/**
 * No Verification/exit-criteria/STATUS content anywhere — trips exactly
 * `verification`. The description carries a NOT-for clause and the body a
 * qualifying Red Flags table, so those two legs stay silent.
 */
const NO_VERIFICATION_SKILL = `---
name: no-verification-example
description: Use when a fixture must prove the anatomy sweep catches a document with no Verification, exit-criteria, or STATUS content. NOT for anything real.
metadata:
  version: 1.0.0
---

# No Completion Contract Fixture

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "Two rows should be enough" | The check requires at least three |
| "The heading alone should be enough" | A heading with no table must not pass |
| "This fixture doesn't need a real table" | Fixtures are checked by the same code as the shipped tree |
`;

/**
 * The control. Correct in every respect the evaluator checks, and sitting in the
 * SAME fixture tree as the broken ones — so "the evaluator rejected the fixture"
 * cannot be satisfied by an evaluator that rejects everything it is shown.
 */
const CONTROL_SKILL = `---
name: control-example
description: Use when validating that a structurally correct skill draws no findings, proving the sweep's checks are selective rather than a blanket failure. NOT for a fixture that is deliberately broken — see BROKEN_SKILL and its neighbors.
metadata:
  version: 1.0.0
---

# Control Example

Reads \`.metaproject/skills/gdskills/quality/control-example/SKILL.md\` — the
installed spelling, which resolves — and mentions \`review-logic\` without
asking for it as a skill. Also names its own skill by directory only,
\`skills/quality/control-example\`, the accepted bare form.

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "One finding proves the sweep works" | Every check needs both a fixture that fails and a control that passes |
| "The control doesn't need real content" | It must survive every check introduced later, or it goes stale silently |
| "Skipping Verification here is fine, it's a fixture" | \`anatomy:sections\` does not know this is a fixture |

## Verification

Every declared check must fire on at least one fixture in this file, and this
control must draw no finding from any content check — only the deliberately
uncatalogued \`catalog:registered\` finding.
`;

/**
 * A skill whose `SKILL.md` is clean and whose CODEX BUILD is not.
 *
 * This is AC5 in one fixture. Before the sweep read harness builds, this skill
 * drew no finding at all: the file with the defect was never opened. The build
 * below carries a dangling skill reference and nothing else, so a sweep that
 * reports it can only have read the build.
 */
const BUILD_ONLY_DEFECT_CANONICAL = `---
name: build-drift-example
description: Clean in the Claude build; broken in the Codex build.
metadata:
  version: 1.0.0
---

# Build Drift Example
`;

const BUILD_ONLY_DEFECT_CODEX = `---
name: build-drift-example
description: Clean in the Claude build; broken in the Codex build.
metadata:
  version: 1.0.0
---

# Build Drift Example

VIOLATION xref:skill — Launch \`only-in-the-codex-build\` skill on the diff.
`;

/**
 * The control for `document:build-parity`: a build that differs from its
 * `SKILL.md` ONLY in the frontmatter field the exporter owns.
 *
 * 14 shipped builds have exactly this shape. A parity check that flagged them
 * would fire on arrival and be deleted, so the check has to tell "the exporter
 * wrote its own field" apart from "the build fell behind".
 */
const HARNESS_FIELD_ONLY_CANONICAL = `---
name: harness-field-only
description: Its Codex build differs only in the field the exporter writes.
metadata:
  version: 1.0.0
---

# Harness Field Only
`;

const HARNESS_FIELD_ONLY_CODEX = `---
name: harness-field-only
description: Its Codex build differs only in the field the exporter writes.
metadata:
  version: 1.0.0
  compatible_harnesses: "cursor,codex,zed,opencode"
---

# Harness Field Only
`;

/** A build no runtime addresses: nothing exports, installs, or reads it. */
const UNADDRESSED_BUILD = `---
name: unaddressed-build-example
description: Spelled like a build for a harness this codebase does not ship.
metadata:
  version: 1.0.0
---

# Unaddressed Build
`;

/**
 * Proves `xref:path` resolves against the INSTALLED layout, not the checkout.
 *
 * `skills/shared/example-script.md` is written to disk in THIS fixture tree
 * below, on purpose — mirroring `skills/shared/git-merge-base.md`, a real file
 * in the bundled source tree that eleven shipped skills once cited bare while
 * no installed project ever had it at that address. The bare form must be
 * rejected regardless of what sits on disk here; the installed spelling of the
 * exact same file must resolve clean.
 */
const SOURCE_TREE_ONLY_SKILL = `---
name: source-tree-only-example
description: A source-tree-only path is rejected; the installed spelling of the same file passes.
metadata:
  version: 1.0.0
---

# Source Tree Only Example

VIOLATION xref:path — \`skills/shared/example-script.md\` resolves on disk in
this fixture tree, but no installed project has a top-level \`skills/\`; only
\`.metaproject/skills/gdskills/shared/example-script.md\` exists in an install.

The installed spelling of that same file draws nothing:
\`.metaproject/skills/gdskills/shared/example-script.md\`.
`;

/**
 * A rule file with one dead cross-reference and one live one — the control
 * proving rule sweeping is selective, not a blanket failure the moment a rule
 * mentions a path at all.
 */
const BROKEN_RULE = `---
description: Fixture rule proving rule files are swept for cross-references too.
---

# Fixture Rule

VIOLATION xref:path — see \`rules/core/does-not-exist.mdc\` for the missing half.

The sibling rule resolves and draws nothing: \`rules/core/sibling-rule.mdc\`.
`;

/** Exists only so \`BROKEN_RULE\` above has something real to cite. */
const SIBLING_RULE = `---
description: Referenced by the fixture rule above; carries no violation of its own.
---

# Sibling Rule
`;

let fixtureRoot = "";

function writeSkill(root: string, category: string, name: string, body: string): void {
  const dir = path.join(root, "skills", category, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

function writeSkillFile(root: string, category: string, name: string, file: string, body: string): void {
  const dir = path.join(root, "skills", category, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body, "utf8");
}

function writeRule(root: string, file: string, body: string): void {
  const dir = path.join(root, "rules", "core");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body, "utf8");
}

beforeAll(() => {
  // Temp root, never the operator's home: this tree exists to be wrong.
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "keryx-bundled-eval-fixture-"));
  writeSkill(fixtureRoot, "quality", "broken-example", BROKEN_SKILL);
  writeSkill(fixtureRoot, "quality", "no-frontmatter", NO_FRONTMATTER_SKILL);
  writeSkill(fixtureRoot, "quality", "empty-name", EMPTY_NAME_SKILL);
  writeSkill(fixtureRoot, "quality", "empty-block-description", EMPTY_BLOCK_DESCRIPTION_SKILL);
  writeSkill(fixtureRoot, "quality", "versionless-metadata", VERSIONLESS_METADATA_SKILL);
  writeSkill(fixtureRoot, "quality", "collides-a", DUPLICATE_NAME_SKILL_A);
  writeSkill(fixtureRoot, "quality", "collides-b", DUPLICATE_NAME_SKILL_B);
  writeSkill(fixtureRoot, "quality", "harness-excludes-claude", HARNESS_EXCLUDES_CLAUDE_SKILL);
  writeSkill(fixtureRoot, "quality", "category-mismatch", CATEGORY_MISMATCH_SKILL);
  writeSkill(fixtureRoot, "quality", "no-trigger-phrase", NO_TRIGGER_PHRASE_SKILL);
  writeSkill(fixtureRoot, "quality", "bare-imperative-example", BARE_IMPERATIVE_SKILL);
  writeSkill(fixtureRoot, "quality", "too-long-description", TOO_LONG_DESCRIPTION_SKILL);
  writeSkill(fixtureRoot, "quality", "description-collision-a", DESCRIPTION_COLLISION_A_SKILL);
  writeSkill(fixtureRoot, "quality", "description-collision-b", DESCRIPTION_COLLISION_B_SKILL);
  writeSkill(fixtureRoot, "quality", "no-not-for-example", NO_NOT_FOR_SKILL);
  writeSkill(fixtureRoot, "quality", "no-red-flags-example", NO_RED_FLAGS_SKILL);
  writeSkill(fixtureRoot, "quality", "too-few-red-flags-rows-example", TOO_FEW_RED_FLAGS_ROWS_SKILL);
  writeSkill(fixtureRoot, "quality", "no-verification-example", NO_VERIFICATION_SKILL);
  writeSkill(fixtureRoot, "quality", "control-example", CONTROL_SKILL);
  writeSkill(fixtureRoot, "quality", "build-drift-example", BUILD_ONLY_DEFECT_CANONICAL);
  writeSkillFile(
    fixtureRoot,
    "quality",
    "build-drift-example",
    skillBuildFileName("codex"),
    BUILD_ONLY_DEFECT_CODEX,
  );
  writeSkill(fixtureRoot, "quality", "harness-field-only", HARNESS_FIELD_ONLY_CANONICAL);
  writeSkillFile(
    fixtureRoot,
    "quality",
    "harness-field-only",
    skillBuildFileName("codex"),
    HARNESS_FIELD_ONLY_CODEX,
  );
  writeSkill(fixtureRoot, "quality", "unaddressed-build-example", UNADDRESSED_BUILD);
  writeSkillFile(
    fixtureRoot,
    "quality",
    "unaddressed-build-example",
    "SKILL.gemini.md",
    UNADDRESSED_BUILD,
  );
  writeSkill(fixtureRoot, "quality", "source-tree-only-example", SOURCE_TREE_ONLY_SKILL);
  mkdirSync(path.join(fixtureRoot, "skills", "shared"), { recursive: true });
  writeFileSync(path.join(fixtureRoot, "skills", "shared", "example-script.md"), "# Example\n", "utf8");
  writeRule(fixtureRoot, "sibling-rule.mdc", SIBLING_RULE);
  writeRule(fixtureRoot, "broken-rule.mdc", BROKEN_RULE);
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
    // Twenty-three skills: the original fourteen, flow 257 T7's three
    // `description:*` fixtures, T11's colliding pair
    // (description-collision-a, description-collision-b), and T8's four
    // `anatomy:sections` fixtures (no-not-for-example, no-red-flags-example,
    // too-few-red-flags-rows-example, no-verification-example), each shipping
    // one plain SKILL.md.
    expect(evaluation.skills).toBe(23);
    // Twenty-five documents: twenty-three skills, plus `build-drift-example`
    // and `harness-field-only` each also shipping a Codex build.
    expect(evaluation.documents).toBe(25);
    expect(evaluation.findings.length).toBeGreaterThan(0);
  });

  test("a reference valid only in the source tree is reported; the installed spelling passes", () => {
    // AC7: `xref:path` has to resolve against the layout an installed project
    // actually has, not against whatever this checkout happens to hold on
    // disk at the same string.
    const found = findingsFor("source-tree-only-example").filter((finding) => finding.check === "xref:path");
    // Exactly one: the bare form is rejected, and — since this is the only
    // `xref:path` finding for the skill — the installed spelling of the SAME
    // file, cited right below it, drew nothing at all.
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("skills/shared/example-script.md");
    expect(found[0]?.message).toContain("SOURCE tree's own layout");
    expect(found[0]?.message).toContain(".metaproject/skills/gdskills/shared/example-script.md");
  });

  test("a reference inside a rule file to a missing path is reported", () => {
    // Item 2: rule files under `rules/core/` are swept for cross-references
    // the same way skill documents are — nothing read them before this.
    const evaluation = evaluateBundledTree(fixtureRoot);
    const broken = evaluation.findings.filter(
      (finding) => finding.check === "xref:path" && finding.file === "rules/core/broken-rule.mdc",
    );
    expect(broken).toHaveLength(1);
    expect(broken[0]?.message).toContain("rules/core/does-not-exist.mdc");
    expect(broken[0]?.message).toContain("resolves to nothing under the shipped tree");

    // The control: a rule citing a SIBLING rule that exists draws nothing —
    // proving the sweep is selective, not a blanket failure on any mention.
    const sibling = evaluation.findings.filter((finding) => finding.file === "rules/core/sibling-rule.mdc");
    expect(sibling).toEqual([]);
  });

  test("a description that resolves to nothing is rejected, not just an absent one", () => {
    // The shallow key read sees "|" — present and non-empty — and passes. The
    // check has to resolve the value the way `skills_catalog` does, or a skill
    // ships whose whole description, as served to an agent, is one character.
    const found = findingsFor("empty-block-description").filter(
      (finding) => finding.check === "frontmatter:description",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("resolves to nothing");

    // The control: a normal block scalar with text under it is NOT flagged.
    const control = findingsFor("control-example").filter(
      (finding) => finding.check === "frontmatter:description",
    );
    expect(control).toEqual([]);
  });

  test("a description with no trigger phrase is rejected; the control passes", () => {
    const found = findingsFor("no-trigger-phrase").filter(
      (finding) => finding.check === "description:trigger-phrase",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('"Use when"');
    expect(found[0]?.message).toContain('"Use to"');
    expect(found[0]?.message).toContain('"Use for"');

    const control = findingsFor("control-example").filter(
      (finding) => finding.check === "description:trigger-phrase",
    );
    expect(control).toEqual([]);
  });

  test("a bare imperative opening is rejected; a gerund opening is not", () => {
    const found = findingsFor("bare-imperative-example").filter(
      (finding) => finding.check === "description:bare-imperative",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('"Use when implement');
    expect(found[0]?.message).toContain('"Use when implementing');

    // The control opens with "Use when validating…" — a gerund — and must not
    // trip the rule that exists specifically to catch the BARE form.
    const control = findingsFor("control-example").filter(
      (finding) => finding.check === "description:bare-imperative",
    );
    expect(control).toEqual([]);

    // The shape the rule must NOT fire on, stated directly rather than only
    // through the shipped tree: a gerund, a colon-led gerund, and a
    // noun-phrase opening all pass.
    expect(bareImperativeOpening("Use when reviewing a diff for correctness.")).toBeUndefined();
    expect(bareImperativeOpening("Use when: reviewing a diff for correctness.")).toBeUndefined();
    expect(bareImperativeOpening("Use when a request is ambiguous.")).toBeUndefined();
    // The shape it MUST fire on.
    expect(bareImperativeOpening("Use when implement a feature.")).toBe("implement");
  });

  test("a description over the 1024-character cap is rejected; a shorter one is not", () => {
    const found = findingsFor("too-long-description").filter((finding) => finding.check === "description:length");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("over the 1024-character cap");
    expect(found[0]?.message).toContain("agentskills.io");

    // The fixture trips ONLY `description:length` — it opens with a proper
    // trigger phrase and a gerund, so the other two checks must stay silent.
    const others = findingsFor("too-long-description").filter(
      (finding) => finding.check === "description:trigger-phrase" || finding.check === "description:bare-imperative",
    );
    expect(others).toEqual([]);

    const control = findingsFor("control-example").filter((finding) => finding.check === "description:length");
    expect(control).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Flow 257 T11: `description:collision`
  // -------------------------------------------------------------------------

  test("two descriptions that collide draw exactly one finding naming the pair and the score", () => {
    const evaluation = evaluateBundledTree(fixtureRoot);
    const collisions = evaluation.findings.filter((finding) => finding.check === "description:collision");
    // Exactly one finding for the whole fixture tree — proving both halves of
    // AC6 at once: the colliding pair fires, and every OTHER pair among the
    // ~23 fixture skills (the CONTROL skill included) stays below the
    // threshold and draws nothing. A second, unrelated collision here would
    // mean this fixture's deliberately distinctive vocabulary leaked into
    // another fixture's description.
    expect(collisions).toHaveLength(1);
    const [finding] = collisions;
    expect(finding?.skill).toBe("description-collision-b");
    expect(finding?.message).toContain("quality/description-collision-a");
    expect(finding?.message).toContain("quality/description-collision-b");
    // ~0.818 (9 shared tokens / 11 total) — pinned to two decimal places so a
    // change to the measure or the fixture text is visible here.
    expect(finding?.message).toContain("0.82");
    expect(finding?.message).toContain(`>= ${DESCRIPTION_COLLISION_THRESHOLD}`);

    // Attributed to exactly one of the two skill directories — the same
    // one-home-per-finding convention `frontmatter:name-unique` uses above —
    // and specifically the one this evaluator's sort settled on.
    const attributedToOther = evaluation.findings.filter(
      (f) => f.check === "description:collision" && f.skill === "description-collision-a",
    );
    expect(attributedToOther).toEqual([]);
  });

  test("descriptionRouteTokens and jaccardSimilarity compose the way the check's comment claims", () => {
    // Pinned directly, not only through the fixture above: the measure is
    // Jaccard over `routeTokens(normalizeRouteText(description))`, the
    // IDENTICAL pipeline the router scores an entry's haystack with.
    const a = descriptionRouteTokens(
      "Use when triaging incoming support escalation tickets that mention a payment gateway timeout.",
    );
    const b = descriptionRouteTokens(
      "Use when triaging incoming support escalation tickets that mention a payment gateway outage.",
    );
    expect([...a].sort()).toEqual(
      ["when", "triaging", "incoming", "support", "escalation", "tickets", "mention", "payment", "gateway", "timeout"].sort(),
    );
    // 9 shared tokens, 11 in the union (10 + 10 - 9).
    expect(jaccardSimilarity(a, b)).toBeCloseTo(9 / 11, 5);

    // Two empty sets, or one empty against a real one, never "collide" — an
    // empty description already fails `frontmatter:description` and must not
    // also report a spurious 100% match against every other empty one.
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), a)).toBe(0);

    // Identical text is similarity 1, not merely "high".
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  test("collisionPairs finds every pair at or above the threshold, sorted by similarity, and collisionPairKey is order-independent", () => {
    const entries = new Map([
      ["quality/alpha", "Use when triaging incoming support escalation tickets that mention a payment gateway timeout."],
      ["quality/beta", "Use when triaging incoming support escalation tickets that mention a payment gateway outage."],
      ["quality/gamma", "Use when scheduling a periodic health report unrelated to anything else here."],
    ]);
    const pairs = collisionPairs(entries, DESCRIPTION_COLLISION_THRESHOLD);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: "quality/alpha", b: "quality/beta" });
    expect(pairs[0]?.similarity).toBeCloseTo(9 / 11, 5);

    // A threshold of 0 surfaces every pair, including the unrelated one, and
    // the descending sort puts the real collision first.
    const allPairs = collisionPairs(entries, 0);
    expect(allPairs.length).toBeGreaterThan(1);
    expect(allPairs[0]).toMatchObject({ a: "quality/alpha", b: "quality/beta" });

    expect(collisionPairKey("quality/alpha", "quality/beta")).toBe(collisionPairKey("quality/beta", "quality/alpha"));
  });

  test("every known description collision exemption names flow 257 T12 as the owner", () => {
    // `KNOWN_DESCRIPTION_COLLISIONS` is expected to reach empty — AC6 requires
    // the shipped tree to end at zero `description:collision` findings, and an
    // entry here is what buys that while T12 has not yet acted (see the map's
    // own comment). This runs over whatever is in it today rather than
    // asserting it is non-empty, since empty is the map's own success state.
    for (const [key, exemption] of KNOWN_DESCRIPTION_COLLISIONS) {
      expect(key).toContain(" :: ");
      expect(collisionReasonNamesOwner(exemption.reason)).toBe(true);
      expect(exemption.reason.trim().length).toBeGreaterThan(0);
    }
    // The predicate itself, pinned directly: it must accept a reason naming
    // T12 and reject one that does not, or the loop above could pass vacuously
    // on a reason that names no one.
    expect(collisionReasonNamesOwner("owed to flow 257's T12")).toBe(true);
    expect(collisionReasonNamesOwner("no owner named")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Flow 257 T8: `anatomy:sections`
  // -------------------------------------------------------------------------

  test("a document with no NOT-for clause anywhere is rejected; the control passes", () => {
    const found = findingsFor("no-not-for-example").filter((finding) => finding.check === "anatomy:sections");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("NOT for");

    // Trips ONLY the trigger-not-for leg — its Red Flags table and
    // Verification heading must stay silent, proving the three legs of
    // `anatomy:sections` are independent.
    expect(found[0]?.message).not.toContain("Red Flags");
    expect(found[0]?.message).not.toContain("Verification");

    const control = findingsFor("control-example").filter((finding) => finding.check === "anatomy:sections");
    expect(control).toEqual([]);
  });

  test("a document with no Red Flags table is rejected", () => {
    const found = findingsFor("no-red-flags-example").filter((finding) => finding.check === "anatomy:sections");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("Red Flags");
  });

  test("a Red Flags heading with fewer than the minimum rows still fails — the row count is enforced, not just the heading", () => {
    const found = findingsFor("too-few-red-flags-rows-example").filter(
      (finding) => finding.check === "anatomy:sections",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("Red Flags");
    // Two rows in the fixture, one short of the threshold — pin the constant
    // itself, not just its effect, so a change to the threshold is visible here.
    expect(ANATOMY_RED_FLAGS_MIN_ROWS).toBe(3);
  });

  test("a document with no Verification / exit-criteria / STATUS content is rejected", () => {
    const found = findingsFor("no-verification-example").filter((finding) => finding.check === "anatomy:sections");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("Verification");
  });

  test("hasNotForClause reads the whole document, description or body, not description alone", () => {
    // `metaproject-security` is the one shipped skill that states its
    // disambiguation as body prose rather than inside `description` — the
    // reason this predicate is not scoped to the frontmatter.
    expect(hasNotForClause("description: Use when doing X.\n\nUse this for Y, not for Z.")).toBe(true);
    expect(hasNotForClause("description: Use when doing X, NOT for Y.")).toBe(true);
    expect(hasNotForClause("description: Use when doing X.\n\nNo disambiguation here.")).toBe(false);
  });

  test("hasRedFlagsSection requires a heading AND a table or list of at least the minimum rows", () => {
    const headingOnly = "## Red Flags\n\nJust a paragraph, no table.\n";
    expect(hasRedFlagsSection(headingOnly)).toBe(false);

    const oneRow = "## Red Flags\n| A | B |\n|---|---|\n| one | row |\n";
    expect(hasRedFlagsSection(oneRow)).toBe(false);

    const threeRows =
      "## Red Flags\n| A | B |\n|---|---|\n| one | row |\n| two | row |\n| three | row |\n";
    expect(hasRedFlagsSection(threeRows)).toBe(true);

    // The two-column bullet-list alternative AC3 names, with no shipped
    // example today: still accepted once it reaches the row threshold.
    const bulletList = "## Red Flags\n- \"one\" — why\n- \"two\" — why\n- \"three\" — why\n";
    expect(hasRedFlagsSection(bulletList)).toBe(true);

    // job-orchestrator's actual shape: an isolated single-row callout under
    // its own heading, nowhere near the threshold — must not pass.
    const scatteredCallout = "### Red Flag\n**\"a rationalization\"**\nA paragraph of rebuttal, no table.\n";
    expect(hasRedFlagsSection(scatteredCallout)).toBe(false);
  });

  test("hasVerificationSection accepts a heading, a STATUS contract line, or an explicit exit-criteria enum", () => {
    expect(hasVerificationSection("## Verification\n")).toBe(true);
    expect(hasVerificationSection("## Phase 3: Verification And Review\n")).toBe(true);
    expect(hasVerificationSection("## Exit Criteria\n")).toBe(true);
    expect(hasVerificationSection("STATUS: DONE\n")).toBe(true);
    expect(hasVerificationSection('status: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"\n')).toBe(true);
    // A bare mention of "status" as a formatting note, not a contract, must
    // not satisfy this — it says where a line goes, not what "done" means.
    expect(hasVerificationSection("### Status line (first line of response)\n")).toBe(false);
    expect(hasVerificationSection("status: pass | fail | skipped\n")).toBe(false);
    expect(hasVerificationSection("# Nothing relevant here\n")).toBe(false);
  });

  test("PERMANENT_ANATOMY_EXEMPTIONS is non-empty, every entry carries a reason, and none excuses red-flags or verification", () => {
    expect(PERMANENT_ANATOMY_EXEMPTIONS.size).toBeGreaterThan(0);
    for (const [key, entry] of PERMANENT_ANATOMY_EXEMPTIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.sections.length).toBeGreaterThan(0);
      // The permanent exemption is scoped to the user-facing trigger only —
      // AC9 requires every workflow skill to earn Red Flags and Verification
      // outright, Phase subagents included.
      expect(entry.sections).toEqual(["trigger-not-for"]);
      expect(key).toMatch(/^planning\//);
    }
  });

  test("PENDING_ANATOMY_BACKFILL is empty now that T13-T15 landed, and any future entry names the task that owns it", () => {
    // The map started at 53 entries and T13/T14/T15 emptied it by writing the
    // sections rather than by deleting the rows: every skill they list now
    // passes `anatomy:sections` on its own. An empty map is therefore the end
    // state AC9 asks for — a non-empty one would mean a workflow skill is
    // still excused. The loop below stays because the map is a live mechanism:
    // a later flow may park a skill here, and its reason must name the task.
    expect(PENDING_ANATOMY_BACKFILL.size).toBe(0);
    for (const [key, entry] of PENDING_ANATOMY_BACKFILL) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.sections.length).toBeGreaterThan(0);
      // The non-vacuity rule item 2 in the dispatch asked for: a pending
      // entry whose reason does not name T13/T14/T15 could sit here forever
      // and quietly become a second permanent exemption list.
      expect(pendingReasonNamesBackfillTask(entry.reason)).toBe(true);
      if (key.startsWith("quality/")) expect(entry.reason).toContain("T13");
      else if (key.startsWith("review/") || key === "core/reviewer-skill-creator") expect(entry.reason).toContain("T15");
      else expect(entry.reason).toContain("T14");
    }
  });

  test("a defect that exists ONLY in a harness build is found", () => {
    // The AC5 proof. `build-drift-example/SKILL.md` is clean; the defect lives in
    // `SKILL.codex.md` alone. A sweep that walks canonical files only reports
    // nothing here, which is exactly what the shipped sweep did.
    const found = findingsFor("build-drift-example");
    const xref = found.filter((finding) => finding.check === "xref:skill");
    expect(xref).toHaveLength(1);
    expect(xref[0]?.message).toContain("only-in-the-codex-build");

    const located = evaluateBundledTree(fixtureRoot).findings.find(
      (finding) => finding.check === "xref:skill" && finding.skill === "build-drift-example",
    );
    // Located in the BUILD, not in SKILL.md — otherwise the report sends the
    // reader to a file that is correct.
    expect(located?.file).toBe("quality/build-drift-example/SKILL.codex.md");
  });

  test("a build that has fallen behind its SKILL.md is found", () => {
    // Every other check reads each document alone, so a build that is merely
    // STALE is structurally perfect and reports nothing. That is how four builds
    // kept serving a previous description while the sweep printed `findings: 0`.
    const found = findingsFor("build-drift-example").filter(
      (finding) => finding.check === "document:build-parity",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("no longer carries the content of its");

    // The control: a skill whose only build difference is a field the exporter
    // owns must NOT be flagged, or the check fails on arrival and gets deleted.
    const clean = evaluateBundledTree(fixtureRoot).findings.filter(
      (finding) => finding.check === "document:build-parity" && finding.skill === "harness-field-only",
    );
    expect(clean).toEqual([]);
  });

  test("the five builds of one skill are not read as five colliding skills", () => {
    // `frontmatter:name-unique` keys on the skill DIRECTORY. Reading builds means
    // one name is now declared by up to five files on purpose, and a check that
    // fired on that would make the whole sweep unusable — the false-positive
    // failure from the other direction.
    const collisions = findingsFor("build-drift-example").filter(
      (finding) => finding.check === "frontmatter:name-unique",
    );
    expect(collisions).toEqual([]);
  });

  test("a build no runtime addresses is rejected", () => {
    const found = findingsFor("unaddressed-build-example").filter(
      (finding) => finding.check === "document:addressable",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("SKILL.gemini.md");
    expect(found[0]?.message).toContain("no runtime in HARNESS_SKILL_RUNTIMES resolves to it");
  });

  test("an empty `name` and a versionless `metadata` are each rejected", () => {
    expect(findingsFor("empty-name").map((finding) => finding.check)).toContain("frontmatter:name");
    const versionless = findingsFor("versionless-metadata");
    expect(versionless.map((finding) => finding.check)).toContain("frontmatter:metadata");
    expect(versionless.find((finding) => finding.check === "frontmatter:metadata")?.message).toContain(
      "declares no `version`",
    );
  });

  test("a SKILL.md whose compatible_harnesses omits claude is rejected; a harness build that omits it is not", () => {
    const found = findingsFor("harness-excludes-claude").filter(
      (finding) => finding.check === "frontmatter:harness-claude",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("omits `claude`");
    expect(found[0]?.message).toContain("IS the Claude build");

    // The control: `harness-field-only`'s Codex BUILD also carries
    // `compatible_harnesses: "cursor,codex,zed,opencode"` with no claude, on
    // purpose (`BUILD_DIVERGENCE_ALLOWED_FIELDS`) — a non-Claude build naming
    // the harnesses it actually serves is not lying about anything, so this
    // check must stay silent on it.
    const buildFinding = evaluateBundledTree(fixtureRoot).findings.filter(
      (finding) => finding.check === "frontmatter:harness-claude" && finding.skill === "harness-field-only",
    );
    expect(buildFinding).toEqual([]);
  });

  test("a metadata.category that does not match the skill's directory is rejected; an absent category passes", () => {
    const found = findingsFor("category-mismatch").filter((finding) => finding.check === "frontmatter:category");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('"workflow"');
    expect(found[0]?.message).toContain("quality/category-mismatch");

    // The control: `control-example` declares no `metadata.category` at all —
    // absence passes, it is not treated as a mismatch.
    const control = findingsFor("control-example").filter((finding) => finding.check === "frontmatter:category");
    expect(control).toEqual([]);
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
    expect(reason("xref:path")).toContain("skills/gdskills/review/does-not-exist.schema.json");
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

  test("an allowed companion document names why it is not a build", () => {
    expect(KNOWN_SKILL_COMPANION_DOCUMENTS.size).toBeGreaterThan(0);
    for (const [name, why] of KNOWN_SKILL_COMPANION_DOCUMENTS) {
      expect(name).toMatch(/^SKILL\..+\.md$/);
      // A build name would be silently shadowed by the allowance, so refuse one.
      expect(HARNESS_SKILL_RUNTIMES.map((runtime) => skillBuildFileName(runtime))).not.toContain(name);
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
