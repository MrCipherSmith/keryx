# Keryx Orchestrator Hardening
Version: 0.1.0

## Purpose

Two things, and they are related.

First: make the orchestrator skills **verifiable**. A benchmark on 2026-08-29
measured our own flow packages and found that the gates written in TypeScript
held 184 times out of 184, while a gate written in Markdown — one our own
`SKILL.md` asserts exists — has never existed at all. This package turns the
load-bearing prose into code, deletes the prose that lies, and unifies the
contracts so that a claim in a skill file can be checked.

Second: extend `flow-orchestrator` and `review-orchestrator` with three
capabilities the current design cannot express:

- **deep review rounds after the draft PR** that cover not only the diff but
  the functionality the diff can break;
- **completion gated on a clean final round**, so a flow is `done` only when the
  last review returned no unresolved findings and confirmed the fixes;
- **external PR comments taken into the loop**: comments left by other humans or
  bots on the PR are collected on every round, fixed like any other finding, and
  **answered once at the end** — briefly, and never silently ignored.

Two cross-cutting rules arrived with the same instruction and are specified
alongside them:

- **adaptive model selection** — skills declare a tier (`light`/`standard`/
  `deep`), never a model name; the tier resolves per provider family, and an
  undetectable provider inherits the session's model rather than degrading.
- **everything written to GitHub is brief.** Verbose in the flow, terse
  outward. The reasoning belongs in the flow package, which is durable and free
  to skip; a PR comment is read by someone who did not ask for it.

## Status

**All seven phases delivered**, released as **0.2.72 on 2026-08-30**
(`eb987aa2`). Phases 0 and 1 landed first, in 0.2.70 (flow 201, PR #408);
phases 2 through 7 followed in 0.2.71 and 0.2.72. This block was stale for one
release — it went on describing phases 2 through 7 as unstarted while all seven
had shipped — and the correction is recorded here rather than quietly applied,
because a status line nobody re-reads is how the claim survived.

What landed: the task gate is code rather than a sentence, the review record
survives a round and can seed the next one, attempt counts persist, the
deterministic pre-filter, the caps, the verifier, the review completion gate,
external PR comment handling, `keryx job`, and the structural skill sweep.
Per-phase evidence is in [roadmap.md](roadmap.md).

**Delivered is not defect-free.** A re-measurement on 2026-08-31
([measurement-2026-08-31.md](measurement-2026-08-31.md)) found **eleven
regressions** in the shipped result, including a flagship instrument that
returns an empty result from an installed copy and a field that shipped with no
consumer. They are tracked as flow 209 and are not closed by this status line.

What that work taught, and what now governs the rest of this package: **"put it
in code" is too blunt.** The prose we carry is two different things — judgement,
which must stay prose, and mechanical operations that are simply in the wrong
place. The rule is to move the mechanical ones out of the skill and into the
code that consumes its output, rather than to word the instruction more firmly.
See [roadmap.md](roadmap.md) §The refinement that came out of doing it.

The orchestrators it modifies *are* implemented
(`src/gdskills/bundled/skills/orchestration/`, `.../review/`, `src/flow/`,
`src/review/`). Every defect cited below was observed in the current tree or
measured from `.metaproject/flows/`; none is hypothetical.

One dependency was load-bearing and is stated once here rather than repeated:
**§Deep rounds and §Completion gate both require the durable review record to
survive a round.** When this package was written it did not — `src/review/managed.ts`
re-parsed findings from Markdown and dropped four of the five fields the next
round's input contract requires — which is why it was scheduled as Phase 1
rather than as an optimisation. It was delivered in `df1e6234`: the record now
survives a round, and both capabilities gate on it.

## The measured baseline

Everything in this package is anchored to numbers, not to opinion. The full
evidence and its sources live in [roadmap.md](roadmap.md); the load-bearing
ones:

| Observation | Value | Where |
|---|---|---|
| AC gate (enforced in TypeScript) held | **184 / 184** | `.metaproject/flows/` |
| Task gate (asserted in Markdown) held | **160 / 184** | same |
| — done flows carrying an unfinished task | **24 flows / 34 tasks**, of which **24 tasks** are the review step | same |
| `attempts.count` ever non-zero | **3 / 196** | same |
| Flows exceeding 8 hours wall-clock | **27%** | same |
| Review mechanisms actually enforced by code | **2 of ~10** | `review-orchestrator/` |
| Occurrences of "false positive" in the review domain | **0** | same |

## Scope

- `src/flow/` — the completion gates and the attempt counter.
- `src/review/` — the managed review record and its ingest path.
- `src/gdskills/bundled/skills/orchestration/flow-orchestrator/`
- `src/gdskills/bundled/skills/review/` (20 skills)
- The contract schemas under `src/gdskills/contracts/`.

**Both copies.** `.metaproject/skills/gdskills/` is an installed mirror of
`src/gdskills/bundled/skills/`. Every skill edit lands in both or they diverge
silently.

## Non-goals

- A checkpoint/durable-execution engine. What is missing is a counter and a
  phase marker — fields, not an engine. See [roadmap.md](roadmap.md) §Rejected.
- More reviewers, more agent roles, or parallel *writing* agents. Each is
  rejected against measurements, not taste.
- Chasing a benchmark number. One in five "solved" SWE-bench patches is
  semantically incorrect; the leaderboard is not the target.
- Replacing `job-orchestrator`. It stays the non-Task-Manager path.

## Document index

| Document | Purpose |
|---|---|
| [Roadmap](roadmap.md) | Phased plan: what changes, in what order, why, at what cost, with the evidence for each. **All seven phases delivered, released as 0.2.72 on 2026-08-30.** Two citations in it were re-checked on 2026-08-31 and corrected — see §0.1 and §5.4. |
| [Specification](specification.md) | The three new capabilities in implementable detail — deep rounds, the completion gate, and external PR comment handling. |
| [Internal measurement, 2026-08-31](measurement-2026-08-31.md) | The four orchestrators re-inventoried by the Phase 7 method, stated as before/after. **Reports eleven regressions**, including a command that returns an empty result from the installed package and a field shipped with no consumer. |
| [Market comparison, 2026-08-31](market-2026-08-31.md) | Competitors re-checked with versions and sources, and the dimensions where they lead. **No shared-task run happened**, so no recall or precision number comparing tools is claimed. |

## Related

- `docs/requirements/managed-review-feedback-loop/` — the existing managed
  review requirements this extends rather than replaces.
- `.metaproject/rules/core/subagent-status-protocol.md` — the worker status
  vocabulary, which has a dead branch (`FAILED` can never be emitted).
