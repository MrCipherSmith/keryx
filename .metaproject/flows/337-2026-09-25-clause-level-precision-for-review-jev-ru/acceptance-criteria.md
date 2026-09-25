# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A deterministic pre-classifier (no model call) exists in `src/review/conform-clauses.ts` that tags a clause `process`/not-checkable before any Jev call, matching imperative process verbs addressed to a person or agent (review, discuss, ask, document, communicate, get approval, design ... in, plan, decide) and numbered/fenced "workflow" list steps, proven by a unit test that classifies `.metaproject/rules/api-contracts.mdc`'s "Review the contract for breaking changes" clause as process without any Jev question being built for it.
- AC2: The same pre-classifier leaves a clause stating a property of code (must/never/always + a code noun: function, class, import, export, type, handler, query, test) as a Jev candidate (not force-classified), proven by a unit test asserting such a clause still produces a `buildClauseTagQuestions` entry.
- AC3: The pre-classifier is a small, documented rule set (named regex/term lists with comments explaining each), covered by at least 6 unit tests: 3+ true positives (process) and 3+ true negatives (code-property) beyond the two above.
- AC4: `buildClauseTagQuestions`'s `choice` question instructions are rewritten to explicitly distinguish "a property you can see in a code hunk" from "an action someone performs", verified by a unit test asserting the built instructions text contains both distinguishing phrasings.
- AC5: The clause-tag cache key/schema carries a bumped version marker so a cache entry written before this change is never read as a hit after it, verified by a unit test in `conform-tag-cache.test.ts` (or a co-located test) that a stale-schema cache entry misses.
- AC6: `review conform`'s own behaviour is checked against the pre-classifier: either its existing test suite passes with zero changes to expected findings, or any changed expectation is documented inline with a reason (e.g. a code comment/test comment) explaining why the pre-classifier also improves/changes conform's own tagging.
- AC7: `bun test src/review/conform-* src/review/jev-rules* src/commands/review-jev-rules* src/commands/review-conform*` all pass with zero failures, and `bun run typecheck` and `bun run lint` (or the repo's equivalent scripts) are clean on every touched file.
- AC8: A live re-measurement of `review-jev-rules --rules .metaproject/rules` against PR #712 (fresh cache dir, `env -u OPENROUTER_API_KEY`) shows the `api-contracts.mdc` "Review the contract for breaking changes" clause is pre-classified process and never reaches a Jev tag or violation call, with tagging-call count reported separately from violation-call count.
- AC9: A live re-measurement of `review-jev-rules --rules .metaproject/rules` against PR #717 (same fresh cache dir setup) is run, and every finding from both PR #712 and PR #717 runs is hand-labelled TP/FP, with before/after counts (#712: 2 findings/0 TP before; #717: 0 findings before) recorded in the flow journal.
- AC10: A PR from `feat/clause-tag-precision` to `main` is opened (not merged), containing only this flow's own files (excluding `.metaproject/data`), with a description reporting the before/after measurement numbers and flow id; CI left pending.
