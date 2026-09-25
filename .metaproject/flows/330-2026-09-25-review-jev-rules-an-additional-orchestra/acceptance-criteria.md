# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A new bundled reviewer skill `review-jev-rules` (in `src/gdskills/bundled/skills/review/` and the installed `.metaproject/skills/gdskills/review/` copy, following the existing reviewer skill layout) and a CLI `keryx review jev-rules (--diff <ref>|--pr <n>|--scope <scope.json>) [--rules <paths>] [--max-calls N] [--json]` that emits findings conforming to `reviewer-finding.schema.json` (reviewer `review-jev-rules`), ready to be merged by the orchestrator like any other reviewer's output.
- AC2: Rule sources are discovered deterministically: project rules (`.metaproject/rules/**`, `rules/**`), project skills and installed gdskills whose frontmatter/paths mark them as coding conventions, plus any `--rules` paths; each is split into clauses with the existing `extractReferenceClauses` (conform-clauses) and filtered to clauses applicable to each changed file by language/extension/path globs declared in the rule or inferred from its `stack_requires`/paths; the applicability decision and its reason are recorded per pair. Pure, unit-tested.
- AC3: Hunks come from `buildReviewScope` (mechanical bulk already dropped). For every applicable (hunk, clause) pair, one Jev `noul` "does this hunk VIOLATE this rule clause?" with the redacted hunk and the clause text and deterministic facts (file, language, symbols touched); a `--max-calls` budget (default documented) bounds pairs, selection is deterministic and reported, never silent.
- AC4: Finding synthesis is deterministic (keryx writes the prose, Jev only judges): problem = which rule clause the hunk likely violates, quoting the clause; impact = the rule's stated rationale if present else a fixed template; suggested_fix = "bring this hunk in line with <clause>"; evidence = hunk location + quote + facts + Jev probability; severity from a documented probability→severity mapping capped at `minor` unless the rule declares a higher severity; confidence from probability bands. One finding per (hunk, clause) above threshold, deduped per clause+file with a hunk list.
- AC5: Orchestrator integration: `review-orchestrator/SKILL.md` lists `review-jev-rules` as an ADDITIONAL reviewer (never replacing any), dispatched in Wave B when `review.jev.rules: true` in `.metaproject/tasks.config.json` and Jev is reachable, via the CLI (not an LLM sub-agent); its findings go through the same quality gate, dedup and Wave C verification; `keryx review reviewers --json` shows it with `engine: jev`.
- AC6: Opt-in and privacy: without `review.jev.rules` the command refuses with a clear message; hunks and rule clauses are redacted via `src/security/service.ts` before any network call; no cache or output file stores keys; results cache under `.metaproject/data/` is gitignored, mode 0600.
- AC7: Shell: `/review` or the existing review UI surfaces `review-jev-rules` findings with their reviewer label, and a `/jevrules` (or entry in the existing conform/review modal) runs it on the working diff and lists findings grouped by rule; English UI; render tests.
- AC8: Tests: pure tests for discovery/applicability/pair selection/finding synthesis; CLI tests with fixture diff + fixture rules + fixture Jev responses; schema validation of emitted findings against `reviewer-finding.schema.json`; hermetic, macOS-safe; revert-checked.
- AC9: Live check (run with `env -u OPENROUTER_API_KEY`) on 2 merged PRs of this repo with this repo's own rules: finding counts, Jev calls, cost, time, and a manual spot-check of 10 findings labelled true/false positive, journaled honestly.
- AC10: Docs (cli-reference, review orchestrator docs, HELP_GROUPS, commands-by-task), CI green, `keryx health run` passes, import zones respected (facade ratchet at cap).
