# Flow 305 (PR #705) — closure review

Adversarial review of the routing-table feature (flow 305), two rounds, both
against the `feat/routing-table` branch, now squash-merged to `main` as
`31bab00fc167bc19ea212cd3eaf7e208ec0ca331` (last reviewed head
`97211c0ac30ffffdb593b454b5844fe3393942f8`). All findings below were raised
against that branch and are ingested here for closure, each carrying its own
verdict from a separate verification pass (see `--verifications`).

Two items from round 1 (read-modify-write races on the config writers; the
`keryx routing`/`/routing` placement under the "Connect a model provider"
help group) and two items from round 2 (a narrow connectivity-predicate edge
case when a provider's model list is empty; the pre-existing coupling between
AC10's connected-check and `resolveChildModel`'s G1 allowlist in
`spawn_subagent`) were raised, judged low-severity and not merge-blocking,
and accepted as informational limits by the operator rather than dispositioned
as findings requiring a code change. They are not carried into the
`keryx:findings` block below; they are recorded here in prose for the
record:

- **Read-modify-write races** (`src/harness/routing/config.ts`
  `setRoutingCategory`/`unsetRoutingCategory`, `src/lib/shell-config.ts`
  `saveShellConfig`): a load-then-save cycle with no lock; two concurrent
  `keryx routing set` calls (or a CLI write racing a TUI write) can lose one
  write. Matches the existing, pre-flow-305 pattern of every other
  `saveShellConfig` caller (`saveApiKey`, `saveProviderBaseUrl`,
  `saveProviderModelParams`); each individual write stays atomic
  (temp-file+rename, 0600). Accepted as a pre-existing limit, not a
  flow-305 regression.
- **HELP_GROUPS placement** (`src/standard/help-groups.ts`, `keryx routing`
  and `/routing` filed under "Connect a model provider"): a defensible but
  imperfect fit given the groups that exist today; accepted, revisit if the
  routing surface grows (classifier, `explain`, `profile`).
- **Connectivity-predicate edge case** (`src/harness/routing/table.ts`
  `connectedPredicateFrom`): when a connected provider's live/curated model
  list is empty or absent, any `modelId` for that provider passes AC10's
  check ("cannot refute a specific model id"), by design and tested
  (`table.test.ts`). Bounded to a real, already-connected provider; cannot
  name an arbitrary endpoint. Accepted as a known, narrow limit.
- **AC10/G1 coupling in `spawn_subagent`** (`src/harness/tool/builtin/spawn-subagent-tool.ts`,
  `src/harness/child/orchestrate.ts` `allowedProvidersFromDetected`): AC10's
  `connected` predicate and G1's allowlist are built from the same
  `getDetectedProviders()` array — a pre-existing coupling, not introduced
  by AC10. G1's "out of allowlist" branch is therefore no longer reachable
  through this specific call site (it now resolves to a graceful fallback
  instead); G1 itself remains independently covered by the unmodified
  `model.test.ts` unit suite, and G3 (classifiable, checked against the
  static provider registry) remains independently exercisable and is now
  what `spawn-subagent-tool.test.ts`'s AC7 regression test uses to prove the
  gate chain still runs unmodified. Accepted as adequate.

