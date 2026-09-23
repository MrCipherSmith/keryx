# Review — flow 288, ACP project tools (identity-carry round for F-008)

Round `2026-09-23-ingest-acp-project-tools-r02` re-verified F-008 (no `config_option_update` push
when a late model list arrives after a timed-out session replied) as fixed by `c84e0991` ("fix(acp):
tell a session its full model list when the list arrives late"), merged to main in `93ac7a74` via
PR #655, and recorded its disposition as `acted-on`. That round minted F-008 under its own
review-id, which is a different `global_id` from the finding as first raised in round
`2026-09-22-ingest-acp-project-tools`. This round re-reports the SAME finding — same site, same
fix — carrying forward the ORIGINAL `global_id` (`2026-09-22-ingest-acp-project-tools#F-008`) it
was minted under, so its latest state (acted-on, refuted) supersedes that round's recorded
`dismissed-deprioritised` rather than being read as an unrelated finding. No new defects. CI
18/18 green on PR #655 at head `c84e0991d9a709e2455dcfb841ec04246ef81d3d`, merged to main in
`93ac7a74`, on top of the flow's PR #651 base at `bd1dbe96`.

```keryx:findings
[
  {
    "id": "F-008",
    "global_id": "2026-09-22-ingest-acp-project-tools#F-008",
    "reviewer": "code-reviewer (acp, round 2)",
    "severity": "minor",
    "file": "src/acp/server.ts",
    "quote": "the next session asks again",
    "problem": "When a session's model list times out (F-001's bound), that session starts on the launch model only. If the background listing later succeeds, `listedChoices` is cached for future sessions, but the session that already timed out and replied was never sent a `config_option_update` with the fuller list — it only got the extra choices if it asked again some other way (e.g. session/load).",
    "impact": "A user on a session whose model list happened to arrive just after the 8s bound saw only the launch model as a config option for the rest of that session, even though the fuller list became available moments later, with no session/update telling them anything changed.",
    "suggested_fix": "Push exactly one config_option_update, with the complete options and the current model still selected, to a session left on the launch-only list once the late list resolves — built the same way the set_config_option answer is; never resend to a session that already has the full list; send nothing when the late list itself fails or the connection has already closed.",
    "evidence": "src/acp/server.ts:504-533 (modelChoices), pre-fix, cached a successful late listing into `listedChoices` for future calls but never iterated live sessions to push config_option_update when that happened.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/server.ts modelChoices (the timeout/background-listing path)"],
      "enumeration_method": "The only site that resolves a model list after a session has already answered session/new or session/load is modelChoices' background startListing(source) continuation; there is exactly one such site."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Was real against bd1dbe96 (merged PR #651, head 7e0809a2): no config_option_update push existed for a late-arriving list. Fixed at c84e0991 (\"fix(acp): tell a session its full model list when the list arrives late\"), merged to main in 93ac7a74 via PR #655 — a follow-up merge on top of the flow's PR #651 base at bd1dbe96. src/acp/server-models.test.ts describe(\"7 — a late model list reaches sessions left on the launch-only one\") holds 4 tests, all passing: 'a session offered only the launch model is told once, with the full list, when it arrives late' (the one that fails without the fix — reproduces the exact gap this finding names), 'a session that already got the complete list is never told again', 'a late list that fails sends nothing', 'no update once the connection has closed'. bun test src/acp/server-models.test.ts: 10 pass, 0 fail (93ac7a74, merged PR #655, on top of bd1dbe96, merged PR #651). CI 18/18 green on PR #655 at head c84e0991d9a709e2455dcfb841ec04246ef81d3d.",
      "verifier": "round-3 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the single config_option_update push on late list arrival in src/acp/server.ts (task T15), commit c84e0991; merged to main in 93ac7a74 via PR #655. Supersedes this global_id's prior `dismissed-deprioritised` recording in round 2026-09-22-ingest-acp-project-tools: the operator chose to fix rather than defer it."
    }
  }
]
```

## Coverage

This round covers only F-008's identity-carry re-report; it does not re-scan the rest of the
flow 288 change set, which round `2026-09-23-ingest-acp-project-tools-r02` already covered in
full alongside F-001..F-007.

## Outcome

One finding, re-reported under its original `global_id` with the state its fix earns: `acted-on`,
verified `refuted`. This round exists solely so the review completion gate reads F-008's latest
state as fixed rather than as the earlier round's `dismissed-deprioritised`, which the operator
overrode by choosing to fix it (flow task T15, PR #655, merged `93ac7a74`).
