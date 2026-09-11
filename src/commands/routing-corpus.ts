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
 * needs at least one positive that contains none of its own triggers verbatim,
 * and a positive that is EXACTLY a trigger phrase is refused unless it is one of
 * the queries AC7 names by hand (`AC7_REQUIRED_QUERIES` below).
 *
 * Rank-1 accuracy over the positives is checked in against `RANK1_BASELINE`. It
 * is a ratchet, not a target: the test fails when accuracy drops below the
 * recorded number, and the number is raised by hand when routing improves.
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
 * accuracy simply rises and `RANK1_BASELINE` can be raised with it.
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
  {
    prompt: "what is the blast radius of this refactor",
    skill: "review-regression",
    collidesWith: "review-architecture",
    kind: "positive",
    excluded: false,
    reason:
      "review-regression's own trigger is `blast radius review`, and the word `review` is exactly what a user asking about blast radius does not say. No trigger fires, so the skill lands in a three-way tie at 20 with review-architecture and review-core-boundaries and loses it alphabetically. A `blast radius` trigger without the trailing noun would settle it.",
  },
  {
    prompt: "implement task 3 from the breakdown",
    skill: "task-implementer",
    collidesWith: "planner",
    kind: "positive",
    excluded: false,
    reason:
      "planner's `task breakdown` trigger matches order-free, so a request to IMPLEMENT one item out of a breakdown fires the trigger of the skill that PRODUCES breakdowns. Both reach 75 and planner wins the tie alphabetically. planner's trigger wants the two words adjacent, or a stronger `implement task` signal.",
  },
  {
    prompt: "add a description to the PR and open a linked issue",
    skill: "pr-issue-documenter",
    collidesWith: "pr",
    kind: "positive",
    excluded: false,
    reason:
      "`open PR` fires for a sentence whose verb `open` governs the ISSUE, not the PR, and `pr` then adds its skill-name bonus on top: 115 against 95. The user is describing an existing pull request, not asking for a new one.",
  },
  {
    prompt: "set up a git hook that runs health after a commit",
    skill: "hook-manager",
    collidesWith: "commit",
    kind: "positive",
    excluded: false,
    reason:
      "`commit` is a one-word trigger and a one-word skill name, so naming the moment a hook should run (`after a commit`) scores 105 for the commit skill against hook-manager's 95. Any hook phrased by its git event hits this.",
  },
  {
    prompt: "make a reviewer out of this conventions doc so review-orchestrator can dispatch it",
    skill: "reviewer-skill-creator",
    collidesWith: "review-orchestrator",
    kind: "positive",
    excluded: false,
    reason:
      "Naming the orchestrator the new reviewer will plug into hands review-orchestrator an exact-name hit plus its one-word `review` trigger — 135 against 50. Asking to BUILD a reviewer is not asking to RUN one, and the scorer has no way to see the difference.",
  },
  {
    prompt: "these functions are too long and do too much, review that",
    skill: "review-clean-code",
    collidesWith: "review-orchestrator",
    kind: "positive",
    excluded: false,
    reason:
      "A textbook Single Responsibility complaint in a user's own words fires no review-clean-code trigger at all (`clean code review`, `solid review`, `maintainability`, `Uncle Bob review` are all jargon), so the bare word `review` sends it to the orchestrator at 65 against 20.",
  },
  {
    prompt: "pick the metaproject module that owns this before we start work",
    skill: "metaproject-router",
    collidesWith: "context-router",
    kind: "positive",
    excluded: false,
    reason:
      "Deciding WHICH module owns a request is metaproject-router's whole contract, but its triggers all need a literal `skill`, `route context` or `repository task`, so the prompt scores pure token overlap: a 40-point three-way tie with context-router and flow-orchestrator, lost alphabetically.",
  },
];

/**
 * Share of positives whose skill ranks FIRST, not merely top-3.
 *
 * Top-3 is what each case asserts, because an agent reading `keryx skills route`
 * sees a short list and picks from it. Rank-1 is the quality signal underneath:
 * it can degrade a long way without any individual case failing, which is
 * exactly the drift a description edit causes.
 *
 * Measured at 232 of 239 positives, 0.9707. The seven that lose rank 1 are all
 * top-3 and all written down in KNOWN_ROUTING_GAPS with the skill that beats
 * them, so the shortfall is named rather than averaged away. Raise this number
 * when routing improves; never lower it without saying which cases regressed.
 */
export const RANK1_BASELINE = 0.9707;

export const ROUTING_CORPUS: readonly RoutingCase[] = [
  // ---------------------------------------------------------------- core
  {
    skill: "metaproject-router",
    positives: [
      "no idea which skill should be used for this, route it",
      "this is an ordinary product-development request, where does it go",
      "pick the metaproject module that owns this before we start work",
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
    ],
    negatives: [
      { prompt: "performance review of this diff", owner: "review-performance" },
      { prompt: "highload review before we turn on traffic", owner: "review-highload" },
    ],
  },
  {
    skill: "test-gen",
    positives: [
      "write tests",
      "generate tests",
      "write tests for the parser module",
      "can you add a couple of tests for this helper",
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
