/**
 * How a user asks for each bundled skill, and which skill must win when two of
 * them look alike.
 *
 * `routing-baseline.ts` next door records what the router DOES for 27
 * hand-picked queries, scores pinned, so a change to the scorer shows up as a
 * diff someone has to justify. That file is deliberately narrow: it watches the
 * scorer. This one watches the CATALOG. Every skill's description and trigger
 * list is now read from its own SKILL.md, which means an editor improving one
 * skill's prose can silently take another skill's queries away from it, and the
 * pinned-score baseline would not notice — none of its 27 queries names most of
 * the 78 skills at all.
 *
 * So the corpus is per-skill and it is exhaustive. Each entry carries:
 *
 * - `positives`: how a user would actually type the request. The skill must be
 *   in the scorer's top 3 for every one of them.
 * - `negatives`: prompts that belong to a NEIGHBOUR, each naming the `owner`
 *   that must rank strictly above this skill. A skill that quietly widens its
 *   description until it swallows its sibling's queries fails here, and that is
 *   the failure the description work in this flow can cause.
 *
 * The prompts are written in a user's words, not copied out of the trigger
 * lists, because a corpus made of trigger phrases only asserts that string
 * equality works. `routing-corpus.test.ts` enforces that directly: every skill
 * needs at least TWO positives that contain none of its own triggers verbatim
 * — one paraphrase proves the router survives a single rewrite, two prove the
 * skill was not just patched until one lucky sentence got through — and a
 * positive that is EXACTLY a trigger phrase is refused unless it is one of the
 * queries AC7 names by hand (`AC7_REQUIRED_QUERIES` below).
 *
 * Rank-1 accuracy over the positives is a ratchet, but not a single float
 * anyone can edit back down: `RANK1_FIRST` and `RANK1_TOTAL` are the two raw
 * integers of the last measurement, and `routing-corpus.test.ts` re-measures
 * both on every run and requires EQUALITY with what is recorded here — not
 * "at least". A regression makes the measured `first` come in below
 * `RANK1_FIRST` and the test fails, same as before. An IMPROVEMENT now also
 * fails it, on purpose: measured `first` above the recorded number means the
 * record is stale and has to be raised by hand, so "make it pass" and "make it
 * honest" are the same edit. `RANK1_TOTAL` is pinned the same way against the
 * corpus's own live positive count, so growing the corpus without updating the
 * pair fails too — the numbers cannot drift out of sync with what they claim
 * to measure. A human-readable accuracy is derived from the pair, never pinned
 * on its own (see `RANK1_ACCURACY` below).
 */

export interface RoutingNegative {
  /** A prompt this skill must NOT win. */
  readonly prompt: string;
  /** The skill that must rank strictly above this one for that prompt. */
  readonly owner: string;
}

export interface RoutingCase {
  readonly skill: string;
  readonly positives: readonly string[];
  readonly negatives: readonly RoutingNegative[];
}

/**
 * Queries AC7 names verbatim, which are therefore allowed to be exactly a
 * trigger phrase.
 *
 * Every other positive has to be phrased as a user would, so that the corpus
 * measures routing rather than string equality. These are the exception because
 * the criterion pins the literal query text: the point of "write tests" is that
 * a user types those two words and nothing else, and the ambiguity with
 * tests-creator is what is being asserted.
 */
export const AC7_REQUIRED_QUERIES: readonly string[] = [
  "clarify requirements",
  "write tests",
  "generate tests",
  "create tests first",
  "review my code",
  "full review",
  "implement this issue",
  "check performance",
  "why is it slow",
];

/**
 * A pair of skills that genuinely overlap on a prompt a user would really type.
 *
 * Two severities live here, and `excluded` is the difference.
 *
 * `excluded: true` is a case the router cannot satisfy AT ALL — the skill falls
 * out of the top 3, or the negative's owner cannot be made to outrank it. Those
 * are excluded from their assertion and from the rank-1 denominator, and they
 * are never excluded by softening the prompt: the prompt stays as a user would
 * type it and the collision is written down instead. A test asserts an excluded
 * case still fails, so an exclusion cannot outlive the collision that earned it.
 *
 * `excluded: false` is a case that PASSES its assertion — the skill is top-3 —
 * but loses rank 1 to a neighbour. It stays in the denominator and is the reason
 * accuracy is not 1.0. Nothing has to be done to this file when one is fixed;
 * accuracy simply rises and `RANK1_FIRST` can be raised with it.
 *
 * The routing-collision work in this flow consumes both lists. An empty list is
 * the goal, not a defect.
 */
export interface RoutingGap {
  readonly prompt: string;
  /** The skill the corpus says should win. */
  readonly skill: string;
  /** The skill that wins instead. */
  readonly collidesWith: string;
  readonly kind: "positive" | "negative";
  /** True only when the case cannot meet its assertion and is skipped. */
  readonly excluded: boolean;
  readonly reason: string;
}

