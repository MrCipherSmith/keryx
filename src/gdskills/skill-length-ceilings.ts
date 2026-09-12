// Flow 257, T9, AC4 — per-skill length ceilings, so growth is noticed rather
// than absorbed silently.
//
// WHAT THIS IS NOT
//
// A ceiling here is not a quality claim about the skill it names. Several
// entries below sit at or past 2000 lines and shipped that way; recording
// that number is not this file endorsing it as a reasonable size for a
// document an agent has to read whole. `bundled-eval.ts`'s `anatomy:length`
// check (which reads this map) exists for one narrower reason: a skill that
// grows past what it already was is a defect this sweep can catch and every
// other check in that file cannot. Whether 2246 lines is the right size for
// `job-orchestrator` is a question for a human editing that skill, not for
// this file or the check that reads it.
//
// NOR IS IT A BUDGET THAT CAN BE APPROVED. An earlier wording of this header
// called the defect "growth nobody decided on", which reads as though growth
// somebody DID decide on is answered by raising the number. It is not:
// `skills-storage-workflow.mdc`'s "Length Ceilings" section allows a ceiling
// to move down and never up, so a skill that needs more room than its ceiling
// allows is split, or its reference material moves into a sibling document,
// and the ceiling is lowered to what remains. Raising an entry below to clear
// an `anatomy:length` finding is the one edit that is always wrong here,
// however well-considered the growth was — it turns a measured limit into a
// record of whatever the file grew to, which is the thing the limit existed
// to prevent.
//
// WHAT A CEILING COVERS
//
// One number per skill, keyed `${category}/${name}` — the same key
// `descriptionsByKey`, `PENDING_ANATOMY_BACKFILL` and every other per-skill
// map in `bundled-eval.ts` already uses. It measures the canonical `SKILL.md`
// only, never a harness build beside it. `document:build-parity`
// (`bundled-eval.ts`) already forces every harness build's content — every
// field but `compatible_harnesses` — to match its `SKILL.md` byte for byte,
// so a build's line count is the same fact `SKILL.md`'s already is, not a
// second one worth a second ceiling. Measuring both would double-count a
// single overage as two findings the moment `SKILL.md` crosses its line, and
// would recover nothing `document:build-parity` does not already say the
// moment a build and its `SKILL.md` genuinely diverge in length.
//
// HOW THE NUMBERS BELOW WERE PRODUCED
//
// Each is the line count (`wc -l`, i.e. the number of newline characters —
// see `skillLineCount` in `bundled-eval.ts` for the identical count the check
// itself uses) of that skill's `SKILL.md` in the shipped tree, on the day this
// file was introduced. "Ceilings equal today's line counts when
// introduced" is the rule `skills-storage-workflow.mdc` states (see its
// "Length Ceilings" section) — not the smallest number that would pass today,
// not a round number, not headroom for planned growth. A skill absent from
// this map has no recorded ceiling; `anatomy:length` falls back to
// `DEFAULT_SKILL_LENGTH_CEILING` for it instead (see that constant's comment).
//
// WHY A TS MODULE, NOT JSON
//
// `model-tier.ts` and `catalog.ts` are the precedent this file follows: one
// executable definition, imported by the code that enforces it and by the
// tests that pin it, rather than a second parallel representation something
// could drift from. JSON was considered and rejected for one concrete reason
// past that precedent: `CEILINGS_BY_KEY` below is a single object literal
// with string-literal keys, and TypeScript itself rejects a duplicate key in
// that shape at compile time (`error TS1117: An object literal cannot have
// multiple properties with the same name`) — a copy-paste duplicate entry
// fails the build before any test runs. A JSON file offers no such check;
// a duplicate key there silently keeps only the last value, which is exactly
// the kind of quiet loss this file exists to prevent one level up.

/**
 * The line-count ceiling `anatomy:length` applies to a skill with no entry in
 * `SKILL_LENGTH_CEILINGS` — the number `review-style/SKILL.md` and
 * `context-collector/SKILL.md` already cite as the point past which a
 * document should be split rather than grow further (see their own "500
 * lines" guidance). A brand-new skill that ships bigger than this on day one
 * has no ceiling to compare against yet, so this is the bar it is held to
 * until one is recorded for it.
 */
export const DEFAULT_SKILL_LENGTH_CEILING = 500;

