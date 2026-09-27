# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With plan follow-through left at its default, a turn whose session plan still has `pending`/`in_progress` items ends on the model's text reply with no message appended to history by the shell; the operator gets a one-line `[plan]` note naming the actionable items. A test covers this, and a separate test shows the nudge still fires when the opt-in is set.
- AC2: The system prompt no longer states or implies that plan status decides when a turn may end; `/goal` behaviour is unchanged (existing `goal-command` tests pass unmodified or with a stated reason in journal.md).
- AC3: `renderExecutionPlanSnapshot` lists `in_progress`, then `blocked`, `pending`, `proposed` items, and folds `completed`/`skipped` into a count line; for an 18-item plan whose `in_progress` item is the 12th, the rendered snapshot contains that item. Covered by a test.
- AC4: When a turn reaches `max_tool_calls`, it runs exactly one further model round with no tools offered before returning `finishReason: "tool-call-budget"`, and that round's text is what a subagent returns. Covered by a test with a scripted provider.
- AC5: A `spawn_subagent` result whose child finished `BudgetExhausted` or `NoProgress` has `output` whose first line is `status: <Status> (<invoked>/<max> calls)` (calls omitted when no call budget applies); the fleet event is not `done`, and the child slate is folded as incomplete. Covered by tests.
- AC6: `spawn_subagent` accepts an optional `cwd`; the child's file tools resolve relative paths against it; a `cwd` outside the project root that is not a git worktree of the same repository is refused with an error result. Covered by tests including the refusal.
- AC7: `keryx review reviewers --json` reports the inventory source (`project`, `package` fallback, or `not-found`); when the project's review skills directory is absent it uses the package's bundled review skills, and when neither exists it says `not-found` and exits non-zero instead of printing empty lists. Covered by tests.
- AC8: The toolless reprompt does not fire when the same turn already executed a tool call, nor on a reply that is a complete structured answer (headings or lists, or longer than a stated threshold) unless it ends with `:`; the markers `i` and `will` are gone. Existing reprompt tests are updated, and new tests cover both suppressions.
- AC9: Every control nudge the shell synthesizes into history (toolless reprompt; plan follow-through when opted in) carries a provenance distinct from operator input and an envelope naming the shell as its author instead of a bare `[system]` prefix. Covered by a test that inspects the pushed history entry.
- AC10: The review-orchestrator skill (bundled and `.metaproject` copies, parity test green) maps an empty reply, a reply without a valid result block, and a `status: BudgetExhausted`/`NoProgress` subagent result to `BLOCKED`, allows one re-dispatch with a larger budget, reports the pass as not run otherwise, and forbids marking steps 8–10 `completed` without a `keryx review ingest` record; findings without a verifier verdict are `unverified`, never self-verified.
- AC11: The skill requires rendering the report from `templates/review-report.md`, showing the rendered body to the user and getting explicit approval before any GitHub write, and the skill and `session-plan-bridge.mdc` (both copies) agree on when the review checklist is published.
- AC12: `bun run typecheck` and the targeted test files for every touched module pass on the branch; a live `bun run src/cli.ts harness run` (or equivalent scripted-provider run) demonstrates AC1 and AC4, with the command and output recorded in journal.md.