export const KNOWN_ROUTING_GAPS: readonly RoutingGap[] = [
  // The five gaps T10 recorded alongside these two were all metadata defects —
  // a trigger written in jargon the user does not type, or a description that
  // named the neighbour's vocabulary and not its own — and T12 fixed them in
  // the skills' own frontmatter. What is left is the other kind: two prompts
  // where the losing skill's CEILING is below the winner's FLOOR, so no wording
  // of the loser can take rank 1 back. Both are written as arithmetic rather
  // than as a complaint, because the arithmetic is what a later reader has to
  // re-check before deciding the gap is gone.
  //
  // T10 named review-orchestrator's one-word `review` trigger as the shared root
  // of two of the seven, and the obvious repair — narrow it to the phrases the
  // skill already carries ("review my code", "full review", "review PR") — was
  // measured and rejected. Dropping it costs three `ok` entries in
  // ROUTING_BASELINE their top skill ("review" and "do a review" fall from
  // review-orchestrator at 65 to code-ai-review at 10; "reviewing the diff now"
  // falls to perf-check at 20) and takes review-orchestrator's own positive
  // "reviewing the diff now, where are the problems" away from it. A skill whose
  // contract is to take the review request that names no specialist has to fire
  // on the bare word. The clean-code half was fixed from the other side instead:
  // review-clean-code now carries the complaint a user actually types
  // ("functions do too much" — order-free, so it fires on the prompt without
  // being quoted by it) and wins that prompt 95 to 65, with the orchestrator's
  // trigger untouched.
  {
    prompt: "add a description to the PR and open a linked issue",
    skill: "pr-issue-documenter",
    collidesWith: "pr",
    kind: "positive",
    excluded: false,
    reason:
      "Arithmetically out of reach, not merely unfixed. `pr` cannot score below 105 here: its `open PR` trigger fires order-free on a sentence whose `open` governs the ISSUE (55), the query says `pr` so the skill-name bonus is earned (30), and `open` plus `issue` are both in its haystack for good — `issue` because its NOT-for clause names `pr-issue-documenter`, which the anatomy rules require it to keep. pr-issue-documenter has no name hit available and the query offers five tokens in all, so its ceiling is 55 + 50 = 105 — a tie, which the alphabetical tie-break gives to `pr`. Closing it means changing the order-free trigger path, which is the scorer, not the metadata.",
  },
  {
    prompt: "make a reviewer out of this conventions doc so review-orchestrator can dispatch it",
    skill: "reviewer-skill-creator",
    collidesWith: "review-orchestrator",
    kind: "positive",
    excluded: false,
    reason:
      "Same shape, wider margin: 135 against 50. The user NAMES review-orchestrator, so the orchestrator collects its one-word `review` trigger (55), a verbatim skill-name hit (30) and five of the query's six tokens (50) — and it earns all three honestly, because the sentence really is about it. reviewer-skill-creator's ceiling is a trigger plus all six tokens, 115, so even a perfect trigger leaves it 20 short. Asking to BUILD a reviewer that plugs into the orchestrator is not asking to RUN one, and nothing in the scorer can see the difference between naming a skill and requesting it.",
  },
];

/**
 * Count of positives whose skill ranks FIRST, not merely top-3.
 *
 * Top-3 is what each case asserts, because an agent reading `keryx skills route`
 * sees a short list and picks from it. Rank-1 is the quality signal underneath:
 * it can degrade a long way without any individual case failing, which is
 * exactly the drift a description edit causes.
 *
 * This used to be a single float, `RANK1_BASELINE`, checked with
 * `accuracy >= RANK1_BASELINE`. That shape has a hole: the constant is not
 * derived from anything the test can check independently, so lowering it is
 * indistinguishable from a real drop in the denominator or an honest
 * improvement — a reviewer once set it to 0.6 by hand and nothing failed,
 * because 237/239 still clears 0.6 by a wide margin. A ratchet that can be
 * loosened by editing one number to any smaller number in range is not a
 * ratchet.
 *
 * `RANK1_FIRST` and `RANK1_TOTAL` replace it with the two raw integers of the
 * last measurement instead of their quotient. `routing-corpus.test.ts`
 * re-measures both live and requires:
 *
 * - `RANK1_TOTAL` to equal the corpus's own current count of counted
 *   positives (every positive, minus any `KNOWN_ROUTING_GAPS` exclusion) —
 *   so the denominator cannot go stale relative to the corpus that produces
 *   it, in either direction.
 * - the measured first-place count to equal `RANK1_FIRST` exactly, not
 *   `>=`. A regression (`measured < RANK1_FIRST`) fails it, same as the old
 *   floor did. An IMPROVEMENT (`measured > RANK1_FIRST`) fails it too, on
 *   purpose: the only way to make the suite pass again is to raise
 *   `RANK1_FIRST` to the new measured count, in a diff that says so. Lowering
 *   either integer without a matching real change to the corpus or the
 *   scorer produces a mismatch against the live measurement and fails
 *   immediately — there is no smaller number that passes on its own the way
 *   0.6 did.
 *
 * Measured at 305 of 307 positives. The chain from 285/287 is four skills, all
 * flow 258, each contributing five positives that rank their own skill first,
 * so numerator and denominator rose together every time: 285/287 + `root-cause`
 * = 290/292, + `fresh-eyes` = 295/297, + `api-truth` = 300/302, +
 * `deprecation-path` = 305/307. 285/287 itself was up from 237/239 (0.9916)
 * after T21 added a second non-quoting paraphrase to the 48 skills that had
 * exactly one (AC7/non-vacuity work below).
 *
 * The two losses have not moved through any of it: they are top-3 and written
 * down in KNOWN_ROUTING_GAPS with the arithmetic that puts them out of reach,
 * so the shortfall is named rather than averaged away. One movement that was
 * NOT a new positive did appear while `deprecation-path` was being measured and
 * was closed rather than recorded: a draft of its catalog text carried the
 * words "about" and "over", which put it level with `review-highload` at 20 on
 * *that* skill's own paraphrase and took it on the alphabetical tie-break. The
 * two words were removed from the description and the workflow. A skill winning
 * a query on `d` < `r` is not routing, and the pair must never absorb one.
 *
 * Raise `RANK1_FIRST` (and `RANK1_TOTAL` if the corpus grew) when routing
 * improves; never lower either without saying which cases regressed.
 */
export const RANK1_FIRST = 305;
export const RANK1_TOTAL = 307;

/**
 * Human-readable form of the ratchet above, derived rather than pinned
 * separately — there is exactly one place the two integers are allowed to
 * live, and this is not it.
 */
export const RANK1_ACCURACY = RANK1_FIRST / RANK1_TOTAL;