/**
 * `${category}/${name}` -> the line count of its `SKILL.md` on the day this
 * file was introduced (flow 257 T9). See the module header for what "line
 * count" means, what a ceiling does and does not claim, and why every skill
 * shipped at introduction got an entry rather than only the ones already over
 * `DEFAULT_SKILL_LENGTH_CEILING` — a skill under the default needs a recorded
 * ceiling exactly as much as one over it, or it could grow to just under the
 * default, then again, forever, one compliant step at a time.
 *
 * Sorted by key. `skills-storage-workflow.mdc`'s "Length Ceilings" section
 * states the ratchet this map is bound by: a ceiling may be LOWERED when a
 * skill is genuinely trimmed, never raised to accommodate growth.
 *
 * THE RATCHET IS TESTED, NOT MERELY DESCRIBED (flow 257 T19). "Ceilings only
 * move down" was prose in three files and an assertion in none: the check
 * itself compares `lines > ceiling`, so raising any entry here silently
 * cleared its own finding, and the one test over this map asked only that a
 * ceiling not sit BELOW the file it bounds — a review raised
 * `review/review-clean-code` from 545 to 1200 and the whole suite stayed
 * green. `bundled-eval.test.ts`'s "every recorded ceiling equals the line
 * count that ships today" pins the equality both directions instead, so the
 * only edit that keeps the suite green is trimming the skill and recording
 * what is left.
 */
const CEILINGS_BY_KEY = {
  "core/reviewer-skill-creator": 280,
  "orchestration/code-verifier": 346,
  "orchestration/context-collector": 671,
  "orchestration/feature-analyzer": 447,
  "orchestration/feature-dev": 177,
  "orchestration/flow-orchestrator": 696,
  "orchestration/issue-analyzer": 373,
  "orchestration/job-documenter": 414,
  "orchestration/job-orchestrator": 2246,
  "orchestration/task-implementer": 670,
  "planning/autodoc-analyst": 180,
  "planning/autodoc-architect": 179,
  "planning/autodoc-assembler": 145,
  "planning/autodoc-orchestrator": 343,
  "planning/autodoc-scanner": 183,
  "planning/autodoc-writer": 270,
  "planning/brainstorm": 115,
  "planning/consistency-checker": 208,
  "planning/docpack-orchestrator": 172,
  "planning/docpack-review": 92,
  "planning/interview": 209,
  "planning/interviewer": 131,
  "planning/patterns-researcher": 254,
  "planning/planner": 208,
  "planning/prd-creator": 210,
  "planning/problem-definer": 170,
  "planning/project-discovery": 183,
  "planning/spec-writer": 248,
  "planning/stack-advisor": 198,
  "platform/agent-entrypoint-distiller": 78,
  "platform/claude-md-management": 111,
  "platform/hookify": 125,
  "quality/changelog": 104,
  "quality/commit": 87,
  "quality/db-migrate": 87,
  "quality/dependency-update": 102,
  "quality/deploy": 93,
  "quality/fresh-eyes": 190,
  "quality/metaproject-security": 124,
  "quality/perf-check": 104,
  "quality/pr": 95,
  "quality/pr-issue-documenter": 401,
  "quality/push": 73,
  "quality/root-cause": 204,
  "quality/security-audit": 129,
  "quality/test-gen": 101,
  "quality/tests-creator": 360,
  "review/code-ai-review": 238,
  "review/code-learned-review": 283,
  "review/code-mobx-store-review": 301,
  "review/code-style-review": 208,
  "review/review-architecture": 386,
  "review/review-backend": 370,
  "review/review-clean-code": 545,
  "review/review-core-boundaries": 163,
  "review/review-flow-graph": 188,
  "review/review-frontend": 634,
  "review/review-frontend-conventions": 213,
  "review/review-highload": 550,
  "review/review-layout": 238,
  "review/review-logic": 377,
  "review/review-orchestrator": 1907,
  "review/review-performance": 374,
  "review/review-pr-feedback": 895,
  "review/review-regression": 216,
  "review/review-security-code": 381,
  "review/review-style": 362,
  "review/review-testing-practices": 319,
  "review/review-verifier": 299,
} satisfies Record<string, number>;

/** `${category}/${name}` -> its recorded ceiling. See the module header. */
export const SKILL_LENGTH_CEILINGS: ReadonlyMap<string, number> = new Map(Object.entries(CEILINGS_BY_KEY));
