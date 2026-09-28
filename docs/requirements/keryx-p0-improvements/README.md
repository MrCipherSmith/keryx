# Keryx P0 Improvements — after the 2026-09-27 competitive review

Version: 0.1.1

## Purpose

Five workstreams chosen from a functional review of keryx and a comparison
with ten coding agents (Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider,
Goose, Cline, Amp, Cursor, Kiro). The review is in
[competitive-review.md](competitive-review.md); the items that did not make
the cut are in [backlog.md](backlog.md).

The selection rule: a workstream is P0 if it either **proves a capability
keryx alone has** and currently only claims, or **closes an expectation that
nearly every competitor already meets** and a first-time user will test in
their first hour.

| W | Workstream | Why P0 |
|---|---|---|
| W1 | External agents run for real | keryx is the only tool with first-party delegation to Claude Code, Codex and Gemini CLI — and its own docs say it "has never been run against a real vendor process". |
| W2 | `/rewind` — file snapshots per turn | Claude Code, Gemini CLI, Kiro and OpenCode all have it; keryx checkpoints the transcript, not the files. |
| W3 | Review as a GitHub Action | Claude Code, Cursor Bugbot, OpenCode and Kiro review PRs unattended; keryx's review pipeline — the only one with a verifier — runs only on a developer's machine. |
| W4 | Remote approval | `keryx serve` and every trigger turn a policy `ask` into a recorded denial; Cursor, Kiro, Codex Cloud and Claude Remote Control let the human answer from wherever they are. |
| W5 | First hour | `keryx doctor` does not exist, an unknown command prints 100 lines, `mcp list` exits 1 over someone else's config, health cannot see keryx's own tests. |

## Status

Updated 2026-09-28. One workstream shipped; four are specification-ready.

| W | Status | Where |
|---|---|---|
| W5 First hour | **implemented** — flow 353, PR #773, release 0.3.17 | `keryx doctor` / `/doctor`, did-you-mean for every group, `mcp list` exit codes, `memory search` stemming + hint, health `tests` detection, bare `providers` |
| W1 External agents run for real | draft — spec ready | — |
| W2 `/rewind` | draft — spec ready | — |
| W3 Review as a GitHub Action | draft — spec ready | — |
| W4 Remote approval | draft — spec ready | — |

**Agreed order for the rest** (operator, helyx, 2026-09-28): audit-remediation
flow 2 (R3 security depth, corpus measurement first) → audit-remediation flow 3
(R4 architecture, R5 gates) → W1 → W2 → W3 → W4. One flow per workstream,
frozen AC from [specification.md](specification.md) §8, a verifier-backed
review round against the PR head before merge, one release per flow. Work is
paused after flow 354; nothing is in flight.

W2 and W4 carry the most design risk (see the PRD).

## Document index

- [README.md](README.md) — this file.
- [prd.md](prd.md) — problem, goal, users, requirements per workstream, success criteria, risks, recommendation.
- [specification.md](specification.md) — surfaces, storage, contracts and acceptance criteria per workstream.
- [competitive-review.md](competitive-review.md) — the review that produced this package: strengths, gaps, matrix, live friction log, sources.
- [backlog.md](backlog.md) — the P1 and P2 improvements deliberately not in this package, each with the reason.

## Scope

- W1: a recorded live run of each registered external agent, a write mode
  with review, and the doc claim retired.
- W2: per-turn file snapshots in a shadow git repository, `/rewind` in the TUI
  and readline, `keryx sessions rewind`.
- W3: `keryx review run` headless, a reusable GitHub Action, inline PR
  comments with verifier status, a "closed before merge" metric.
- W4: an approval request/response transport for `keryx serve`, triggers and
  the helyx channel, single-use grants, recorded outcome.
- W5: `keryx doctor`, did-you-mean for unknown commands, `mcp list` exit
  semantics, `memory search` stemming and the `--semantic` hint, health seeing
  the project's own tests.

## Non-goals

- Anything in [backlog.md](backlog.md): Linux sandbox parity, graph freshness,
  context-economy measurement, memory auto-extraction, wiki dogfood, ACP with
  real IDEs, Windows, plugin catalog, voice.
- The audit remediation ([keryx-audit-remediation](../keryx-audit-remediation/README.md)).
- Enterprise features (SSO, shared policy).

## Related modules and packages

- W1: `src/harness/external/`, `fixtures/external/`, `docs/docs/harness.md`,
  `keryx-external-agent-runtime`.
- W2: `src/session/`, `src/commands/shell.ts`, `src/tui/`, `keryx-agent-bus`
  (session lease).
- W3: `src/review/`, `managed-review-feedback-loop`, `flow-reviewer`,
  `.github/workflows/`.
- W4: `src/commands/serve.ts`, `src/trigger/`, `src/harness/policy/`,
  `keryx-execution-observability` (governance report).
- W5: `src/cli.ts`, `src/commands/mcp-servers.ts`, `src/memory/`,
  `src/health/sources/`, `docs/requirements/backlog.md` items 1 and 4.
