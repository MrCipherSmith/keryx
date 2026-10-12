# Implementation Plan

Status: draft, operator decisions applied (PROPOSED; no task is created and nothing is implemented before the operator approves the PRD and acceptance criteria)

## Approach

The layers are deterministic, so the work is plumbing and recording, not model work: refresh them automatically before dispatch, keep the build off tracked files, hand each reviewer the answer for its own files, tell the skills to use the tools, and record what was used. The chunked pass reuses the slice and retry-plan machinery from flow 430 and is the only model step added, on the middle tier; nothing is skipped, so the work is a deterministic chunk plan, sequential runs, a merge and a coverage gate. Land in order T1 to T8 so that each task is useful alone.

## Steps

1. T1 Measure and decide: time `wiki refresh`, `wiki collect --force` and `memory index` on this repository and on the Vantage copy; confirm none calls a model; settle the mechanism for AC2 (a data-dir option on `gdgraph build` and graph readers that follow it; fallback: build in place and restore the three tracked files, with the same test). The outcome (clean tree, clean PR) is fixed by AC2; only the mechanism is open.
2. T2 Automatic refresh in `review` start/dispatch, `review layers refresh|status`, `layers.json` (AC1, AC3).
3. T3 Clean-tree build and graph readers (AC2).
4. T4 Wiki/memory divergence mark against the PR head (AC4).
5. T5 `layers` block in driver payloads, deterministic and byte-capped (AC5).
6. T6 Shared instruction block in the reviewer skills, bundled and project copies kept identical (AC6).
7. T7 `layersUsed` from the tool-call log with `unknown` (AC7).
8. T8 Chunk plan, sequential run and merge for the dropped files (AC8); the scope A coverage check including named omissions (AC9); the `complete` gate and the quote waiver (AC10); the estimate and the ceiling (AC11).
9. T9 TUI surfaces, `keryx help`, README and docs (AC12, AC13).
10. T10 Live run on PR 7659 in a fresh worktree and the PR 7840 control (AC14, AC15); a release only on the operator's word, batched with flows 429 and 430.

## Risks

- A build that cannot avoid tracked files (T1) would need the restore fallback; a crash between build and restore must not leave the tree dirty, so the restore runs in a `finally` and the status check is part of AC2.
- Wiki and memory come from the working copy: for a PR into a repository whose own `.metaproject` differs, the divergence mark is the only signal that the layers describe another state, so it must be visible in the panel, not only in `layers.json`.
- The tool-call log may not exist for every reviewer runtime (native subagent versus shell-driven); `unknown` is non-blocking by decision, which could hide the very gap this flow measures, so the panel shows how many reviewers are `unknown`.
- Coverage can make a review long: 753 dropped files are 19 chunks of 40 files run one after another. The estimate before the run (AC11) and the per-pass cap keep the cost visible; the sequential order keeps each pass inside the reviewer's deadline. Named omissions (lockfiles, generated) count as covered by decision 7 and are listed per file with a reason (AC9); they are not read.
- The automatic rebuild adds about 17 s to every review here; a large repository may take longer (Vantage: build time not yet measured).
