# Acceptance Criteria

Full normative text lives in `docs/requirements/slate/specification.md`'s
"v2 acceptance criteria (SLATE-16…20)" section plus AC-33 for SLATE-21. Each
line below pins the flow-local ACn to the spec's own AC-N; read the spec for
the full text, do not restate it here.

- AC1: `keryx workspace review --decision accepted` and MCP `sac.review` with
  `decision: "accepted"` both fail `token_required`/`token_invalid` without a
  valid, unexpired, unused confirm-token for the exact `(workspaceId,
  proposalId)` pair; `"rejected"`/`"dismissed"` require no token;
  `confirm-review` is not exposed as any agent-native tool (= spec's AC-30,
  AC-31).
- AC2: every proposal produced by the wrap-up path has zero embedded
  `session-evidence/*.md` full-transcript content in its primary evidence;
  the transcript export is still reachable as a separate linked reference
  (= spec's AC-33).
- AC3: `workspace_create`/`workspace_list`/`workspace_show`/
  `workspace_propose` are reachable from keryx-shell's interactive agent
  without `shell_exec`/approval and produce records identical to the CLI
  equivalent; no `workspace_review` agent tool exists anywhere (= spec's
  AC-28, AC-29).
- AC4: SLATE-16's resolve-or-create never binds a workspace id without a
  preceding `workspace_list` call, and fires only at flow-creation and at
  slate-open-without-bound-workspace — never on every turn (= spec's AC-24,
  AC-25).
- AC5: SLATE-17's mid-session re-evaluation fires only at the existing
  SLATE-5 close-trigger point, introducing no new topic-shift detector
  (= spec's AC-26).
- AC6: SLATE-18's autonomous `workspace_propose` call never fires without
  one of SLATE-7's existing trigger conditions having also fired (= spec's
  AC-27).
- AC7: no subagent (via `spawn_subagent`) ever gains access to
  `workspace_create`/`workspace_list`/`workspace_show`/`workspace_propose` —
  those four tools exist only in the parent's own tool set (= spec's AC-32).
