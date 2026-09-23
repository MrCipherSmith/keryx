# Review — flow 288, ACP project tools (PR #651, follow-up fix PR #655)

Three review passes ran over the flow 288 change set: `src/acp/*` (roster, agent-io, commands,
models, protocol, server, session) plus the shell seams it reaches into (`src/commands/shell.ts`
`withSavedBaseUrls`, `src/commands/acp.ts` `shellModelSource`) and the docs it touches
(`docs/docs/cli-reference.md`, `README.md`). The first pass, against the T5–T12 implementation
commit (`bb959fa4`), raised seven defects — two major (an unbounded network probe able to stall
every new editor session, and a model switch that silently ignored the shell's own saved
per-provider endpoints) and five minor (a roster pin that could silently widen, command parsing
gaps, a model choice lost across a restart, a lost concurrent switch, and a stale comment). All
seven were fixed in one commit, `e633d4b9` ("fix(acp): never let the model list stall a session,
and keep switches honest"), merged to main in `bd1dbe96` via PR #651. The second pass re-verified
all seven fixes at that commit and raised no new defects, but recorded one minor accepted-looking
gap in the model-list timeout path: a session left on the launch-only model was never told when
the full list arrived late. Rather than deferring that gap, the operator chose to fix it (T15).
The third pass verifies that fix: commit `c84e0991` ("fix(acp): tell a session its full model list
when the list arrives late"), merged to main in `93ac7a74` via PR #655, on top of the flow's PR
#651 base at `bd1dbe96`. All eight findings are now acted on. CI is 18/18 green on both PR #651
(head `7e0809a2a2b170ded9d3ecf307e1c0f6f298a19a`) and PR #655 (head
`c84e0991d9a709e2455dcfb841ec04246ef81d3d`).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/server.ts",
    "quote": "const modelListTimeoutMs = options.modelListTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;",
    "problem": "session/new and session/load awaited the model list with no bound, and the Ollama probe behind it carried no per-fetch timeout and targeted the saved launch provider's base URL rather than the shell picker's own `--base-url` flag.",
    "impact": "An unreachable or slow gateway could stall every new editor thread on the OS connect timeout — the exact failure the operator flagged from the live Zed session on 0.2.154 (flow 287/288 release-decision journal entry) — with no way for the client to make progress until the OS gave up.",
    "suggested_fix": "Bound how long a session waits for the list, start the session on the launch model when the bound is hit, and give the probe its own timeout on the same `--base-url` the shell uses.",
    "evidence": "Pre-fix, `modelChoices()` had no `Promise.race` against a timer and the Ollama probe fetch carried no `AbortSignal.timeout`.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/server.ts modelChoices (session/new, session/load)", "src/acp/models.ts Ollama probe fetch"],
      "enumeration_method": "Both call sites that await a model list before answering an ACP request were enumerated by tracing every caller of `modelChoices()`; the probe is the sole network fetch in the model-listing path."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), src/acp/server.ts:493-533 races the model listing against `setTimeout(modelListTimeoutMs)` (default 8s), returns `[launchChoice]` and logs to stderr on timeout, and does not cache a failure. The probe now uses only the shell's `--base-url` flag with `AbortSignal.timeout` on every fetch. bun test src/acp/server-models.test.ts and src/acp/ suite: 185 pass, 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the bounded model-list race and the --base-url-only probe in src/acp/server.ts and src/acp/models.ts, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/commands/shell.ts",
    "quote": "export function withSavedBaseUrls<T extends { name: string; baseUrl?: string }>(",
    "problem": "Switching the ACP session's model built providers from the detected defaults only; it did not apply the per-provider endpoints the shell itself saves (the TUI endpoint picker, the Copilot login), so an ACP switch to a provider with a saved non-default endpoint silently used the wrong one.",
    "impact": "A user who had pointed the shell at a private/self-hosted endpoint for a provider would have their ACP session's model switch silently reach the default endpoint instead, potentially the wrong deployment or an unreachable one.",
    "suggested_fix": "Route the ACP model source through the same saved-endpoint overlay `resolveTuiStartup` uses, rather than a copy of the detection logic.",
    "evidence": "`shellModelSource` in src/commands/acp.ts built its provider list from `detectProviders` directly, with no saved-baseUrls overlay applied.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/acp.ts shellModelSource", "src/commands/shell.ts resolveTuiStartup"],
      "enumeration_method": "Enumerated every caller of `detectProviders` that builds a provider list a user-facing surface picks from: the TUI startup path (already applied the overlay) and the new ACP model source (did not)."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), `withSavedBaseUrls` is extracted in src/commands/shell.ts:2926 and applied at line 2914 (`detected: withSavedBaseUrls(detected, savedCfg)`), and `shellModelSource` in src/commands/acp.ts now calls the same overlay. Test: src/commands/acp.test.ts 'a saved per-provider endpoint (auth.json baseUrls)...' — bun test src/commands/acp.test.ts: passes, part of 36 pass / 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "withSavedBaseUrls shared between TUI startup and the ACP model source, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/roster.test.ts",
    "quote": "PROJECT_TOOL_NAMES",
    "problem": "AC3's roster pin was derived from iterating the live metaproject operations list rather than asserting a literal, hand-written set of tool names.",
    "impact": "A new metaproject operation added elsewhere in the codebase could silently widen what the ACP roster offers, with the test still passing because it recomputed its expectation from the same source it was meant to check.",
    "suggested_fix": "Pin the roster test against a literal array of tool names, so a new operation requires a deliberate test edit to be included.",
    "evidence": "The pre-fix AC3 assertion built its expected set from the same enumeration `buildProjectTools` uses, rather than a fixed list.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), src/acp/roster.test.ts:103 asserts `expect(withMeta.sort()).toEqual([...PROJECT_TOOL_NAMES].sort())` against a literal constant, plus a check that every pinned read-risk tool is a known read-only builtin/metaproject op. bun test src/acp/roster.test.ts: passes, part of 185 pass / 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the literal PROJECT_TOOL_NAMES pin in src/acp/roster.test.ts, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/commands.ts",
    "quote": "taken from that line alone, so an attachment's content never becomes",
    "problem": "Command parsing dropped trailing text on a multi-line prompt starting with a command, echoed back any attachment sent alongside a command, and did not react to session/cancel arriving mid-switch.",
    "impact": "A client sending a command plus extra text or an attachment got silently incomplete handling rather than a refusal explaining why, and a user who cancelled during /model had no way to stop the switch from completing anyway.",
    "suggested_fix": "Accept a command only when its first block is a single, non-indented text line; refuse (rather than silently drop) extra text or an attachment on a no-arg command; wire session/cancel into the /model bind so it aborts cleanly.",
    "evidence": "Pre-fix, multi-block prompts and trailing text past the first line were parsed inconsistently, and there was no cancel-aware path in the /model handler.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), src/acp/commands.ts requires a single-line, non-indented first text block, refuses extra text on a no-arg command and never echoes an attachment (line 116: '/${command.name} takes no attachments; nothing was done. Send the command on its own.'); src/acp/server.ts wires session/cancel into the /model bind so an in-flight switch aborts with nothing applied. bun test src/acp/commands.test.ts and project-tools.process.test.ts 'commands: one update after session/new, a / command never reaches the model, an unlisted one gets the list': part of 185 pass / 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "stricter single-line command parsing, attachment refusal and cancel-aware /model bind in src/acp/commands.ts and src/acp/server.ts, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/session.ts",
    "quote": "Set by `load()` only: the provider/model the durable session last ran, as",
    "problem": "session/load after an agent restart did not restore the model a session had been switched to; it reverted to the launch model even when the switched-to model was still a valid choice.",
    "impact": "A user who switched models mid-session and then reconnected after a restart would silently lose that choice with no explanation, having to re-issue /model.",
    "suggested_fix": "Read the recorded provider/model from the session summary before openSession overwrites it, and restore it on load when it is still an available choice; otherwise fall back to the launch model with a message saying why.",
    "evidence": "Pre-fix, session/load rebuilt the session from the launch configuration alone, with no read of the last-recorded provider/model.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), src/acp/session.ts:46 documents the field set by `load()` only ('the provider/model the durable session last ran'), read before openSession overwrites it; session/load restores it when still a valid choice, otherwise falls back to the launch model with an agent message saying why. bun test src/acp/session.test.ts and server-models.test.ts: part of 185 pass / 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the last-ran provider/model restore in src/acp/session.ts, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-006",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/server.ts",
    "quote": "LATER-started one has been applied already. So the later request wins when",
    "problem": "Two overlapping model switches were not ordered: if a later switch failed after an earlier one had already succeeded, the failure could discard the earlier success.",
    "impact": "A user issuing two rapid /model or set_config_option calls could end up on neither the model they successfully switched to nor the one they asked for last, with no indication of what happened.",
    "suggested_fix": "Give each switch an issued sequence number and only let a later request's outcome overwrite an earlier one's; a finished switch is applied only if no later-started one has been applied already.",
    "evidence": "Pre-fix, the switch handler applied whichever provider/model resolution finished last, regardless of which was issued last.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), src/acp/server.ts:441-442 documents the sequence-number rule ('takes a number when it starts; a finished one is applied only if no LATER-started one has been applied already. So the later request wins when...'). bun test src/acp/server-models.test.ts and project-tools.process.test.ts 'model: configOptions on session/new, switched by set_config_option and /model from the next turn, never mid-turn': part of 185 pass / 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the issued/applied sequence-number guard in src/acp/server.ts, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-007",
    "reviewer": "code-reviewer (acp, round 2)",
    "severity": "minor",
    "file": "src/acp/server.ts",
    "quote": "everything up to here is synchronous",
    "problem": "A comment describing the dispatcher's synchrony was stale after the T5-T12 changes, no longer matching the code it documented.",
    "impact": "A future reader trusting the comment could misjudge which parts of the request-handling path run synchronously versus after an await, risking a reintroduction of a timing bug the comment was meant to prevent.",
    "suggested_fix": "Correct the comment to match the current synchronous/asynchronous boundary.",
    "evidence": "The comment's description of what ran before the first await no longer matched the post-T5-T12 code path.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "At e633d4b9 (merged to main in bd1dbe96 via PR #651), src/acp/server.ts:780 and :925 now correctly describe the synchronous portion of the dispatch path ('Started in the background: everything up to here is synchronous', 'check synchronously here: dispatch starts every handler in wire order'), matching the current code. bun test src/acp/server-models.test.ts: part of 185 pass / 0 fail (bd1dbe96, merged PR #651).",
      "verifier": "round-2 (code-reviewer (acp))"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the corrected synchrony comment in src/acp/server.ts, commit e633d4b9; merged to main in bd1dbe96 via PR #651."
    }
  },
  {
    "id": "F-008",
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
      "evidence": "the single config_option_update push on late list arrival in src/acp/server.ts (task T15), commit c84e0991; merged to main in 93ac7a74 via PR #655."
    }
  }
]
```

## Coverage

Reviewed: the ACP project-tool roster and its gate (`buildProjectTools`, `offersIndexTools`),
the tool-kind mapping and roster pin, the available-commands advertisement and slash-command
handling, the model-selection configOptions/set_config_option/`/model` path including the
T14 hardening (bounded model-list probe, saved per-provider endpoints, cancel-aware switch,
sequence-numbered overlapping switches, session/load model restore) and the T15 late-list push,
the protocol types added for this flow, the process tests over a real stdio pipe, and the CLI
reference / README updates. Round 2 re-derived the model-list timeout path from source to check
for a live-push gap after the F-001 fix, rather than trusting the fix's own comment. Round 3
verified the T15 fix that closed that gap, against the new tests and the merged commit. Not
reviewed: the rest of the repository, unchanged by this flow.

## Outcome

Eight findings across three rounds, all acted on and re-verified refuted at their fix: the two
major and five minor findings from round 1 at `e633d4b9` (merged to main in `bd1dbe96` via PR
#651), and the one minor finding raised in round 2 (no late-arriving-model-list push) at `c84e0991`
(merged to main in `93ac7a74` via PR #655, a follow-up merge on top of the flow's `bd1dbe96` base).
No findings dismissed as incorrect, none left as an accepted limitation. CI 18/18 green on PR #651
at head `7e0809a2a2b170ded9d3ecf307e1c0f6f298a19a` and on PR #655 at head
`c84e0991d9a709e2455dcfb841ec04246ef81d3d`; `keryx health run`: PASS, project score 94, 0 gate
conditions triggered.
