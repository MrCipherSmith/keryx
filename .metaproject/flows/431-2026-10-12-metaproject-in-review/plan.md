# Implementation Plan

Status: draft (PROPOSED; no task is created and nothing is implemented before the operator approves the PRD and acceptance criteria)

## Approach

The layers are deterministic, so the work is plumbing and recording, not model work: refresh them before dispatch, check their commit against the review head, hand each reviewer the answer for its own files, tell the skills to use the tools, and record what was used. The tail pass reuses the slice and retry-plan machinery from flow 430. Land in order T1 to T7 so that each task is useful alone.

## Steps

1. T1 Measure and decide: time `wiki refresh`, `wiki collect --force` and `memory index` on this repository and on the Vantage copy; confirm none calls a model; decide where a review's graph build is written so tracked files stay clean (a `--out`/data-dir option on `gdgraph build`, or a review-package copy).
2. T2 `review layers refresh|status` plus `layers.json` (AC1, AC3).
3. T3 Commit check in `blast-radius` and `dispatch`, with the operator-quote override (AC2).
4. T4 `layers` block in driver payloads, deterministic and byte-capped (AC4).
5. T5 Shared instruction block in the reviewer skills, bundled and project copies kept identical (AC5).
6. T6 `layersUsed` from the tool-call log into the package and the ledger (AC6).
7. T7 Tail pass over the dropped blast-radius files and the `complete` gate (AC7).
8. T8 TUI surfaces, `keryx help`, README and docs (AC8, AC9).
9. T9 Live run on PR 7659 in a fresh worktree, and the PR 7840 control (AC10, AC11); a release only on the operator's word.

## Risks

- `gdgraph build` writes tracked artifacts; a review that dirties the PR worktree could leak those files into the review diff. T1 decides the output location before T2 starts.
- Which `.metaproject` a review reads (the operator's project, or the one inside the PR head) is a policy question: for a PR into a repository that carries its own `.metaproject`, the PR head's wiki and memory describe the PR's base, not the operator's project.
- The tool-call log may not exist for every reviewer runtime (native subagent versus shell-driven); AC6 records `unknown` rather than zero for those, which could hide the very gap this flow measures.
- A refusal on a stale graph adds a step to every review; the 17 s build keeps it cheap, but a large repository may not (Vantage: 793 candidate files, build time not yet measured).
- The tail pass costs reviewer runs; the cap and the tier must be set so a single review does not double in cost.