export const ROUTING_CORPUS: readonly RoutingCase[] = [
  // ---------------------------------------------------------------- core
  {
    skill: "metaproject-router",
    positives: [
      "no idea which skill should be used for this, route it",
      "this is an ordinary product-development request, where does it go",
      "pick the metaproject module that owns this before we start work",
      "just route this to whichever agent should decide on tools and context here",
    ],
    negatives: [
      { prompt: "what should I inspect first to understand this code", owner: "context-router" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "context-router",
    positives: [
      "I need to find the files behind the auth store",
      "what should I inspect first to understand this code",
      "the module is settled, now do I reach for gdgraph or gdwiki",
    ],
    negatives: [
      { prompt: "no idea which skill should be used for this, route it", owner: "metaproject-router" },
      { prompt: "load the project skill for the kanban store before touching it", owner: "entity-skill-router" },
    ],
  },
  {
    skill: "entity-skill-router",
    positives: [
      "load the project skill for the kanban store before touching it",
      "is there already a skill describing this component pattern",
      "we keep module-specific work notes for this service, open them",
      "we already have a skill written for this component, load it instead of grepping",
      "before we write new code, check if a skill already exists for this project or some past work specific to this module",
    ],
    negatives: [
      { prompt: "create skill for src/core/flow", owner: "entity-skill-creator" },
      { prompt: "is this project skill stale or still fresh", owner: "entity-skill-verifier" },
    ],
  },
  {
    skill: "entity-skill-creator",
    positives: [
      "create skill for src/core/flow",
      "создай скил для стора канбана",
      "there is no skill for this service yet, generate a project skill",
      "there's no entity skill of any kind for this brand new module yet, can you generate one for it",
    ],
    negatives: [
      { prompt: "load the project skill for the kanban store before touching it", owner: "entity-skill-router" },
      { prompt: "create a reviewer from our team's review profile", owner: "reviewer-skill-creator" },
    ],
  },
  {
    skill: "reviewer-skill-creator",
    positives: [
      "create a reviewer from our team's review profile",
      "создай ревьюера на основании этого mdc файла",
      "make a reviewer out of this conventions doc so review-orchestrator can dispatch it",
      "we should create a profile so a reviewer for the review pipeline can be generated from this doc",
    ],
    negatives: [
      { prompt: "create skill for src/core/flow", owner: "entity-skill-creator" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "entity-skill-verifier",
    positives: [
      "verify skill for the auth module against the current code",
      "is this project skill stale or still fresh",
      "does this skill still match the code, or has it gone stale",
    ],
    negatives: [
      { prompt: "the review found something, update the skill for that store", owner: "entity-skill-learner" },
      { prompt: "run lint and the tests and the type-check before I call this done", owner: "code-verifier" },
    ],
  },
  {
    skill: "entity-skill-learner",
    positives: [
      "learn from the review findings and update the skill",
      "the review found something, update the skill for that store",
      "a test failure showed this skill is out of date, fold the lesson in",
    ],
    negatives: [
      { prompt: "is this project skill stale or still fresh", owner: "entity-skill-verifier" },
      { prompt: "create skill for src/core/flow", owner: "entity-skill-creator" },
    ],
  },

  // -------------------------------------------------------- orchestration
  {
    skill: "job-orchestrator",
    positives: [
      "implement this issue",
      "take issue 42 from analysis all the way to a PR",
      "run the whole pipeline on this ticket without me babysitting it",
    ],
    negatives: [
      { prompt: "создай фло на эту задачу", owner: "flow-orchestrator" },
      { prompt: "implement task 3 from the breakdown", owner: "task-implementer" },
    ],
  },
  {
    skill: "flow-orchestrator",
    positives: [
      "создай фло на эту задачу",
      "create flow for this feature and drive it to completion",
      "заведи стори и веди её через task manager",
      "implement this with the flow, from init to completion",
      "let's get this ticket moving through task manager from start to finish, fully driven",
    ],
    negatives: [
      { prompt: "implement this issue", owner: "job-orchestrator" },
      { prompt: "implement task 3 from the breakdown", owner: "task-implementer" },
    ],
  },
  {
    skill: "job-documenter",
    positives: [
      "initialize the job folder for this work",
      "save the job report into jobs/",
      "put the findings for this job into its folder as a document",
    ],
    negatives: [
      { prompt: "add a description to the PR and open a linked issue", owner: "pr-issue-documenter" },
      { prompt: "document this codebase", owner: "autodoc-orchestrator" },
    ],
  },
  {
    skill: "context-collector",
    positives: [
      "gather the context for this job before the subagents start",
      "refresh the context document with the library docs",
      "collect the docs and references the workers will need",
    ],
    negatives: [
      { prompt: "the module is settled, now do I reach for gdgraph or gdwiki", owner: "context-router" },
      { prompt: "initialize the job folder for this work", owner: "job-documenter" },
    ],
  },
  {
    skill: "task-implementer",
    positives: [
      "implement task 3 from the breakdown",
      "execute this atomic task json",
      "code up this one decomposed task end to end",
      "there's one task from this issue still left to implement, just that piece",
    ],
    negatives: [
      { prompt: "implement this issue", owner: "job-orchestrator" },
      { prompt: "создай фло на эту задачу", owner: "flow-orchestrator" },
    ],
  },
  {
    skill: "code-verifier",
    positives: [
      "run lint and the tests and the type-check before I call this done",
      "quality gate this implementation",
      "does the code quality check still pass after these edits",
    ],
    negatives: [
      { prompt: "verify skill for the auth module against the current code", owner: "entity-skill-verifier" },
      { prompt: "check these findings before they get reported", owner: "review-verifier" },
    ],
  },
  {
    skill: "issue-analyzer",
    positives: [
      "break down issue 42 into atomic tasks",
      "analyze the issue and turn it into tasks",
      "decompose this issue into pieces one agent can do at a time",
    ],
    negatives: [
      { prompt: "implement this issue", owner: "job-orchestrator" },
      { prompt: "analyze the changes on this feature branch across both repos", owner: "feature-analyzer" },
    ],
  },
  {
    skill: "feature-analyzer",
    positives: [
      "analyze the changes on this feature branch across both repos",
      "study the module and the backend to frontend contract",
      "investigate what this branch actually changed before we port it",
    ],
    negatives: [
      { prompt: "break down issue 42 into atomic tasks", owner: "issue-analyzer" },
      { prompt: "does this change break anything else", owner: "review-regression" },
    ],
  },
  {
    skill: "feature-dev",
    positives: [
      "build this feature from scratch up to a merge-ready PR",
      "develop the feature described in this issue end to end",
      "take me through the guided feature workflow for this idea",
      "spin up something brand new for this idea and carry it all the way to a pr I can merge",
    ],
    negatives: [
      { prompt: "implement this issue", owner: "job-orchestrator" },
      { prompt: "implement task 3 from the breakdown", owner: "task-implementer" },
    ],
  },

  // --------------------------------------------------------------- review
  {
    skill: "review-orchestrator",
    positives: [
      "review my code",
      "full review",
      "сделай мне полное ревью перед мержем",
      "reviewing the diff now, where are the problems",
      "give this whole diff a look and call out anything that needs reviewing before merge",
    ],
    negatives: [
      { prompt: "frontend review of these components", owner: "review-frontend" },
      { prompt: "security review of the auth changes", owner: "review-security-code" },
    ],
  },
  {
    skill: "review-logic",
    positives: [
      "are there any bugs in this function",
      "check this for correctness, the async handling looks off",
      "review the logic here, the retry path looks off",
      "can you check whether this function actually has bugs, or if it's just fine for now",
    ],
    negatives: [
      { prompt: "security review of the auth changes", owner: "review-security-code" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-architecture",
    positives: [
      "architecture review of this module",
      "check the layering, the service reaches into the controller",
      "check that the layers and module boundaries still hold",
      "can you check whether the architecture layers are being crossed here, the service seems to reach straight into the database code",
    ],
    negatives: [
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "review core boundaries in src/core", owner: "review-core-boundaries" },
    ],
  },
  {
    skill: "review-security-code",
    positives: [
      "security review of the auth changes",
      "проверь безопасность этого кода",
      "check this diff for vulnerabilities, injection or auth bypass",
      "could someone find a way to break in, are there vulnerabilities we should check for in this auth flow",
    ],
    negatives: [
      { prompt: "audit our dependencies for known CVEs", owner: "security-audit" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-performance",
    positives: [
      "performance review of this diff",
      "check for N+1 queries in the changed services",
      "perf review of the changed components, any needless re-renders",
      "these queries seem to be getting slower every time we add more data, what's dragging it down",
    ],
    negatives: [
      { prompt: "check performance", owner: "perf-check" },
      { prompt: "why is it slow", owner: "perf-check" },
    ],
  },
  {
    skill: "review-frontend",
    positives: [
      "frontend review of these components",
      "review the React components I changed",
      "review my changed components for React pattern problems",
    ],
    negatives: [
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "mobx store review of these actions and reactions", owner: "code-mobx-store-review" },
    ],
  },
  {
    skill: "review-backend",
    positives: [
      "backend review of the new endpoints",
      "review the NestJS service and its DTOs",
      "review the api design and the validation on these endpoints",
    ],
    negatives: [
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "frontend review of these components", owner: "review-frontend" },
    ],
  },
  {
    skill: "review-clean-code",
    positives: [
      "clean code review of this class",
      "check this against clean code and SOLID at the function level",
      "these functions are too long and do too much, review that",
    ],
    negatives: [
      { prompt: "style review, naming and readability only", owner: "review-style" },
      { prompt: "architecture review of this module", owner: "review-architecture" },
    ],
  },
  {
    skill: "review-highload",
    positives: [
      "highload review before we turn on traffic",
      "is there a race condition in this handler",
      "review this for concurrency, the connection pool worries me",
      "we're about to get hammered with traffic, will this handler hold up or fall over",
    ],
    negatives: [
      { prompt: "performance review of this diff", owner: "review-performance" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-regression",
    positives: [
      "does this change break anything else",
      "what is the blast radius of this refactor",
      "review the regression risk in the code this touches",
      "will this change break anything else downstream, or does it stay completely contained",
    ],
    negatives: [
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "are there any bugs in this function", owner: "review-logic" },
    ],
  },
  {
    skill: "review-core-boundaries",
    positives: [
      "review core boundaries in src/core",
      "is the public surface of this shared module still stable",
      "review the core module boundaries, a feature is leaking into src/core",
      "this feature is reaching into shared code it probably shouldn't touch, can you check the exposure",
    ],
    negatives: [
      { prompt: "architecture review of this module", owner: "review-architecture" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-flow-graph",
    positives: [
      "reactflow review of the new graph surface",
      "flow graph review of the layout lifecycle",
      "review the graph ui store subclassing",
      "check whether the new store subclass breaks the generic graph abstraction we built",
    ],
    negatives: [
      { prompt: "check performance", owner: "perf-check" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-layout",
    positives: [
      "layout review of this grid",
      "does this render correctly with longer German text",
      "review the layout, the flex container overflows on narrow screens",
      "on tablets this thing does not render correctly at all, boxes overlap everywhere",
    ],
    negatives: [
      { prompt: "frontend review of these components", owner: "review-frontend" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-style",
    positives: [
      "style review, naming and readability only",
      "check the naming in this file",
      "check this for readability and nothing that changes behaviour",
      "can you clean this up and make the naming easier to check at a glance",
    ],
    negatives: [
      { prompt: "clean code review of this class", owner: "review-clean-code" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-testing-practices",
    positives: [
      "review the tests I added against our testing practices",
      "check the quality of this test coverage",
      "review testing practices in these e2e specs, the waits look flaky",
      "our testing setup has decent coverage but the practices around waits and quality feel inconsistent in these specs",
    ],
    negatives: [
      { prompt: "write tests", owner: "test-gen" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-verifier",
    positives: [
      "check these findings before they get reported",
      "run a verification pass over the consolidated findings",
      "verify the findings and drop the ones that cannot be reproduced",
      "can we run a pass over these findings and verify none of them are wrong before we check in",
    ],
    negatives: [
      { prompt: "run lint and the tests and the type-check before I call this done", owner: "code-verifier" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-frontend-conventions",
    positives: [
      "review frontend conventions against our CLAUDE.md",
      "check this against our local frontend rules",
      "do these components follow the conventions our frontend guide lays out",
      "these widgets might be breaking some of our frontend team's own conventions, can you check them against what's written down",
    ],
    negatives: [
      { prompt: "frontend review of these components", owner: "review-frontend" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "review-pr-feedback",
    positives: [
      "what did reviewers say on my PR",
      "go through the PR comments and explain each one",
      "address the review comments on my pull request",
      "can you go through my pr and explain what these comments actually mean",
    ],
    negatives: [
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "add a description to the PR and open a linked issue", owner: "pr-issue-documenter" },
    ],
  },
  {
    skill: "code-ai-review",
    positives: [
      "run code-ai-review on this branch",
      "do a strict AI review with the ai assistant profile",
      "use the code review ai assistant profile on this branch",
      "run a strict pass, ai baseline style, and go through this branch before any human review happens",
    ],
    negatives: [
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "review with our conventions learned from past PRs", owner: "code-learned-review" },
    ],
  },
  {
    skill: "code-learned-review",
    positives: [
      "review with our conventions learned from past PRs",
      "review using what we learned from our own PR comments",
      "review this branch with the conventions our PRs taught us",
      "our own pull request history taught us some conventions, can you review this branch against everything we've learned from that",
    ],
    negatives: [
      { prompt: "run code-ai-review on this branch", owner: "code-ai-review" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },
  {
    skill: "code-style-review",
    positives: [
      "run code-style-review on my branch",
      "check the architecture style with the code-style-patterns profile",
      "use the legacy style and architecture profile on this branch",
      "run the older architecture and style checks we still keep around for legacy branches",
    ],
    negatives: [
      { prompt: "style review, naming and readability only", owner: "review-style" },
      { prompt: "architecture review of this module", owner: "review-architecture" },
    ],
  },
  {
    skill: "code-mobx-store-review",
    positives: [
      "review the mobx store",
      "mobx store review of these actions and reactions",
      "this store needs a review, the async runInAction looks wrong",
    ],
    negatives: [
      { prompt: "frontend review of these components", owner: "review-frontend" },
      { prompt: "review my code", owner: "review-orchestrator" },
    ],
  },

  // -------------------------------------------------------------- quality
  {
    skill: "security-audit",
    positives: [
      "do a security audit of this repo",
      "check for CVEs in our dependencies",
      "scan the repo for committed secrets",
      "can you look for known cves in our dependencies and make sure this whole repo passes an audit",
    ],
    negatives: [
      { prompt: "security review of the auth changes", owner: "review-security-code" },
      { prompt: "upgrade our packages to the latest versions", owner: "dependency-update" },
    ],
  },
  {
    skill: "metaproject-security",
    positives: [
      "run PII redaction over this wiki page before it is saved",
      "is there prompt injection risk in this external content",
      "look at this memory entry and check it for secrets",
      "before this goes into memory, make sure nothing hidden in it could exfiltrate data or leave secrets we forgot to check for",
    ],
    negatives: [
      { prompt: "security audit", owner: "security-audit" },
      { prompt: "security review of the auth changes", owner: "review-security-code" },
    ],
  },
  {
    skill: "perf-check",
    positives: [
      "check performance",
      "why is it slow",
      "the page takes forever, why is it so slow",
      "our js bundle keeps growing and this component feels way too complex, can you look at the size of it",
    ],
    negatives: [
      { prompt: "performance review of this diff", owner: "review-performance" },
      { prompt: "highload review before we turn on traffic", owner: "review-highload" },
    ],
  },
  {
    skill: "root-cause",
    positives: [
      "find the root cause of the login redirect loop",
      // The hazard proof for this skill's own NOT-for clause. The clause
      // excludes "a defect already pinned to a line and a mechanism" without
      // naming a neighbour, so the exclusion costs it no queries: a user
      // repeating that wording back — the trace pinned a line and the line is
      // innocent — is still asking for exactly this skill, and still gets it.
      "the stack trace pins it to a line but that line looks fine, where does this actually go wrong",
      "this test fails on CI but passes on my machine and I cannot figure out why",
      "I cannot reproduce the bug the customer reported, what now",
      "the app crashes when a user saves and nobody knows what produces it",
    ],
    negatives: [
      // Nothing is broken in any of the three: the first measures, the second
      // judges a change against code it might break, the third runs the gates.
      { prompt: "why is it slow", owner: "perf-check" },
      { prompt: "does this change break anything", owner: "review-regression" },
      { prompt: "run lint and the tests and the type-check before I call this done", owner: "code-verifier" },
    ],
  },
  {
    skill: "fresh-eyes",
    positives: [
      "I have been staring at this migration too long, can someone who has not heard my reasoning say where it breaks",
      "give this design to somebody who knows nothing about why I built it and ask what is wrong",
      // The two hazard proofs for this skill's own NOT-for clause. It excludes
      // its neighbours by DESCRIBING them — "judging a finished diff against a
      // rubric", "re-testing a finding somebody has already written down" —
      // rather than by naming their owners, because a name in a description is
      // a name in the query the user echoes back, and the scorer pays +30 for
      // it. Both `KNOWN_ROUTING_GAPS` above are that mechanism. So the
      // exclusion has to cost this skill nothing: a user quoting the excluded
      // wording back is still asking for this skill, and still gets it, 50
      // against 40 and 90 against 30.
      "I am halfway through this and I want it doubted before I call it done, not a rubric check on a finished diff",
      "this artifact is still in flight — have somebody doubt it now, not re-test a finding somebody already wrote down",
      "poke holes in this before I finish",
    ],
    negatives: [
      // The three neighbours, each asked for in a user's own words. The first
      // re-tests findings that already exist; the second takes the review
      // request that names no specialist; the third owns a defect nobody can
      // yet explain. None of them reads an artifact with its author's account
      // withheld, which is the only thing this skill does.
      { prompt: "check these findings", owner: "review-verifier" },
      { prompt: "review my code", owner: "review-orchestrator" },
      { prompt: "the app crashes when a user saves and nobody knows what produces it", owner: "root-cause" },
    ],
  },
  {
    skill: "api-truth",
    positives: [
      "is that still the API in the version we actually have installed",
      "you wrote that method call from memory — go and read what our copy of the library actually exposes",
      "before you write this client call, read the option names out of the package on disk instead of guessing them",
      // The two hazard proofs for this skill's own NOT-for clause. It excludes
      // its neighbours by DESCRIBING them — "moving a project onto newer
      // releases", "picking which library or pattern to adopt" — rather than by
      // naming their owners, because a name in a description is a name in the
      // query the user echoes back and the scorer pays +30 for it. So the
      // exclusion has to cost this skill nothing: a user quoting the excluded
      // wording back is still asking for this skill, and still gets it, 90
      // against 65 and 80 against 40.
      "do not move us onto newer releases of anything — just confirm this call matches the version we already have",
      "we already picked the library and installed it, so no pattern shopping — check my call against what got installed",
    ],
    negatives: [
      // The two neighbours, each asked for in a user's own words. The first
      // changes which versions the project is on; the second chooses patterns
      // for a stack before any call exists. Neither reads the build on disk to
      // settle a signature, which is the only thing this skill does.
      { prompt: "upgrade our packages to the latest versions", owner: "dependency-update" },
      { prompt: "which architecture patterns fit the stack we chose", owner: "patterns-researcher" },
    ],
  },
  {
    skill: "deprecation-path",
    positives: [
      "we are renaming a command our CLI publishes and other teams still have the old spelling in their scripts",
      "what has to be true before we can delete the old option name",
      "how do we sunset this option without breaking callers",
      // The two hazard proofs for this skill's own NOT-for clause. It excludes
      // its neighbours by DESCRIBING them — "moving a project onto newer
      // releases of packages somebody else publishes", "reshaping data already
      // stored in a database" — rather than by naming their owners, because a
      // name in a description is a name in the query the user echoes back and
      // the scorer pays +30 for it. So the exclusion has to cost this skill
      // nothing: a user quoting the excluded wording back is still asking for
      // this skill, and still gets it.
      "we are not moving onto newer releases of anyone else's packages — this is a flag we publish that has to go away",
      "nothing to do with reshaping data already stored in a database — this is a config key we ship that other teams still set",
    ],
    negatives: [
      // The two neighbours, each asked for in a user's own words. The first
      // consumes somebody else's change; the second changes the shape of stored
      // data. Neither walks a spelling this project published out of its own
      // surface, which is the only thing this skill does.
      { prompt: "upgrade our packages to the latest versions", owner: "dependency-update" },
      { prompt: "create and apply a database migration for the new column", owner: "db-migrate" },
    ],
  },
  {
    skill: "test-gen",
    positives: [
      "write tests",
      "generate tests",
      "write tests for the parser module",
      "can you add a couple of tests for this helper",
      "this helper has zero coverage right now, can we add a few tests to cover it properly",
    ],
    negatives: [
      { prompt: "create tests first", owner: "tests-creator" },
      { prompt: "review the tests I added against our testing practices", owner: "review-testing-practices" },
    ],
  },
  {
    skill: "tests-creator",
    positives: [
      "create tests first",
      "write the tests before the implementation, TDD style",
      "we are doing TDD, give me failing test scenarios from the criteria",
      "write the failing tests before any implementation exists",
      "before writing any code, convert the acceptance criteria into tests that are meant to fail at first",
    ],
    negatives: [
      { prompt: "write tests", owner: "test-gen" },
      { prompt: "generate tests", owner: "test-gen" },
    ],
  },
  {
    skill: "dependency-update",
    positives: [
      "upgrade our packages to the latest versions",
      "check outdated deps and bump them",
      "these libraries are ancient, update the dependencies and run the tests",
    ],
    negatives: [
      { prompt: "audit our dependencies for known CVEs", owner: "security-audit" },
      { prompt: "create a migration for the new column", owner: "db-migrate" },
    ],
  },
  {
    skill: "db-migrate",
    positives: [
      "create a migration for the new column",
      "roll back the last database migration",
      "I need a new migration for the database schema change",
    ],
    negatives: [
      { prompt: "upgrade our packages to the latest versions", owner: "dependency-update" },
      { prompt: "deploy to staging", owner: "deploy" },
    ],
  },
  {
    skill: "deploy",
    positives: [
      "deploy to staging",
      "run the deployment",
      "let's push this to production tonight",
      "let's get this build out and live for everyone, deploying it to production tonight",
    ],
    negatives: [
      { prompt: "push branch to the remote with upstream tracking", owner: "push" },
      { prompt: "generate the release notes for this version", owner: "changelog" },
    ],
  },
  {
    skill: "push",
    positives: [
      "push branch to the remote with upstream tracking",
      "git push this branch",
      "push my changes to the remote branch",
      "can you get my local commits onto the branch that lives on the remote, then push it up with git",
    ],
    negatives: [
      { prompt: "deploy to staging", owner: "deploy" },
      { prompt: "open a PR", owner: "pr" },
    ],
  },
  {
    skill: "pr",
    positives: [
      "open a PR",
      "create pull request for this branch",
      "make a draft PR please",
      "let's create a pull request from this branch so people can look at the diff, then open it when everything's ready",
    ],
    negatives: [
      { prompt: "push branch to the remote with upstream tracking", owner: "push" },
      { prompt: "what did reviewers say on my PR", owner: "review-pr-feedback" },
    ],
  },
  {
    skill: "pr-issue-documenter",
    positives: [
      "add a description to the PR and open a linked issue",
      "write the PR summary of what was done",
      "fill in the PR description, it is empty",
    ],
    negatives: [
      { prompt: "open a PR", owner: "pr" },
      { prompt: "what did reviewers say on my PR", owner: "review-pr-feedback" },
    ],
  },
  {
    skill: "changelog",
    positives: [
      "generate the release notes for this version",
      "what changed since v1.2.0",
      "what has changed between these two tags",
      "can you tell me what actually changed going from the old version to this new release",
    ],
    negatives: [
      { prompt: "deploy to staging", owner: "deploy" },
      { prompt: "write the PR summary of what was done", owner: "pr-issue-documenter" },
    ],
  },

  // ------------------------------------------------------------- planning
  {
    skill: "brainstorm",
    positives: [
      "brainstorming ideas for the caching layer",
      "what are the options for storing this",
      "how should we approach the migration, compare a couple of approaches",
    ],
    negatives: [
      { prompt: "architecture review of this module", owner: "review-architecture" },
      { prompt: "clarify requirements", owner: "interviewer" },
    ],
  },
  {
    skill: "interviewer",
    positives: [
      "clarify requirements",
      "ask me questions first, the request is vague",
      "gather the requirements from me before any context work",
      "before interviewing me any further, gather what you actually need and pin down the requirements first",
    ],
    negatives: [
      { prompt: "clarify the implementation details now that we have the context", owner: "interview" },
      { prompt: "create PRD for this feature", owner: "prd-creator" },
    ],
  },
  {
    skill: "interview",
    positives: [
      "clarify the implementation details now that we have the context",
      "run the implementation interview before I code this",
      "interview me about the implementation specifics, the goal is known",
    ],
    negatives: [
      { prompt: "clarify requirements", owner: "interviewer" },
      { prompt: "ask me questions first, the request is vague", owner: "interviewer" },
    ],
  },
  {
    skill: "prd-creator",
    positives: [
      "create PRD for this feature",
      "write a product requirements document for the billing module",
      "formulate the requirements for this feature properly",
      "we need to properly formulate a document that spells out this product's requirements for the new feature, right from the start",
    ],
    negatives: [
      { prompt: "clarify requirements", owner: "interviewer" },
      { prompt: "write the implementation plan from the PRD", owner: "spec-writer" },
    ],
  },
  {
    skill: "project-discovery",
    positives: [
      "run project discovery for this new project",
      "do the initial analysis of what we know so far",
      "discover what this project is from the sources we have",
      "let's take an initial look and figure out everything we can discover about this project from what's available, basically an analysis of where things stand",
    ],
    negatives: [
      { prompt: "define the problem and the non-goals", owner: "problem-definer" },
      { prompt: "create PRD for this feature", owner: "prd-creator" },
    ],
  },
  {
    skill: "problem-definer",
    positives: [
      "define the problem and the non-goals",
      "what are the success metrics for this",
      "write the goals and non goals section",
    ],
    negatives: [
      { prompt: "run project discovery for this new project", owner: "project-discovery" },
      { prompt: "create PRD for this feature", owner: "prd-creator" },
    ],
  },
  {
    skill: "stack-advisor",
    positives: [
      "help me choose the stack for an MVP",
      "I need stack advice for a production service",
      "which technology choice makes sense here, postgres or mongo",
      "torn between two technology options for the stack here, what advice would help us choose",
    ],
    negatives: [
      { prompt: "research the architecture patterns for this stack", owner: "patterns-researcher" },
      { prompt: "brainstorming ideas for the caching layer", owner: "brainstorm" },
    ],
  },
  {
    skill: "patterns-researcher",
    positives: [
      "research the architecture patterns for this stack",
      "what are the best practices for NestJS here",
      "look into the patterns we should research before the PRD",
      "before we lock in an architecture, can you dig up common patterns and see what practices actually work best for other teams handling this kind of research",
    ],
    negatives: [
      { prompt: "help me choose the stack for an MVP", owner: "stack-advisor" },
      { prompt: "architecture review of this module", owner: "review-architecture" },
    ],
  },
  {
    skill: "spec-writer",
    positives: [
      "write the implementation plan from the PRD",
      "produce the technical specification for this module",
      "write the spec and the plan for implementation from the PRD",
      "this needs a technical write-up, think specification level detail, plus a plan for how the implementation will actually proceed",
    ],
    negatives: [
      { prompt: "create PRD for this feature", owner: "prd-creator" },
      { prompt: "check the PRD for consistency with the decisions registry", owner: "consistency-checker" },
    ],
  },
  {
    skill: "consistency-checker",
    positives: [
      "check the PRD for consistency with the decisions registry",
      "validate the spec against the architecture doc",
      "find the doc contradictions in this plan",
    ],
    negatives: [
      { prompt: "write the implementation plan from the PRD", owner: "spec-writer" },
      { prompt: "verify the requirements package for completeness", owner: "docpack-review" },
    ],
  },
  {
    skill: "docpack-orchestrator",
    positives: [
      "create requirements package for the billing module",
      "оформи пакет документации по этому модулю",
      "we need a documentation package prepared for implementation",
      "can you put together everything this module's requirements need, package, prd, spec, before implementation starts",
    ],
    negatives: [
      { prompt: "verify the requirements package for completeness", owner: "docpack-review" },
      { prompt: "document this codebase", owner: "autodoc-orchestrator" },
    ],
  },
  {
    skill: "docpack-review",
    positives: [
      "verify the requirements package for completeness",
      "проверь документацию пакета на соответствие",
      "check the PRD and spec for consistency in this package",
    ],
    negatives: [
      { prompt: "create requirements package for the billing module", owner: "docpack-orchestrator" },
      { prompt: "check the PRD for consistency with the decisions registry", owner: "consistency-checker" },
    ],
  },
  {
    skill: "planner",
    positives: [
      "create the roadmap and the milestones from the PRD",
      "give me the task breakdown with dependencies",
      "plan out the milestones we need to create",
      "can you create a plan, plus a breakdown of tasks, so we know what depends on what before we start",
    ],
    negatives: [
      { prompt: "break down issue 42 into atomic tasks", owner: "issue-analyzer" },
      { prompt: "write the implementation plan from the PRD", owner: "spec-writer" },
    ],
  },
  {
    skill: "autodoc-orchestrator",
    positives: [
      "document this codebase for new joiners",
      "сгенерируй документацию проекта по коду",
      "reverse engineer the docs for this repo",
      "this whole codebase has nothing written about it for new people, can you reverse engineer some documentation for it automatically",
    ],
    negatives: [
      { prompt: "create requirements package for the billing module", owner: "docpack-orchestrator" },
      { prompt: "scan the codebase for module boundaries and entry points", owner: "autodoc-scanner" },
    ],
  },
  {
    skill: "autodoc-scanner",
    positives: [
      "scan the codebase for module boundaries and entry points",
      "run the autodoc scan phase",
      "identify the documentation targets and detect the stack",
      "before anything gets written automatically, figure out which targets in the repo actually need documentation, then scan them first",
    ],
    negatives: [
      { prompt: "document this codebase", owner: "autodoc-orchestrator" },
      { prompt: "reverse engineer this module's purpose and public API", owner: "autodoc-analyst" },
    ],
  },
  {
    skill: "autodoc-analyst",
    positives: [
      "reverse engineer this module's purpose and public API",
      "analyze this module for the docs, one module only",
      "autodoc analyst pass over the flow module",
    ],
    negatives: [
      { prompt: "scan the codebase for module boundaries and entry points", owner: "autodoc-scanner" },
      { prompt: "synthesize the module analyses into architecture docs", owner: "autodoc-architect" },
    ],
  },
  {
    skill: "autodoc-architect",
    positives: [
      "synthesize the module analyses into architecture docs",
      "reverse engineer the architecture from these analyses",
      "autodoc architect phase please",
      "once every module has been analyzed separately, pull it all into one architecture picture, basically the docs a system architect would want",
    ],
    negatives: [
      { prompt: "reverse engineer this module's purpose and public API", owner: "autodoc-analyst" },
      { prompt: "architecture review of this module", owner: "review-architecture" },
    ],
  },
  {
    skill: "autodoc-writer",
    positives: [
      "write the docs section for the API from these artifacts",
      "generate the documentation pages for each section",
      "autodoc writer for the getting started section",
    ],
    negatives: [
      { prompt: "assemble the docs into a README and a navigation index", owner: "autodoc-assembler" },
      { prompt: "document this codebase", owner: "autodoc-orchestrator" },
    ],
  },
  {
    skill: "autodoc-assembler",
    positives: [
      "assemble the docs into a README and a navigation index",
      "assemble the documentation package at the end",
      "autodoc assemble step now",
    ],
    negatives: [
      { prompt: "write the docs section for the API from these artifacts", owner: "autodoc-writer" },
      { prompt: "create requirements package for the billing module", owner: "docpack-orchestrator" },
    ],
  },

  // ------------------------------------------------------------- platform
  {
    skill: "agent-entrypoint-manager",
    positives: [
      "refresh the managed block in AGENTS.md",
      "add the metaproject block to CLAUDE.md",
      "the entry point file for agents needs its managed block re-added",
      "the shared md file that both agents and claude read from lost its managed block, can you put it back",
    ],
    negatives: [
      { prompt: "split our huge CLAUDE.md into rules and project skills", owner: "agent-entrypoint-distiller" },
      { prompt: "save these learnings into CLAUDE.md", owner: "claude-md-management" },
    ],
  },
  {
    skill: "agent-entrypoint-distiller",
    positives: [
      "split our huge CLAUDE.md into rules and project skills",
      "разнеси наш CLAUDE.md по правилам",
      "our claude md is enormous, distill it into rules and keep the root small",
    ],
    negatives: [
      { prompt: "refresh the managed block in AGENTS.md", owner: "agent-entrypoint-manager" },
      { prompt: "save these learnings into CLAUDE.md", owner: "claude-md-management" },
    ],
  },
  {
    skill: "hook-manager",
    positives: [
      "install the post-commit git hook for graph rebuilds",
      "install the hook that verifies skills",
      "set up a git hook that runs health after a commit",
      "can you install a hook so git fires something automatically the moment work gets committed",
    ],
    negatives: [
      { prompt: "run lint after every edit, set that up as a hook", owner: "hookify" },
      { prompt: "commit changes", owner: "commit" },
    ],
  },
  {
    skill: "hookify",
    positives: [
      "run lint after every edit, set that up as a hook",
      "notify me when it is done, add a hook for that",
      "hookify this: play a sound on finish",
    ],
    negatives: [
      { prompt: "install the post-commit git hook for graph rebuilds", owner: "hook-manager" },
      { prompt: "run lint and the tests and the type-check before I call this done", owner: "code-verifier" },
    ],
  },
  {
    skill: "claude-md-management",
    positives: [
      "save these learnings into CLAUDE.md",
      "update the project instructions with this convention",
      "add the command we just figured out to CLAUDE.md",
    ],
    negatives: [
      { prompt: "refresh the managed block in AGENTS.md", owner: "agent-entrypoint-manager" },
      { prompt: "split our huge CLAUDE.md into rules and project skills", owner: "agent-entrypoint-distiller" },
    ],
  },
  {
    skill: "skill-catalog-manager",
    positives: [
      "the skill catalog is out of date, regenerate it",
      "list the skills we have",
      "rebuild the machine readable registry of skills",
    ],
    negatives: [
      { prompt: "export this skill for the codex runtime", owner: "skill-runtime-exporter" },
      { prompt: "sync the exported skills into my local runtimes", owner: "skill-sync" },
    ],
  },
  {
    skill: "skill-runtime-exporter",
    positives: [
      "export this skill for the codex runtime",
      "turn the canonical packages into runtime skill artifacts",
      "build the codex skill artifacts, stripped of management files",
      "we need whatever codex uses at runtime, stripped down from the full skill package, ready to export",
    ],
    negatives: [
      { prompt: "sync the exported skills into my local runtimes", owner: "skill-sync" },
      { prompt: "the skill catalog is out of date, regenerate it", owner: "skill-catalog-manager" },
    ],
  },
  {
    skill: "skill-sync",
    positives: [
      "sync the exported skills into my local runtimes",
      "install the runtime skills globally",
      "global skill sync is enabled, push them out",
    ],
    negatives: [
      { prompt: "export this skill for the codex runtime", owner: "skill-runtime-exporter" },
      { prompt: "the skill catalog is out of date, regenerate it", owner: "skill-catalog-manager" },
    ],
  },
  {
    skill: "commit",
    positives: [
      "commit these changes for me",
      "commits are failing, write me a conventional commit message",
      "save these changes with a proper commit message",
    ],
    negatives: [
      { prompt: "push branch to the remote with upstream tracking", owner: "push" },
      { prompt: "install the post-commit git hook for graph rebuilds", owner: "hook-manager" },
    ],
  },
];
