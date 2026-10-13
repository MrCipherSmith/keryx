# Review depth parity

Status: draft (PRD and acceptance criteria go to the operator before freeze)
Source: user description (origin: human-request)

## Problem

On 2026-10-12 the same pull request (Presight-AI/a work project #7659, head e3d132aa) was reviewed twice: by Claude with hand-driven orchestration, and by a keryx shell (openai-codex/gpt-6.1-sol, flow 419 live run). Claude reported 1 major, 1 cycle, 14 minor and 3 questions (19 items, about 40 raw findings, 12 mutants run). The keryx shell reported 0 major and 3 minor (5 raw findings, no mutation pass). The gap is measured item by item in `~/notes/review-depth-gap-7659.md`. The losses happen before the filter, not in it: of the 19 Claude items, 6 came from roles keryx never ran, 5 from roles that ran and returned nothing, 1 from truncated input, 1 needed a mutation pass, and only 4 were kept (the main major was downgraded to minor).

Root causes, by weight:

1. The reviewer set was narrowed to `diff` without the operator naming a narrower mode. Architecture, performance, clean-code, highload and security were not derived.
2. A path-gate defect: project-skill reviewers whose paths come from their description (`review-work-project-domains` for `src/pipelines/**`, `review-work-project-core` for `src/core/**`) are excluded as `no-matching-paths` although the diff matches. Reproduced in `all` mode too.
3. The mutation pass is optional and left to the model. Every run recorded `executionRequired: false` (source-only), the testing reviewer's ready 6-mutant script was never run, and the close rule for unattended runs ("record Not run without asking") was applied to a run with an operator present. Without a surviving mutant no reviewer rates "behaviour change with no pinned assertion" above minor, and the verifier can only delete.
4. Reviewers received truncated context: `comments.json` cut at 800 characters, no round-1 intent, no CI status, no backend pin.
5. `review-regression` is not in `required` although the blast radius is computed.

## Expected Outcome

A keryx review of a pull request finds, by default and without hand-driving, what the Claude review found on #7659. The reviewer set, the executed evidence and the severity calibration are recorded in the package. The mutation pass is a deterministic command, not a model decision. The depth gap is measured by a repeatable comparison, not by impression.

## Outcome criteria

- Запрос (дословно): «Так и как исправить глубину?» (source: the chat bot chat -1003908750902 message 199220, 2026-10-12T09:58Z). Context: the operator saw the PR 7659 comparison with Claude's report, then approved the diagnosis step ("Давай", message 199233) and this flow ("Да", message 199243).
- Эффект (формализация агента): a default review of a pull request runs the full applicable reviewer set including regression; path-gated project reviewers are selected when their paths match; the mutation pass runs through one command and its survivors drive severity; reviewers get complete comments and round context. A rerun on PR 7659 reproduces at least 12 of Claude's 19 items, with the main item as a major backed by a surviving mutant.
- Как наблюдать (предложение агента): `keryx review required` on the #7659 scope lists no excluded reviewer whose paths match; `research-evidence/` holds the mutant table; the comparison command prints items found per class (A to E) before and after; the review panel in the TUI shows the mode, the reviewer set and the mutation result.

## Out of Scope

- Browser/layout review (`review-layout` needs a browser; stays optional and is explicitly recorded as "Not run" when unavailable).
- Changing the Claude-driven review flow in the a work project repository.
- Replacing the verifier: it still only deletes. A separate severity audit step may raise severity, with recorded evidence.
- The unattended (`review run --autonomous`) behaviour of "Not run: mutation pass" stays as it is.
