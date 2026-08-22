# TOOL-11 and TOOL-13 (formalized from other real evidence gathered this campaign)

**Area:** 5. Built-in agent tools · **Date:** 2026-08-22 · **Status:** PASS (both)

## TOOL-11 — `shell_exec` + background jobs

Directly confirmed by `BGJOB-01-to-03.md` (this same campaign, `docs/verification/test-results/
11-background-jobs/BGJOB-01-to-03.md`) — that report already exercises exactly this: a real
`shell_exec` call with `background: true` returning an immediate `job_id`, real
`shell_job_output` polling, and real completion verification. Not re-run here; see that report
for the full transcript and evidence.

**Summary:** Confirmed real and working — same evidence as TOOL-11's own catalog row asks for.

## TOOL-13 — `spawn_subagent`: single and parallel-batch dispatch

Directly confirmed by the prior live-testing pass
(`docs/verification/keryx-0.2.55-live-testing-2026-08-21.md` §4), formalized here:

- **Headless/`ask` mode, no human present:** session `1be94528`'s first attempt — 3
  `spawn_subagent` calls dispatched in ONE batch, all 3 correctly required approval and were
  denied on EOF (no human present) — no crash, no interleaving error even under a 3-way parallel
  denial. The model gracefully fell back to manual read-only tools and disclosed the fallback.
- **`/mode trust`, real dispatch:** same session, second attempt — `◇ auto-approved (trust)
  spawn_subagent` ×3, three real distinct child sessions (`sub:8c89e565…`, `sub:4d2300fd…`,
  `sub:bfbe23da…`), all completed and fed a real, accurate comparative summary back to the
  parent turn.
- Confirmed live in the raw session transcript: the assistant turn issuing the 3-call batch, and
  the 3 `tool` results answering it, are fully contiguous (no interleaving regression, directly
  relevant to the original bug this whole testing campaign started from).

**Summary:** Confirmed real and working, both the denial path and the real parallel-execution
path, under real DeepSeek traffic.