```json keryx:findings
{
  "status": "DONE",
  "reviewer": "flow305-pr705-adversarial-review",
  "summary": "Two-round adversarial review of flow 305's routing table (PR #705): AC1-AC9 read/write/CLI/TUI surface, then AC10 (connectivity fallback) and AC11 (project-table trust gate) added in response to round 1. 8 findings retained for the record, all fixed on the merged branch (commits 763f5668, 97211c0a) and confirmed at merge commit 31bab00fc167bc19ea212cd3eaf7e208ec0ca331; verdicts recorded separately via --verifications.",
  "findings": [
    {
      "id": "F-001",
      "global_id": "flow305-pr705-closure#F-001",
      "severity": "major",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "high",
      "problem": "PRD section 5's operator requirement ('a project entry that names a provider or model the user has not connected falls through to the user's entry for that category, and the modal says so') was written into docs/docs/cli-reference.md as already implemented, but resolveCategoryDetailed (table.ts), keryx routing list (routing.ts), the /routing modal (routing-inspector.ts), and review tier's applyReviewRoutingCategory (review.ts) all resolved a category by presence alone, with no check against the operator's actually-connected providers.",
      "impact": "An operator who connects only a subset of providers, with a project routing.config.json naming a provider they never connected, silently gets that unconnected provider/model as the resolved assignment instead of falling through as documented -- confirmed reproducible by review.test.ts's pre-fix AC5 case using providerId \"anthropic\"/modelId \"claude-routed\", neither of which existed in the test fixture's connected-provider set.",
      "suggested_fix": "Add a ConnectedPredicate parameter to resolveCategoryDetailed/resolveCategory, threaded from each call site's own already-fetched provider-detection result (no new network probe), so an assignment naming an unconnected provider/model is treated as unresolved at that layer and falls through to the next one, with a visible 'not connected, falling back to <resolved>' notice in the CLI and the modal.",
      "evidence": "src/harness/routing/table.ts (pre-fix): resolveCategoryDetailed took only (category, layers), no connectivity check anywhere in the precedence loop; grep across table.test.ts/routing.test.ts/routing-inspector.test.ts for \"connected\"/\"not connect\" found zero coverage of the unconnected-provider path at any of the four call sites.",
      "class_scope": {
        "sites": [
          "src/harness/routing/table.ts (resolveCategoryDetailed/resolveCategory)",
          "src/commands/routing.ts (runList)",
          "src/tui/routing-inspector.ts (routingCategoryRows/reload)",
          "src/commands/review.ts (applyReviewRoutingCategory)",
          "src/harness/tool/builtin/spawn-subagent-tool.ts (subagents category resolution)"
        ],
        "enumeration_method": "keryx ctx rg -n \"resolveCategory|resolveCategoryDetailed\" src --type ts, cross-checked against every production caller of loadRoutingConfig/loadRoutingConfigRaw before the AC10 fix landed; all five sites resolved a category with no connectivity argument."
      }
    },
    {
      "id": "F-002",
      "global_id": "flow305-pr705-closure#F-002",
      "severity": "blocker",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "high",
      "problem": "applyReviewRoutingCategory (src/commands/review.ts) took an explicit {kind:\"model\"} assignment from routing.config.json (a checked-in, attacker-controllable file in a cloned/forked repo) and unconditionally overwrote the review dispatch's provider/model with zero validation, zero gate (unlike subagents, which passes through resolveChildModel's G1/G2/G3), and zero operator confirmation -- then labelled the result tier_resolution: \"discovered\", the SAME value that means \"a specific model was actually found live via provider ranking\", making an unvalidated project-file override indistinguishable in output from a legitimately live-detected model.",
      "impact": "A malicious or merely mistaken routing.config.json in a cloned repository can silently redirect which model reviews that repository's own diff -- the exact 'review the reviewer' integrity attack the PRD's own trust design (section 5) exists to prevent -- with the CLI/JSON output actively misrepresenting the override as a routine discovery.",
      "suggested_fix": "Gate the review category's resolution the same way subagents' resolution is gated (AC10's connectivity check, and a project-table approval/trust mechanism per PRD section 5), and stop reusing tier_resolution: \"discovered\" for a routing override -- add a distinct, honestly-labelled field.",
      "evidence": "src/commands/review.ts (pre-fix) applyReviewRoutingCategory: `if (assignment.kind !== \"model\") return decision; return {...decision, provider: assignment.providerId, model: assignment.modelId, tier_resolution: \"discovered\"}` -- no call to any gate function, no connectivity check; review.test.ts's pre-fix AC5 test set providerId \"anthropic\"/modelId \"claude-routed\" (never detected in the fixture) via routing.config.json and asserted it won outright.",
      "class_scope": {
        "sites": [
          "src/commands/review.ts (applyReviewRoutingCategory)"
        ],
        "enumeration_method": "read every consumer of resolveCategory in src/commands/review.ts and src/harness/tool/builtin/spawn-subagent-tool.ts side by side; spawn-subagent-tool.ts already routed its result through resolveChildModel's gate chain, review.ts was the only one of the two wired categories (AC5/AC6) with no gate at all."
      }
    },
    {
      "id": "F-003",
      "global_id": "flow305-pr705-closure#F-003",
      "severity": "minor",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "high",
      "problem": "config.ts's own contract requires that a malformed routing.config.json or per-user entry be 'a named, surfaced error, never a silently empty table' for every caller, but applyReviewRoutingCategory (review.ts) and the subagents routing branch (spawn-subagent-tool.ts) destructured loadRoutingConfig's result and never read the .error field, unlike keryx routing list and the /routing modal, which both did.",
      "impact": "A malformed project or user routing config silently degrades to 'nothing configured' at the review and subagent-spawn call sites, with no diagnostic anywhere the operator would see it, even though the CLI and TUI would have surfaced the same error for a different command.",
      "suggested_fix": "Surface project.error/user.error at every call site, not only the CLI/TUI -- a non-fatal notice (console.error text, or a fleet system-log event for the sandboxed spawn path) that never blocks the command.",
      "evidence": "grep for `project.error`/`user.error`/`projectRouting.error`/`userRouting.error` across review.ts, spawn-subagent-tool.ts, routing.ts, routing-inspector.ts (pre-fix) matched only routing.ts and routing-inspector.ts; review.ts and spawn-subagent-tool.ts had zero matches."
    },
    {
      "id": "F-004",
      "global_id": "flow305-pr705-closure#F-004",
      "severity": "major",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "high",
      "problem": "applyReviewRoutingCategory (src/commands/review.ts, pre-fix) only branched on `assignment.kind !== \"model\"`, treating a {kind:\"provider-default\"} assignment identically to session-default (i.e. silently ignored), even though `keryx routing set review <provider>` (the no-slash provider-default form) is a documented, AC3-supported way to configure the review category and subagents already resolved provider-default correctly via resolveProviderDefaultModelId.",
      "impact": "An operator who runs `keryx routing set review <provider>` gets a CLI/TUI that reports the category as configured (`review -> <provider> (provider default) [user]`), while `keryx review tier` silently behaves as if nothing were set -- a configured-but-inert setting with no error or indication anything is wrong.",
      "suggested_fix": "Resolve provider-default for the review category the same way subagents already does, via resolveProviderDefaultModelId.",
      "evidence": "src/commands/review.ts (pre-fix): `if (assignment.kind !== \"model\") return decision;` -- no provider-default branch; review.test.ts's AC5 block (pre-fix) had zero tests exercising a provider-default assignment on the review category.",
      "class_scope": {
        "sites": [
          "src/commands/review.ts (applyReviewRoutingCategory)"
        ],
        "enumeration_method": "read applyReviewRoutingCategory's full kind-branch logic and compare against child-model-request.ts's categoryAssignmentToChildModelRequest, which handles all three CategoryAssignment kinds; review.ts's version handled only \"model\"."
      }
    },
    {
      "id": "F-005",
      "global_id": "flow305-pr705-closure#F-005",
      "severity": "minor",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "high",
      "problem": "src/commands/routing.ts's runSet/runUnset re-implemented the exact load-merge-save sequence src/harness/routing/config.ts already exports as setRoutingCategory/unsetRoutingCategory, instead of calling them.",
      "impact": "Two copies of the same read-modify-write logic; a future fix (locking, trust-gate interaction) applied to one copy and not the other would silently diverge between the CLI and any other caller of the shared helpers.",
      "suggested_fix": "Call setRoutingCategory/unsetRoutingCategory from routing.ts's runSet/runUnset instead of duplicating the merge.",
      "evidence": "src/commands/routing.ts (pre-fix) runSet: `const current = await loadRoutingConfig(layer, location); await saveRoutingConfig(layer, location, {...current.table, [category]: assignment});` -- identical in shape to config.ts's exported setRoutingCategory, never calling it."
    },
    {
      "id": "F-006",
      "global_id": "flow305-pr705-closure#F-006",
      "severity": "minor",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "medium",
      "problem": "src/tui/routing-inspector.ts's paintList carries a detailed guard against repainting into a destroyed TextRenderable when a theme change fires while the 'picker' tab is active, but routing-inspector.test.ts (pre-fix) had exactly one real interactive modal test over a 2-provider/4-model fixture, with no test simulating a theme change while on the picker tab, and no test at a realistic (hundreds-of-models) scale.",
      "impact": "The specific regression the paintList comment describes (a stale theme-change callback painting into a torn-down renderable) has no regression test pinning it, and the flat picker's behavior at the scale the feature is meant for (many connected providers/models) is unverified.",
      "suggested_fix": "Add a regression test that triggers a theme-change event while the picker tab is active, and a scale test over roughly 300 models confirming the filter stays correct and fast.",
      "evidence": "routing-inspector.test.ts (pre-fix): grep for '300'/'scale' and for a theme-change-while-picker-active scenario found neither; only one otuiTest existed, over FIXTURE_PROVIDERS with 2 providers and 4 models total."
    },
    {
      "id": "F-007",
      "global_id": "flow305-pr705-closure#F-007",
      "severity": "blocker",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "high",
      "problem": "src/harness/routing/config.ts's loadRoutingConfig (the single gated-resolution entry point every call site shares) skipped its AC11 trust-approval check entirely whenever the project file's validateRoutingConfig produced ANY error, even one unrelated to the entries actually in use -- `if (layer === \"user\" || raw.error !== undefined || Object.keys(raw.table).length === 0) { return raw; }` returned the raw, still-unapproved table (including every VALID entry that survived the partial parse) without ever calling isProjectRoutingApproved.",
      "impact": "A routing.config.json containing one valid, unapproved, attacker-chosen entry (e.g. review pointed at a weak or attacker-preferred model) PLUS one unrelated malformed/unknown-category line (which could be an innocent typo, not necessarily deliberate) caused the valid entry to take effect immediately with zero operator approval, completely defeating AC11's purpose ('a repository must not silently steer which model reviews its own diff') at every one of the four call sites sharing loadRoutingConfig.",
      "suggested_fix": "Run the trust check against raw.table whenever it is non-empty, independent of whether raw.error is also set; when unapproved, fold both the validation error and the trust notice into the returned error text so a malformed-entry notice keeps surfacing even once approved.",
      "evidence": "src/harness/routing/config.ts:181-190 (pre-fix, commit range prior to 97211c0a): the OR'd early-return condition on `raw.error !== undefined` bypassed `isProjectRoutingApproved` entirely on any partial-parse error; config.test.ts's malformed-file tests at that point only covered the case where nothing survived (table: {}), and no test combined a partial validation error with an unapproved trust state.",
      "class_scope": {
        "sites": [
          "src/harness/routing/config.ts:181-190 (loadRoutingConfig)"
        ],
        "enumeration_method": "keryx ctx rg -n \"from .*routing/config\" src across review.ts, spawn-subagent-tool.ts, routing.ts, routing-inspector.ts confirmed all four import loadRoutingConfig (not a per-caller copy) for gated resolution, so the one function at config.ts:181-190 is the exhaustive, single choke point for this bug."
      }
    },
    {
      "id": "F-008",
      "global_id": "flow305-pr705-closure#F-008",
      "severity": "minor",
      "reviewer": "flow305-pr705-adversarial-review",
      "confidence": "medium",
      "problem": "validateAssignment (src/harness/routing/config.ts, pre-fix) checked only kind/providerId/modelId presence and never rejected additional, undeclared fields on a category assignment object; `table[key] = value as CategoryAssignment` was a raw type cast, so an attacker-added extra field (e.g. a stray baseUrl) survived unmodified into the validated table. Nothing downstream read any field beyond the three typed ones at the time, so this was inert rather than exploitable, but the safety rested on 'nothing reads it today' rather than on validation rejecting it.",
      "impact": "A future reader of CategoryAssignment that destructures or spreads an extra field (rather than explicitly picking kind/providerId/modelId, as every current consumer does) would silently trust an unvalidated, attacker-influenced value with no schema check ever having refused it.",
      "suggested_fix": "Reject an assignment carrying a field its kind does not define, at validation time, rather than relying on every future reader to remember not to trust it.",
      "evidence": "src/harness/routing/config.ts (pre-fix) validateAssignment: only `providerId`/`modelId`/`kind` presence checks, no allowlist of permitted keys per kind; routingTableFingerprint's sortedAssignment used Object.entries(assignment), which does pick up an extra key (so the trust fingerprint itself was not fooled), but the value itself was never rejected."
    }
  ],
  "stats": { "blocker": 2, "major": 2, "minor": 4, "info": 0 }
}
```
