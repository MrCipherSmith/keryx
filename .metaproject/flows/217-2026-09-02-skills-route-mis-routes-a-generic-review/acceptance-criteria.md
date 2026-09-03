# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

These replace the first attempt's AC1-AC11, which were confirmed against code
removed from PR #431 in ff0ea1e6. The ordering is the point: AC1-AC3 are the
corpus, and they exist BEFORE any scorer change, because the first attempt could
only ever observe improvements and that is what made three rounds of regressions
invisible.

- AC1: A routing corpus exists with NEGATIVE pairs — queries asserted to route to nothing — covering at minimum `commitment issues`, `pushback from the team`, `preview the deck`, `проверь почту`, `проверка почты`, `open the file`. It passes against the CURRENT scorer before any change to it.
- AC2: The corpus covers INFLECTED forms of one-word triggers — at minimum `run the deployment`, `reviewing the diff now`, `commits are failing`, `brainstorming ideas`, `interviewing me first` — with each pair's expected top-1 recorded as the behaviour of the current scorer, so a later change that loses them fails rather than passing silently.
- AC3: Every corpus pair is asserted through the SHIPPED surface, not through a test-local ranking helper, and a test asserts that no second copy of the ranking pipeline exists.
- AC4: With the corpus in place and green, the degeneration defect is fixed: `review-frontend`'s `ui review` trigger no longer fires on a bare `review`, and a generic review request reaches `review-orchestrator` while a request naming a specialist still reaches that specialist.
- AC5: No trigger loses a matching path it had before the change. A test enumerates every catalog trigger and asserts the reachable set does not shrink — the first attempt took the count of triggers without an order-free path from 11 to 17 and nothing noticed.
- AC6: A single Russian word cannot satisfy a multi-word trigger through synonym expansion, and `проверк` does not imply `review` any more than `провер` does.
- AC7: The synonym table is asserted as a closed contract per family — expected tokens present AND unexpected routing-hot tokens absent — so an over-expansion fails. The first attempt's table test caught deletions and remappings and could not see additions.
- AC8: If `keryx orient` is taught to read the prompt again, its routing block is folded in BEFORE `runtime.format`, and a test asserts the cursor envelope parses as JSON with the block inside it. The first attempt's test could not observe this because every case it ran used a runtime whose format is the identity function.
- AC9: If the per-prompt router includes project-skills, a project skill can actually be emitted — the first attempt filtered on a `trigger` reason that `scoreProjectSkillRoute` never emits, so the manifest read bought nothing. Otherwise the exclusion is recorded as a decision with its reason.
- AC10: Every guard this flow adds is mutation-verified: reverting it makes a named test fail, and the result is recorded in the flow journal.
- AC11: `bun run typecheck` is clean and the full suite introduces no failures beyond those reproducible on origin/main.
