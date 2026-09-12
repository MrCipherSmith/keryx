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
import { DEFAULT_SKILL_LENGTH_CEILING, SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";
import {
  ANATOMY_RED_FLAGS_MIN_ROWS,
  ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS,
  BARE_IMPERATIVE_VERBS,
  BUNDLED_SKILL_CHECKS,
  DESCRIPTION_COLLISION_THRESHOLD,
  GENERATED_PATH_ROOTS,
  IMPERATIVE_OBJECT_DETERMINERS,
  KNOWN_DESCRIPTION_COLLISIONS,
  KNOWN_EXTERNAL_SKILL_REFERENCES,
  KNOWN_SKILL_COMPANION_DOCUMENTS,
  NOUN_AMBIGUOUS_IMPERATIVE_VERBS,
  PENDING_ANATOMY_BACKFILL,
  PERMANENT_ANATOMY_EXEMPTIONS,
  REJECTED_CHANGES_LEDGER,
  type BundledSkillCheck,
  bareImperativeOpening,
  bundledSkillCompanionDocuments,
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
  redFlagsTableBody,
  renderBundledEvaluation,
  skillLineCount,
} from "./bundled-eval";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";

/**
 * Each tree is evaluated once per run, and every test reads that same result.
 *
 * `evaluateBundledTree` walks and parses a whole tree; nearly every test here
 * called it, so a file with ~50 tests walked the shipped tree and the fixture
 * tree dozens of times. Bun's per-test timeout is 5s, and on a loaded machine
 * those repeated walks were enough to trip it — which is what made three tests
 * in this file fail intermittently while passing in isolation, with the run's
 * test count drifting as timeouts cut registration short.
 *
 * Caching is safe because every fixture is written in `beforeAll`, before any
 * test runs, and nothing here mutates a tree afterwards. A test that needs its
 * own tree still calls `evaluateBundledTree(itsOwnRoot)` directly.
 */
let realEvaluation: ReturnType<typeof evaluateBundledTree> | undefined;
let fixtureEvaluation: ReturnType<typeof evaluateBundledTree> | undefined;

function realTree(): ReturnType<typeof evaluateBundledTree> {
  realEvaluation ??= evaluateBundledTree();
  return realEvaluation;
}

function fixtureTree(): ReturnType<typeof evaluateBundledTree> {
  fixtureEvaluation ??= evaluateBundledTree(fixtureRoot);
  return fixtureEvaluation;
}

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

    const evaluation = realTree();
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
    // T16: companions (`orchestrator-prompt.md`, `SKILL.detail.md`) join the
    // walked-document count too, though they draw a different set of checks
    // (see the dedicated companion-document tests below).
    const companions = bundledSkillCompanionDocuments(skillsRoot);

    // Strictly more documents than skills, or the walker is still canonical-only.
    expect(documents.length).toBeGreaterThan(canonical.length);
    // Every canonical file is still in the set — a walker that swapped one set
    // for the other would satisfy the line above and check less than before.
    for (const file of canonical) expect(documents).toContain(file);

    const evaluation = realTree();
    expect(evaluation.documents).toBe(documents.length + companions.length);
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
      `documents_evaluated: ${documents.length + companions.length}`,
    );
  });

  test("companion documents (orchestrator-prompt.md, SKILL.detail.md) are read for cross-references", () => {
    // T16's carry-over: `orchestrator-prompt.md` — shipped by five
    // orchestration skills — was invisible to every check in this sweep
    // before, since it is neither `SKILL.md` nor a named harness build and
    // `document:addressable`'s own walk only looks at `SKILL.*.md`-shaped
    // names. `bundledSkillCompanionDocuments` is the walk that closes that
    // gap; this asserts it actually finds the five shipped copies plus
    // feature-analyzer's `SKILL.detail.md`.
    const skillsRoot = path.join(defaultBundledRoot(), "skills");
    const companions = bundledSkillCompanionDocuments(skillsRoot);
    expect(companions.length).toBeGreaterThanOrEqual(6);
    for (const skill of ["context-collector", "feature-analyzer", "issue-analyzer", "job-orchestrator", "task-implementer"]) {
      expect(companions.some((file) => file.includes(`${path.sep}${skill}${path.sep}orchestrator-prompt.md`))).toBe(
        true,
      );
    }
    expect(companions.some((file) => file.endsWith(`${path.sep}SKILL.detail.md`))).toBe(true);

    // Read for cross-references, but never for frontmatter or anatomy: a
    // companion document has none, by definition, and must not be reported
    // as missing something it was never meant to have.
    const evaluation = realTree();
    const companionRelPaths = new Set(
      companions.map((file) => path.relative(skillsRoot, file).split(path.sep).join("/")),
    );
    const findingsOnCompanions = evaluation.findings.filter((finding) => companionRelPaths.has(finding.file));
    for (const finding of findingsOnCompanions) {
      expect(["xref:skill", "xref:path"]).toContain(finding.check);
    }
  });

  test("every shipped skill passes structural validation", () => {
    const evaluation = realTree();
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
    const rendered = renderBundledEvaluation(realTree());
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
 * The same violation, spelled as a YAML block list rather than the quoted
 * comma-separated scalar every shipped skill uses. Flow 257 T16's carry-over:
 * the check used to read `compatible_harnesses` with a single-line regex
 * (`/^\s{2,}compatible_harnesses\s*:\s*(.+)$/m`) that requires text on the
 * SAME line as the key — a block list's key line has nothing after the colon,
 * so the regex found no match, `frontmatter:harness-claude` never fired, and
 * this exact violation would have shipped silently. Proves the check now
 * reads through `parseSkillFrontmatter`, which understands both shapes.
 */
const HARNESS_BLOCK_LIST_EXCLUDES_CLAUDE_SKILL = `---
name: harness-block-list-excludes-claude
description: Proves a nested YAML sequence under metadata parses the same way a flat scalar does.
metadata:
  version: 1.0.0
  compatible_harnesses:
    - cursor
    - codex
---

# Harness Block List Excludes Claude

VIOLATION frontmatter:harness-claude — compatible_harnesses above is a YAML
block list, not the single-line scalar shape, and still never names claude.
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
 * Flow 257 T19 — "not for" with no word boundary matched inside "not
 * formatted", so ANY sentence about formatting supplied a skill's whole
 * disambiguation. This document says "not formatted" and says nothing else
 * about what it excludes, so it must still be rejected.
 */
const NOT_FORMATTED_SKILL = `---
name: not-formatted-example
description: Use when a fixture must prove the disambiguation clause is matched on word boundaries rather than as a bare substring.
metadata:
  version: 1.0.0
---

# Substring Disambiguation Fixture

VIOLATION anatomy:sections (trigger-not-for) — the one occurrence of the
clause's spelling in this document sits inside the word "formatted": the
report below is not formatted as JSON, which says nothing whatever about what
this skill excludes.

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "The substring is present, so the clause is present" | "not formatted" is a sentence about output shape, and excludes nothing |
| "Nobody would really write it that way" | Eleven shipped skills discuss output formats; any of them could have satisfied this leg by accident |
| "A boundary check is pedantry" | Without one, "not forced" and "not fortunate" also count as disambiguations |

## Verification

This fixture trips only the \`trigger-not-for\` leg of \`anatomy:sections\`.
`;

/**
 * Flow 257 T19 — a `## Verification` heading with no body under it. The
 * heading announces a completion contract and then supplies none, which is
 * exactly as useful to a caller as no heading at all.
 *
 * The heading is the LAST line on purpose: `sectionBody` reads to the next
 * heading at the same level or shallower, so an empty section at the end of a
 * file is the shape with nothing at all to find.
 */
const EMPTY_VERIFICATION_SKILL = `---
name: empty-verification-example
description: Use when a fixture must prove an empty section body fails the same way a missing section does. NOT for a document whose Verification section states anything at all.
metadata:
  version: 1.0.0
---

# Empty Completion Contract Fixture

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "The heading is there, so the section is there" | A heading with nothing under it states no exit criteria |
| "Somebody will fill it in later" | It shipped, and the check reported it as compliant meanwhile |
| "An empty section is better than none" | It is strictly worse: it reads as a contract in every listing that counts headings |

## Verification
`;

/**
 * Flow 257 T19 — two skills shipping one Red Flags table, byte for byte.
 *
 * Both have distinct descriptions, so `description:collision` stays quiet and
 * the only thing these two share is the table — which is the point: a table
 * pasted from a sibling passes `anatomy:sections` while naming that sibling's
 * rationalizations and none of this skill's own.
 */
const SHARED_RED_FLAGS_TABLE = `| Rationalization | Why it's wrong |
|---|---|
| "A table from a similar skill is close enough" | It names the other skill's excuses, which are the ones this skill does not make |
| "Copying is faster than writing three rows" | Three rows nobody wrote for this skill is three rows nobody will act on |
| "The check only asks whether a table exists" | It asked that once, and this fixture is why it no longer does |`;

const RED_FLAGS_COLLISION_A_SKILL = `---
name: red-flags-collision-a
description: Use when a fixture must prove a rationalization table copied between skills is caught. NOT for a skill whose table is its own.
metadata:
  version: 1.0.0
---

# Red Flags Collision A

## Red Flags

${SHARED_RED_FLAGS_TABLE}

## Verification

This half of the pair is the original; the finding lands on the other half.
`;

/** The other half of the copied-table pair — see `RED_FLAGS_COLLISION_A_SKILL`. */
const RED_FLAGS_COLLISION_B_SKILL = `---
name: red-flags-collision-b
description: Use when proving a verbatim rationalization table drawn from elsewhere draws its own finding, separate from the anatomy check it satisfies. NOT for original tables.
metadata:
  version: 1.0.0
---

# Red Flags Collision B

## Red Flags

${SHARED_RED_FLAGS_TABLE}

## Verification

This half draws \`anatomy:red-flags-collision\`, and still passes
\`anatomy:sections\` — the two checks answer different questions.
`;

/**
 * Flow 257 T19 — the noun-ambiguous half of `description:bare-imperative`.
 *
 * "review" opens a verb phrase here because "the" can only introduce its
 * object, so this is the imperative the check was written for. Its false-
 * positive twin is `NOUN_SUBJECT_SKILL` below, which uses the same verb as an
 * ordinary noun and must stay silent.
 */
const NOUN_AMBIGUOUS_IMPERATIVE_SKILL = `---
name: noun-ambiguous-imperative-example
description: Use when review the diff for correctness before a merge. NOT for a description whose opening word heads a noun phrase.
metadata:
  version: 1.0.0
---

# Noun Ambiguous Imperative Fixture

VIOLATION description:bare-imperative — "Use when review the diff" is a
command; "the" cannot continue a noun phrase headed by "review".

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "review is a noun, so leave it alone" | It is a noun in "review comments", and a verb in "review the diff" |
| "The verb list should just drop it" | Dropping it loses the imperative this fixture demonstrates |
| "The following word cannot be trusted" | A determiner is a closed class; it introduces an object and nothing else |

## Verification

This fixture trips \`description:bare-imperative\` and nothing else.
`;

/**
 * The false positive the fourteen noun-ambiguous verbs used to produce: a
 * NOUN-PHRASE subject that happens to start with one of them. "Use when review
 * comments arrive" is the situational description this check exists to
 * encourage, and it was reported as a defect.
 */
const NOUN_SUBJECT_SKILL = `---
name: noun-subject-example
description: Use when review comments arrive on an open pull request and somebody has to act on them. NOT for a description that opens with a command.
metadata:
  version: 1.0.0
---

# Noun Subject Fixture

"review comments" is the subject of "arrive" — a situation, not an
instruction. This fixture must draw no description finding at all.

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "It starts with a verb, so it is imperative" | "review comments arrive" has no imperative reading available |
| "One false positive is an acceptable price" | It fires on the exact shape the check is trying to reward |
| "Authors can reword around the check" | They reword away from the clearest description they had |

## Verification

This fixture draws only the catalogue finding every fixture here draws.
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
 * A skill that is correct in every way except its length.
 *
 * Built rather than written out so the fixture can be longer than a ceiling
 * without carrying hundreds of literal filler lines in this file. Every other
 * check has to pass, or a length test could be satisfied by the wrong finding:
 * the description carries a trigger and a NOT-for clause, the body has a Red
 * Flags table with three rows and a Verification section, and the description
 * differs per fixture so `description:collision` stays quiet, and its first
 * Red Flags row names the skill so `anatomy:red-flags-collision` stays quiet
 * too — two fixtures built by one generator would otherwise ship one table
 * twice, which is precisely what that check reports.
 */
function oversizedSkill(name: string, description: string, bodyLines: number): string {
  // Deliberately free of `:`, `.` and `/`: the cross-reference scan treats a
  // token that looks like a path as one and tries to resolve it, so filler
  // written as prose with punctuation turns a 500-line fixture into hundreds
  // of resolutions per evaluation, and this file evaluates the fixture tree
  // once per test.
  const filler = Array.from(
    { length: bodyLines },
    (_, index) => `Filler line ${index + 1} - body text whose only job is to reach a ceiling`,
  ).join("\n");
  return `---
name: ${name}
description: ${description}
metadata:
  version: 1.0.0
---

# ${name}

## Red Flags

| Rationalization | Why it's wrong |
|---|---|
| "One more section is cheap for ${name}" | Every line is a line an agent reads before it can act |
| "The ceiling is advisory" | \`anatomy:length\` is a finding, and the sweep exits non-zero |
| "Raising the number is the fix" | The rule allows lowering a ceiling only |

## Verification

This fixture draws \`anatomy:length\` and no other content finding.

${filler}
`;
}

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
 * Flow 257 T16 carry-over (L-006): `PATH_REFERENCE` swept a sentence-ending
 * period into the captured path, because `.` is itself a valid path
 * character (`.md`) and the regex has no way to tell "end of extension" from
 * "end of sentence" while it is still matching. Two lines exercise the fix
 * in both directions: the first names a real file in plain prose, sentence
 * period and all, and must draw nothing once the period is dropped; the
 * second names a path that has never existed, in the same shape, and must
 * still be reported — WITHOUT the sentence period surviving into the message.
 */
const PATH_TRAILING_PERIOD_SKILL = `---
name: path-trailing-period-example
description: Use when confirming a path quoted at the end of a sentence still resolves without its period.
metadata:
  version: 1.0.0
---

# Path Trailing Period Example

See .metaproject/skills/gdskills/quality/control-example/SKILL.md for the fully compliant shape.

VIOLATION xref:path — this is nothing like .metaproject/skills/gdskills/quality/does-not-exist-either/SKILL.md, and the sentence period above must not survive into the reported path.
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
  writeSkill(
    fixtureRoot,
    "quality",
    "harness-block-list-excludes-claude",
    HARNESS_BLOCK_LIST_EXCLUDES_CLAUDE_SKILL,
  );
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
  // T19: one missing section, in a skill that also ships a harness build. The
  // build carries the same body by construction (`document:build-parity`
  // requires it), so an ungated anatomy sweep reports the one defect twice.
  writeSkillFile(
    fixtureRoot,
    "quality",
    "no-red-flags-example",
    skillBuildFileName("codex"),
    NO_RED_FLAGS_SKILL,
  );
  writeSkill(fixtureRoot, "quality", "not-formatted-example", NOT_FORMATTED_SKILL);
  writeSkill(fixtureRoot, "quality", "empty-verification-example", EMPTY_VERIFICATION_SKILL);
  writeSkill(fixtureRoot, "quality", "red-flags-collision-a", RED_FLAGS_COLLISION_A_SKILL);
  writeSkill(fixtureRoot, "quality", "red-flags-collision-b", RED_FLAGS_COLLISION_B_SKILL);
  writeSkill(fixtureRoot, "quality", "noun-ambiguous-imperative-example", NOUN_AMBIGUOUS_IMPERATIVE_SKILL);
  writeSkill(fixtureRoot, "quality", "noun-subject-example", NOUN_SUBJECT_SKILL);
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
  // Two length fixtures, one per branch of `anatomy:length`.
  //
  // `oversized-no-ceiling` has no entry in SKILL_LENGTH_CEILINGS, so the
  // default bounds it; `commit` deliberately reuses a real skill key, which is
  // the only way to exercise the RECORDED branch — a ceiling exists for that
  // key and this fixture is longer than it.
  writeSkill(
    fixtureRoot,
    "quality",
    "oversized-no-ceiling",
    oversizedSkill(
      "oversized-no-ceiling",
      "Use when a skill that nobody recorded a ceiling for grows past the default, so the fallback bound is what reports it. NOT for a skill whose ceiling is already recorded — see the commit fixture.",
      520,
    ),
  );
  writeSkill(
    fixtureRoot,
    "quality",
    "commit",
    oversizedSkill(
      "commit",
      "Use when a skill with a recorded ceiling grows past exactly that number, proving the recorded bound is read instead of the default. NOT for an unrecorded skill — see the oversized-no-ceiling fixture.",
      120,
    ),
  );
  writeSkill(fixtureRoot, "quality", "source-tree-only-example", SOURCE_TREE_ONLY_SKILL);
  writeSkill(fixtureRoot, "quality", "path-trailing-period-example", PATH_TRAILING_PERIOD_SKILL);
  mkdirSync(path.join(fixtureRoot, "skills", "shared"), { recursive: true });
  writeFileSync(path.join(fixtureRoot, "skills", "shared", "example-script.md"), "# Example\n", "utf8");
  writeRule(fixtureRoot, "sibling-rule.mdc", SIBLING_RULE);
  writeRule(fixtureRoot, "broken-rule.mdc", BROKEN_RULE);
});

afterAll(() => {
  if (fixtureRoot.length > 0) rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * Every way the recorded ceilings disagree with the tree they bound, as lines
 * a failure message can print.
 *
 * Takes the map as an argument so the ratchet's own rule can be exercised on a
 * map that breaks it — a test that could only read `SKILL_LENGTH_CEILINGS`
 * itself would assert the tree is currently fine and never that the comparison
 * bites. `[]` means every shipped skill has an entry, every entry names a
 * shipped skill, and each one equals that skill's line count exactly.
 */
function ceilingMismatches(ceilings: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  const shipped = new Set<string>();
  for (const file of bundledSkillFiles(path.join(defaultBundledRoot(), "skills"))) {
    if (path.basename(file) !== "SKILL.md") continue;
    const parts = file.split(path.sep);
    const key = `${parts[parts.length - 3]}/${parts[parts.length - 2]}`;
    shipped.add(key);
    const ceiling = ceilings.get(key);
    if (ceiling === undefined) {
      out.push(`${key}: ships, but no ceiling is recorded`);
      continue;
    }
    const lines = skillLineCount(readFileSync(file, "utf8"));
    if (lines === ceiling) continue;
    out.push(
      `${key}: ships ${lines} lines, ceiling records ${ceiling} — ` +
        (lines > ceiling
          ? "the skill grew past its ceiling; split it or move reference material out, and never raise the number"
          : "the ceiling sits above the file: either it was raised, which the ratchet forbids, or the skill was trimmed without lowering the ceiling in the same change"),
    );
  }
  for (const key of ceilings.keys()) {
    if (!shipped.has(key)) out.push(`${key}: recorded, but no such skill ships`);
  }
  return out.sort();
}

describe("AC8: the evaluator fails a skill that deserves to fail", () => {
  function findingsFor(skill: string): { check: BundledSkillCheck; message: string }[] {
    return fixtureTree()
      .findings.filter((finding) => finding.skill === skill)
      .map((finding) => ({ check: finding.check, message: finding.message }));
  }

  test("the fixture tree is non-empty, or the rejection below proves nothing", () => {
    const evaluation = fixtureTree();
    // Twenty-five skills: the original fourteen, flow 257 T7's three
    // `description:*` fixtures, T11's colliding pair
    // (description-collision-a, description-collision-b), T8's four
    // `anatomy:sections` fixtures (no-not-for-example, no-red-flags-example,
    // too-few-red-flags-rows-example, no-verification-example), and T16's
    // two carry-over fixtures (block-list `compatible_harnesses`, trailing
    // sentence period), each shipping one plain SKILL.md.
    // Plus T9's two `anatomy:length` fixtures: one past the default because it
    // has no recorded ceiling, one past a ceiling that is recorded.
    // Plus T19's six: the "not formatted" substring, the empty Verification
    // body, the copied-Red-Flags pair, and the noun-ambiguous imperative with
    // its noun-phrase twin.
    expect(evaluation.skills).toBe(33);
    // Thirty-six documents: thirty-three skills, plus the Codex builds of
    // `build-drift-example`, `harness-field-only` and (T19) `no-red-flags-example`.
    expect(evaluation.documents).toBe(36);
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

  test("a path quoted at the end of a sentence resolves without its trailing period", () => {
    // L-006: a real file cited in plain prose, sentence period and all, must
    // not be reported — the period is not part of the path.
    const clean = findingsFor("path-trailing-period-example").filter(
      (finding) =>
        finding.check === "xref:path" &&
        finding.message.includes("skills/quality/control-example/SKILL.md"),
    );
    expect(clean).toEqual([]);

    // A path that has never existed, cited the same way, must still be
    // reported — and the message must name it WITHOUT the sentence period
    // that follows it in the source, or the fix has only hidden the bug
    // rather than fixed it.
    const broken = findingsFor("path-trailing-period-example").filter(
      (finding) => finding.check === "xref:path",
    );
    expect(broken).toHaveLength(1);
    expect(broken[0]?.message).toContain("skills/quality/does-not-exist-either/SKILL.md");
    expect(broken[0]?.message).not.toContain("SKILL.md.");
  });

  test("a reference inside a rule file to a missing path is reported", () => {
    // Item 2: rule files under `rules/core/` are swept for cross-references
    // the same way skill documents are — nothing read them before this.
    const evaluation = fixtureTree();
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

  test("a noun-ambiguous verb fires only when a determiner follows it", () => {
    // T19. Fourteen words in the verb set are ordinary nouns at least as often
    // as they are verbs, and each one turned a perfectly good situational
    // description into a finding. The tree fixture proves the imperative half
    // still bites; the assertions below prove the noun half no longer does.
    const fired = findingsFor("noun-ambiguous-imperative-example").filter(
      (finding) => finding.check === "description:bare-imperative",
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.message).toContain('"Use when review');

    // The twin: same verb, noun-phrase subject, no finding of any kind past
    // the catalogue one every fixture here draws.
    expect(new Set(findingsFor("noun-subject-example").map((finding) => finding.check))).toEqual(
      new Set(["catalog:registered"]),
    );

    // Every one of the fourteen, in both readings — the false positive each
    // used to produce, and the imperative each still catches. Listed rather
    // than sampled: a word quietly moved back into `BARE_IMPERATIVE_VERBS`
    // would otherwise reintroduce its own false positive unnoticed.
    const nounPhrases: Record<string, string> = {
      review: "review comments arrive on an open pull request",
      check: "check results land in the pipeline summary",
      commit: "commit history has to be rewritten before a merge",
      update: "update notifications interrupt a running job",
      install: "install output reports a missing peer dependency",
      document: "document sections drift from the code they describe",
      push: "push protection blocks a branch",
      run: "run duration exceeds the budget",
      start: "start time is later than the deadline",
      debug: "debug output floods a log",
      fix: "fix attempts keep reopening the same issue",
      split: "split packages disagree on a shared version",
      draft: "draft pull requests pile up unreviewed",
      edit: "edit conflicts appear in a shared file",
    };
    for (const [verb, phrase] of Object.entries(nounPhrases)) {
      expect(NOUN_AMBIGUOUS_IMPERATIVE_VERBS.has(verb)).toBe(true);
      expect(BARE_IMPERATIVE_VERBS.has(verb)).toBe(false);
      expect(bareImperativeOpening(`Use when ${phrase}.`)).toBeUndefined();
      expect(bareImperativeOpening(`Use when ${verb} the diff.`)).toBe(verb);
    }

    // The determiner set is what carries the distinction, so it has to be
    // non-empty and closed to the words that actually introduce an object.
    expect(IMPERATIVE_OBJECT_DETERMINERS.size).toBeGreaterThan(0);
    expect(bareImperativeOpening("Use when review your own diff.")).toBe("review");
    expect(bareImperativeOpening("Use when review queues grow.")).toBeUndefined();
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
    const evaluation = fixtureTree();
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

  test("a document with no Red Flags table is rejected ONCE, even when it also ships a harness build", () => {
    // T19: `anatomy:sections` used to run per DOCUMENT, so a skill with four
    // builds reported one missing section five times. `document:build-parity`
    // already forces every build to carry its `SKILL.md`'s body, so the build
    // is the same fact — the fixture ships a Codex build of this exact file to
    // pin that. Before the guard this expectation read 2.
    const found = findingsFor("no-red-flags-example").filter((finding) => finding.check === "anatomy:sections");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("Red Flags");

    // Located in the canonical file, not in the build — the build is where the
    // defect is copied, `SKILL.md` is where it is fixed.
    const located = fixtureTree().findings.filter(
      (finding) => finding.check === "anatomy:sections" && finding.skill === "no-red-flags-example",
    );
    expect(located.map((finding) => finding.file)).toEqual(["quality/no-red-flags-example/SKILL.md"]);
    // …and the build really is there to be over-reported, or this proves nothing.
    expect(existsSync(path.join(fixtureRoot, "skills", "quality", "no-red-flags-example", skillBuildFileName("codex"))))
      .toBe(true);
  });

  test("a NOT-for clause is matched on word boundaries — \"not formatted\" is not a disambiguation", () => {
    // T19: `/not for/i` had a boundary at neither end, so any sentence about
    // formatting satisfied the clause for the whole document.
    const found = findingsFor("not-formatted-example").filter((finding) => finding.check === "anatomy:sections");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("NOT for");
  });

  test("a Verification heading with an empty section body is rejected", () => {
    // T19: presence was the whole bar, so `## Verification` with nothing under
    // it announced a completion contract and supplied none.
    const found = findingsFor("empty-verification-example").filter(
      (finding) => finding.check === "anatomy:sections",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("Verification");
  });

  test("two skills shipping one Red Flags table draw a collision finding naming both", () => {
    // T19: a table pasted from a sibling satisfies `anatomy:sections` while
    // naming that sibling's rationalizations. Attributed to the later key of
    // the group, the same convention `description:collision` uses.
    const found = fixtureTree().findings.filter((finding) => finding.check === "anatomy:red-flags-collision");
    expect(found).toHaveLength(1);
    expect(found[0]?.skill).toBe("red-flags-collision-b");
    expect(found[0]?.file).toBe("quality/red-flags-collision-b/SKILL.md");
    expect(found[0]?.message).toContain("quality/red-flags-collision-a");

    // Both halves still PASS `anatomy:sections`: the table exists, which is
    // the question that check asks. The two findings are not interchangeable.
    for (const skill of ["red-flags-collision-a", "red-flags-collision-b"]) {
      expect(findingsFor(skill).filter((finding) => finding.check === "anatomy:sections")).toEqual([]);
    }
    // And the original draws no collision finding of its own — one group, one
    // finding, not one per member.
    expect(findingsFor("red-flags-collision-a").filter((f) => f.check === "anatomy:red-flags-collision")).toEqual([]);
  });

  test("a Red Flags table of placeholder rows does not count as one", () => {
    // T19: three rows reading `| a | b |` satisfied the row threshold, so the
    // check passed on a table that names no rationalization and no rebuttal.
    const placeholder = "## Red Flags\n\n| A | B |\n|---|---|\n| a | b |\n| c | d |\n| e | f |\n";
    expect(hasRedFlagsSection(placeholder)).toBe(false);
    expect(redFlagsTableBody(placeholder)).toEqual([]);

    // A single-column list of excuses with no answers is not the pair shape.
    const oneColumn =
      "## Red Flags\n\n| Rationalization |\n|---|\n| \"It is probably fine to skip this step\" |\n" +
      "| \"The previous run passed, so this one will\" |\n| \"Nobody reads this section anyway\" |\n";
    expect(hasRedFlagsSection(oneColumn)).toBe(false);

    // The real shape still passes, and the shipped floor is nowhere near the
    // threshold: the shortest data row in any shipped table carries 72
    // characters of cell text.
    expect(ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS).toBe(24);
    expect(ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS).toBeLessThan(72);
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

    // T19 — bounded at both ends. Each of these contains the substring "not
    // for" and none of them says what the skill excludes.
    expect(hasNotForClause("The report is not formatted as JSON.")).toBe(false);
    expect(hasNotForClause("A rewrite here is not forced.")).toBe(false);
    expect(hasNotForClause("That outcome was not fortunate.")).toBe(false);
    // A clause broken across a line still counts — prose wraps.
    expect(hasNotForClause("Use when doing X, not\nfor anything else.")).toBe(true);
  });

  test("hasRedFlagsSection requires a heading AND a table or list of at least the minimum rows", () => {
    const headingOnly = "## Red Flags\n\nJust a paragraph, no table.\n";
    expect(hasRedFlagsSection(headingOnly)).toBe(false);

    const oneRow =
      "## Red Flags\n| A | B |\n|---|---|\n| \"One row is plenty here\" | It is a callout, not a table |\n";
    expect(hasRedFlagsSection(oneRow)).toBe(false);

    // Three rows, each carrying a named excuse and the answer to it — the
    // shape every shipped table has. T19 added the per-row substance floor,
    // so the rows have to say something; `| one | row |` no longer counts.
    const threeRows =
      "## Red Flags\n| A | B |\n|---|---|\n" +
      "| \"Skipping this step is fine\" | It is the step the rest depends on |\n" +
      "| \"The last run passed\" | The last run did not touch this path |\n" +
      "| \"Nobody reads this section\" | The agent reading it is the audience |\n";
    expect(hasRedFlagsSection(threeRows)).toBe(true);
    expect(redFlagsTableBody(threeRows)).toHaveLength(3);

    // The two-column bullet-list alternative AC3 names, with no shipped
    // example today: still accepted once it reaches the row threshold, and
    // held to the same substance floor as a table row.
    const bulletList =
      "## Red Flags\n" +
      "- \"Skipping this step is fine\" — it is the step the rest depends on\n" +
      "- \"The last run passed\" — the last run did not touch this path\n" +
      "- \"Nobody reads this section\" — the agent reading it is the audience\n";
    expect(hasRedFlagsSection(bulletList)).toBe(true);
    expect(hasRedFlagsSection("## Red Flags\n- \"a\" — b\n- \"c\" — d\n- \"e\" — f\n")).toBe(false);

    // job-orchestrator's actual shape: an isolated single-row callout under
    // its own heading, nowhere near the threshold — must not pass.
    const scatteredCallout = "### Red Flag\n**\"a rationalization\"**\nA paragraph of rebuttal, no table.\n";
    expect(hasRedFlagsSection(scatteredCallout)).toBe(false);
  });

  test("hasVerificationSection accepts a heading, a STATUS contract line, or an explicit exit-criteria enum", () => {
    expect(hasVerificationSection("## Verification\n\nEvery task reports PASS or FAIL.\n")).toBe(true);
    expect(hasVerificationSection("## Phase 3: Verification And Review\n\nRe-run the suite.\n")).toBe(true);
    expect(hasVerificationSection("## Exit Criteria\n\n- the build is green\n")).toBe(true);
    expect(hasVerificationSection("STATUS: DONE\n")).toBe(true);

    // T19 — a heading is not a section. Both of these announce a completion
    // contract and state none: the first has nothing under it at all, the
    // second only a blank line before the next heading.
    expect(hasVerificationSection("## Verification\n")).toBe(false);
    expect(hasVerificationSection("## Verification\n\n\n## Something Else\n\nUnrelated.\n")).toBe(false);
    // A deeper heading INSIDE the section is content, not a terminator.
    expect(hasVerificationSection("## Verification\n\n### Exit states\n\nDONE or BLOCKED.\n")).toBe(true);
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

  /**
   * The one blockquote inside the rule's "Length Ceilings" section, `> `
   * markers stripped. It throws rather than returning an empty string if the
   * section or the quote moves: comparing a message against "" would pass for
   * any message, which is the failure mode this comparison exists to close.
   */
  function lengthCeilingsBlockquote(rule: string): string {
    const lines = rule.split("\n");
    const start = lines.findIndex((line) => line.trim() === "## Length Ceilings");
    if (start === -1) throw new Error('skills-storage-workflow.mdc has no "## Length Ceilings" section');
    const after = lines.slice(start + 1);
    const end = after.findIndex((line) => line.startsWith("## "));
    const section = end === -1 ? after : after.slice(0, end);
    const quoted = section.filter((line) => line.startsWith(">")).map((line) => line.replace(/^>\s?/, ""));
    if (quoted.length === 0) throw new Error('"Length Ceilings" has no blockquote to compare the message against');
    return quoted.join("\n");
  }

  test("a skill past its recorded ceiling is reported, naming that ceiling", () => {
    // The fixture reuses the real `quality/commit` key precisely so the
    // RECORDED branch is what fires: a ceiling exists for it, and the fixture
    // is longer than that number.
    const recorded = SKILL_LENGTH_CEILINGS.get("quality/commit");
    expect(recorded).toBeGreaterThan(0);
    const found = findingsFor("commit").filter((finding) => finding.check === "anatomy:length");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`recorded ceiling of ${recorded}`);

    // T19: the finding used to end "raise the ceiling only when the growth was
    // decided", which told an operator to do the one thing the rule it cites
    // forbids. The remedy it names now has to be the rule's remedy — and the
    // rule is read here rather than paraphrased, because a message and a rule
    // agreeing in this file's opinion is what went wrong the first time.
    const message = found[0]?.message ?? "";
    expect(message).toContain("Split the skill");
    expect(message).toMatch(/only ever moves DOWN/);
    expect(message).not.toMatch(/raise the ceiling only/i);

    const rule = readFileSync(
      path.join(defaultBundledRoot(), "rules", "core", "skills-storage-workflow.mdc"),
      "utf8",
    );
    expect(rule).toContain("A ceiling **moves down**, never up");

    // T23: the three fragments above left every other word free to drift —
    // the rule could say the opposite in the sentence between them and stay
    // green. The rule's blockquote and the remedy the code actually produces
    // are compared in FULL here: alter one word of either and this fails.
    const remedyStart = message.indexOf("Split the skill");
    expect(remedyStart).toBeGreaterThan(-1);
    // Whitespace only. The rule wraps the quote over five lines and the
    // message is one line, so line breaks cannot be part of the comparison;
    // no word and no punctuation is normalised away.
    const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(collapse(lengthCeilingsBlockquote(rule))).toBe(collapse(message.slice(remedyStart)));
  });

  test("a skill with no recorded ceiling is bounded by the default", () => {
    expect(SKILL_LENGTH_CEILINGS.has("quality/oversized-no-ceiling")).toBe(false);
    const found = findingsFor("oversized-no-ceiling").filter(
      (finding) => finding.check === "anatomy:length",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`default ${DEFAULT_SKILL_LENGTH_CEILING}`);
  });

  test("a skill within its ceiling draws no length finding", () => {
    expect(findingsFor("control-example").filter((finding) => finding.check === "anatomy:length"))
      .toEqual([]);
  });

  test("skillLineCount counts newlines, the way wc -l does", () => {
    expect(skillLineCount("")).toBe(0);
    expect(skillLineCount("one\ntwo\n")).toBe(2);
    // No trailing newline: the last line is still content, and `wc -l` reports
    // 1 here too — the ceiling must not move because a file lost its final
    // newline.
    expect(skillLineCount("one\ntwo")).toBe(1);
  });

  test("every recorded ceiling equals the line count that ships today — the ratchet only moves down", () => {
    // T19. This assertion used to be one-sided (`lines > ceiling` fails), and
    // one-sided is the same as absent for the edit it needs to stop: a review
    // raised `review/review-clean-code` from 545 to 1200 to clear a finding
    // and NOTHING in the suite went red. "Ceilings only move down" was prose
    // in three files and an assertion in none.
    //
    // Equality is the rule the AC itself states — a ceiling is the skill's
    // line count on the day it was recorded — and it is what makes the
    // ratchet executable: raising an entry fails here, and so does lowering
    // one without actually trimming the skill. The only edit that keeps this
    // green is trimming the file and recording what is left, in the same
    // change, which is exactly what `skills-storage-workflow.mdc` requires.
    //
    // NO EXCEPTION LIST, because the tree needs none: all 67 shipped skills
    // sit at exactly their recorded ceiling today. If a future trim genuinely
    // has to land before its ceiling can be lowered, the exception belongs
    // HERE, named, with the reason and the task that closes it — never as a
    // relaxation of the comparison, which would restore the hole this test
    // exists to close.
    expect(bundledSkillFiles(path.join(defaultBundledRoot(), "skills")).length).toBe(SKILL_LENGTH_CEILINGS.size);
    expect(ceilingMismatches(SKILL_LENGTH_CEILINGS)).toEqual([]);
  });

  test("raising a ceiling above what the skill ships is what this now fails on", () => {
    // Non-vacuity for the assertion above, run through the SAME comparison
    // rather than restated: `review/review-clean-code` is the entry a review
    // actually raised (545 -> 1200) while every test stayed green, so that
    // exact edit is the one this proves is now caught.
    expect(SKILL_LENGTH_CEILINGS.get("review/review-clean-code")).toBe(545);
    const raised = ceilingMismatches(new Map(SKILL_LENGTH_CEILINGS).set("review/review-clean-code", 1200));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain("review/review-clean-code: ships 545 lines, ceiling records 1200");
    expect(raised[0]).toContain("the ratchet forbids");

    // …and a skill that grows past a ceiling nobody touched is the other
    // direction of the same equality, reported in the words that say what to
    // do about it.
    const grown = ceilingMismatches(new Map(SKILL_LENGTH_CEILINGS).set("quality/push", 10));
    expect(grown).toHaveLength(1);
    expect(grown[0]).toContain("quality/push");
    expect(grown[0]).toContain("never raise the number");

    // An entry for a skill that no longer ships is a ceiling nothing is
    // measured against, and reads as coverage in the size comparison above.
    expect(ceilingMismatches(new Map(SKILL_LENGTH_CEILINGS).set("quality/deleted-skill", 1))).toEqual([
      "quality/deleted-skill: recorded, but no such skill ships",
    ]);
  });

  test("a defect that exists ONLY in a harness build is found", () => {
    // The AC5 proof. `build-drift-example/SKILL.md` is clean; the defect lives in
    // `SKILL.codex.md` alone. A sweep that walks canonical files only reports
    // nothing here, which is exactly what the shipped sweep did.
    const found = findingsFor("build-drift-example");
    const xref = found.filter((finding) => finding.check === "xref:skill");
    expect(xref).toHaveLength(1);
    expect(xref[0]?.message).toContain("only-in-the-codex-build");

    const located = fixtureTree().findings.find(
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
    const clean = fixtureTree().findings.filter(
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
    const buildFinding = fixtureTree().findings.filter(
      (finding) => finding.check === "frontmatter:harness-claude" && finding.skill === "harness-field-only",
    );
    expect(buildFinding).toEqual([]);
  });

  test("a compatible_harnesses YAML block list is read the same way as the scalar form", () => {
    // Carry-over from flow 257 T16's dispatch: the old single-line regex read
    // nothing after an empty `compatible_harnesses:` key line, so a block
    // list silently drew zero findings regardless of what it declared. This
    // fixture is the exact shape that used to slip through.
    const found = findingsFor("harness-block-list-excludes-claude").filter(
      (finding) => finding.check === "frontmatter:harness-claude",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("omits `claude`");
    expect(found[0]?.message).toContain("IS the Claude build");
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
    const evaluation = fixtureTree();
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
    const exercised = new Set(fixtureTree().findings.map((finding) => finding.check));
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
    // Two shapes live in this one map since flow 257 T16: a `SKILL.*.md`-shaped
    // name (what `document:addressable`'s own walk can mistake for a dead
    // build) and a name outside that shape entirely (`orchestrator-prompt.md`,
    // never at risk of that specific confusion, but still a companion
    // `bundledSkillCompanionDocuments` sweeps for cross-references). Every
    // entry, either shape, must still name a real reason and never a build.
    expect(KNOWN_SKILL_COMPANION_DOCUMENTS.size).toBeGreaterThan(0);
    for (const [name, why] of KNOWN_SKILL_COMPANION_DOCUMENTS) {
      expect(name.length).toBeGreaterThan(0);
      // A build name would be silently shadowed by the allowance, so refuse one.
      expect(HARNESS_SKILL_RUNTIMES.map((runtime) => skillBuildFileName(runtime))).not.toContain(name);
      expect(why.trim().length).toBeGreaterThan(0);
    }
    expect([...KNOWN_SKILL_COMPANION_DOCUMENTS.keys()]).toContain("SKILL.detail.md");
    expect([...KNOWN_SKILL_COMPANION_DOCUMENTS.keys()]).toContain("orchestrator-prompt.md");
  });

  test("an allowed generated path names the command that produces it", () => {
    expect(GENERATED_PATH_ROOTS.length).toBeGreaterThan(0);
    for (const entry of GENERATED_PATH_ROOTS) {
      expect(entry.prefix.endsWith("/")).toBe(true);
      expect(entry.producedBy).toMatch(/^keryx /);
    }
  });
});

// ---------------------------------------------------------------------------
// AC11: the rejected-change ledger
// ---------------------------------------------------------------------------

describe("AC11: the rejected-change ledger exists, is usable, and is the file the rule names", () => {
  // The ledger is checked HERE and not by `xref:path`, and that is a decision
  // with evidence rather than an omission — see `CHECKED_PATH_ROOTS`' comment
  // in `bundled-eval.ts`. In short: of the seventeen concrete `docs/…` paths
  // the bundled tree cites, ten (the sections `autodoc-orchestrator` generates
  // in a user's project) are missing here and seven exist only because this
  // repository happens to keep the layout `documentation-management.mdc`
  // prescribes — so the verdict would depend on whose tree the sweep runs in.
  // And `package.json`'s `files` does not publish `docs/skills/`, so the one
  // reference the root was meant to check would fail for every installed user
  // while passing in a checkout. This suite only ever runs in a checkout,
  // which is exactly where the ledger is true.
  const repoRoot = path.join(import.meta.dir, "..", "..");

  test("the ledger file exists at the path the constant names", () => {
    const ledger = path.join(repoRoot, REJECTED_CHANGES_LEDGER.path);
    expect(existsSync(ledger)).toBe(true);
  });

  test("the ledger carries the documented table header, so a row has somewhere to go", () => {
    const text = readFileSync(path.join(repoRoot, REJECTED_CHANGES_LEDGER.path), "utf8");
    expect(text).toContain(REJECTED_CHANGES_LEDGER.header);
    // A header row with no separator under it is not a table any renderer
    // shows, and the columns are the whole point: what was tried, why it was
    // rejected, and the evidence that sank it.
    const lines = text.split("\n");
    const header = lines.findIndex((line) => line.trim() === REJECTED_CHANGES_LEDGER.header);
    expect(header).toBeGreaterThan(-1);
    expect(lines[header + 1] ?? "").toMatch(/^\|(\s*:?-+:?\s*\|)+$/);
    // The append-only rule is the ledger's only real mechanism; a file that
    // dropped it would be a list somebody edits.
    expect(text.toLowerCase()).toContain("append-only");
  });

  test("the rule that requires the ledger names its path", () => {
    // The citation and the file are two halves of one contract: a rule
    // pointing somewhere else, or a ledger nothing points at, is the same
    // failure as the ledger not existing.
    const rule = readFileSync(
      path.join(defaultBundledRoot(), ...REJECTED_CHANGES_LEDGER.rule.split("/")),
      "utf8",
    );
    expect(rule).toContain(REJECTED_CHANGES_LEDGER.path);
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
