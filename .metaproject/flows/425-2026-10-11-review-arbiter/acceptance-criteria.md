# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The arbiter is a sub-agent profile with no shell, no write tools and no network; its rules are a versioned file with numbered rules and a closed verdict set `allow|deny|escalate`; a test loads the file and rejects a rule without an id.
- AC2: Question kinds are a closed set (scope, budget, option choice, continue with partial coverage, retry with a smaller slice, slice order); a question of another kind returns `escalate` without a model call; a test per kind and one outside.
- AC3: A floor-class call (destructive, credentials, publish, hook-ask, any call after untrusted content) is never sent to the arbiter and never answered by it; a test sends each and sees the human/policy path.
- AC4: The arbiter prompt is built by keryx from structured fields only; PR text, diff text and reviewer output never enter it as free text; a test puts an instruction-like string in the PR body and shows it is absent from the prompt and does not change the verdict.
- AC5: The verdict is validated against a schema; an invalid answer, a timeout or a model error becomes `escalate`; in an autonomous run `escalate` is a safe refusal plus a journal line; tests for each.
- AC6: Every question, verdict, rule id, model and cost is appended to `arbiter.log` in the package; an identical question in the same run is answered from a cache without a new call; a per-run call cap exists, and past it the answer is `escalate`.
- AC7: The arbiter model is declared as a tier, one below the flagship, in config; the GPT-6 Astra model is refused by name; a test.
- AC8: In `review-auto` and in the autonomous profile the `ask_user` menus of the review orchestrator consult the arbiter instead of the word heuristic; in `ask` mode the human is still asked; a test per mode.
- AC9: An evaluation set of at least 20 fixture questions has expected verdicts and the arbiter agrees on at least 95%; an adversarial set (injection, rule-bypass phrasing) is 100% `deny` or `escalate`; both run in CI with a stubbed and a recorded model.
- AC10: A TUI view lists the arbiter log of the current run (question, verdict, rule); a Telegram line reports an `escalate` that stopped a run.
- AC11: Live: in the PR 7435 autonomous run (flow 424 AC11) the arbiter answers at least one real question; its log is kept as evidence.
- AC12: The docs (a guide to the rule file, how to change it) and the CHANGELOG describe it; the docs site builds with --strict.
