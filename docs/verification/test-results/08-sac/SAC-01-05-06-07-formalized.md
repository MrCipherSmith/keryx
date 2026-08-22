# SAC-01, SAC-05, SAC-06, SAC-07 (formalized from the prior live-testing pass)

**Area:** 8. SAC: workspace / proposal / review · **Date:** 2026-08-22 (evidence gathered
2026-08-21) · **Status:** PASS (SAC-01, SAC-06, SAC-07) / FAIL — real finding, already filed
as issues #390/#391 (SAC-05)

Formalizes four already-executed, already-evidenced cases from
`docs/verification/keryx-0.2.55-live-testing-2026-08-21.md` §5 into the catalog's per-case
format. Run directly by the parent session (not delegated), real `keryx 0.2.55`, real
`deepseek/deepseek-chat`.

## SAC-01 — `workspace_propose` from a wrap-up-driven Seed produces a real, catch-up-visible proposal

**What was actually run:** Session `1be94528` (`4d71504a-fdd3-47aa-b91a-88231be94528`), the
parallel-subagent module-comparison `/goal --auto 2` run.

**Captured evidence:** Real `⚙ workspace_propose(...)` tool calls in the transcript, producing
proposals `proposal-52890f8ceaf348f9`, `e3d3a254aa5e464f`, `f995afc19f3d4e56` on disk under
`.metaproject/workspaces/workspace-e1b704272f124ba7/proposals/`. `keryx workspace catch-up`
independently confirms a pending proposal for Flow 188's session, right now, with the real
`keryx workspace review ...` command line ready to run.

**Summary:** Confirmed — the propose path genuinely writes durable, reviewable state.

## SAC-05 — direct wiki mutation (`keryx wiki new`/`wiki enrich`) bypasses SAC review entirely

**What was actually run:** Session `53609f7a` (`d3d97ce6-12a3-4722-8a98-677953609f7a`), a
real "write documentation for src/sac" task.

**Captured evidence:** `.metaproject/wiki/components/src-sac.md` reached `Status: accepted` on
disk with zero SAC proposal ever created (`keryx workspace list-proposals
workspace-e1b704272f124ba7` → `[]`), and the session itself is filed under `keryx workspace
catch-up`'s "Unknown (no resolution recorded)" bucket — SAC has no idea a real mutation
happened.

**Summary: FAIL relative to the review-gate invariant SAC's own architecture documents assume.**
Already filed as two issues: [#390](https://github.com/MrCipherSmith/keryx/issues/390) (the
proximate shell-permission cause) and
[#391](https://github.com/MrCipherSmith/keryx/issues/391) (the structural SAC-coupling gap).
Not re-analyzed here — see those issues for full root cause and suggested direction.

## SAC-06 — `keryx workspace catch-up` correctly buckets pending / blocked / unbound / unknown / lifecycle-flags

**What was actually run:** `keryx workspace catch-up` (plain CLI, no live provider needed),
run after the sessions above.

**Captured evidence:** Real output showing all five sections populated correctly: one real
pending proposal (with the exact `keryx workspace review ...` command to run), a long list of
"Unknown (no resolution recorded)" sessions (including the SAC-05 session above), and one real
lifecycle flag (`lessons/allowlist-not-a-boundary.md`, scoped to code no longer in the graph).

**Summary:** Confirmed — all four/five buckets are real and independently verifiable, not
placeholder sections.

## SAC-07 — `--include-lifecycle-flags` (shown by default) flags an orphaned memory/wiki/workspace scope

**What was actually run:** Same `catch-up` run as SAC-06.

**Captured evidence:** The lifecycle-flags section surfaced one real flag: a memory lesson
entry scoped to `src/lib, src/commands, src/tui` — reusing the graph-diff signal per its own
documented design — report-only, nothing archived/edited automatically.

**Summary:** Confirmed exactly as documented.
