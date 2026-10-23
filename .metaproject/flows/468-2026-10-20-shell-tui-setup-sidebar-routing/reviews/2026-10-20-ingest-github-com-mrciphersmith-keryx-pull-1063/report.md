PR 1063, round 1 (head 9d4e72c4a770, base main): no blocker and no major; 16 minor and 7 info canonical findings, consolidated from 38 raw findings by 9 reviewers in 2 waves.

Stage counts:
- Pre-filter: scope.json, 22 files.
- Verifier: 1 finding checked, review-testing-practices-w2:F-004, downgraded major -> minor because the flake did not reproduce in 30 runs under load.
- Mutation pass: 15 + M-4. Killed M-4, M-5, M-6, M-13, M-14, M-15. Survived M-1, M-2, M-3, M-7..M-12, raising C-12..C-16 to minor.
- Premise judge: 13 upheld, 2 challenged (C-05, C-11), 1 owner decision (C-07).
- Operator decisions: C-05 dismissed; C-07 and C-11 upheld.
- Closed without a canonical finding: 2 refuted (testing context not in the PR head), 3 out of scope (pre-existing).

Not run: none. Blast-radius tests: 84 files, 1971 pass, 0 fail.

## Minor

- **C-01** (minor, review-clean-code) src/tui/routing-inspector.ts: Intent hidden behind a sentinel (Clean Code A1, B2).
- **C-02** (minor, review-clean-code) src/harness/provider-catalog.ts: Stale doc comment (Clean Code C1a).
- **C-03** (minor, review-architecture) src/harness/routing/table.ts: Whether an assignment is 'not connected' is decided by the predicate that `connectedPredicateFrom` returns (including its `isDeniedModel` check, the session shortcut and, in `spawn-subagent-tool.ts`, the `externalAllowedConnectedPredicate` wrapper).
- **C-04** (minor, review-clean-code) src/harness/routing/table.ts: Function size and mixed abstraction (Clean Code B1).
- **C-05** (minor, review-architecture) src/tui/tui-shell.ts: Because a zero-provider catalog is now never saved, the cache stays empty for as long as nothing is connected, and every reader that falls back to `redetect` repeats the full detection plus per-provider refresh.
- **C-06** (minor, review-logic) src/harness/provider-catalog.ts: A refresh that yields zero providers is not saved (`if (hasProviders(fresh)) await saveProviderCatalogCache(...)`, here and at line 269).
- **C-07** (minor, review-logic) src/harness/routing/table.ts: `describeNotConnectedReason` treats 'no non-auth-failed provider in the list' as 'provider list unavailable', and an assignment to an auth-failed provider as 'provider not connected'.
- **C-08** (minor, review-logic) src/tui/routing-classifier-source.ts: `loadRoutingProviders` now always returns `withAuthFailed: true` entries (`{name, models: [], authFailed: true}`).
- **C-09** (minor, review-logic) src/harness/provider-catalog.ts: `catalogToFlatPickerProviders` now surfaces `auth-failed` entries (with `withAuthFailed`), but an `unreachable`, `timeout` or `not-supported` entry whose `fallbackModels` is empty is still dropped without a trace.
- **C-10** (minor, review-clean-code) src/harness/provider-catalog.test.ts: Flow 468 reuses the labels AC1 and AC2 for its new tests in a file where flow 309's tests already use the same labels for different criteria (e.g.
- **C-11** (minor, review-testing-practices) src/tui/routing-inspector.test.ts: The AC4 hang test decides on a fixed `await new Promise((resolve) => setTimeout(resolve, 500))` followed by `settle(chrome)`.
- **C-12** (minor, review-testing-practices) src/harness/provider-catalog.ts: The `detected.length === 0` half of the redetect gate is unpinned.
- **C-13** (minor, review-testing-practices) src/harness/routing/table.ts: The session-pair branches in table.ts are pinned only at their two extremes.
- **C-14** (minor, review-testing-practices) src/tui/routing-inspector.ts: The outer catch in `reload()`, `loadError`, and the 'routing table unavailable: <reason>' list state have no test.
- **C-15** (minor, review-testing-practices) src/tui/routing-inspector.ts: The Model-tab note tests assert presence only.
- **C-16** (minor, review-testing-practices) src/tui/routing-inspector.ts: Every added AC3/AC4 test injects `providers:`; none goes through the default loader.

## Info

- **C-17** (info, review-testing-practices) src/tui/routing-inspector.ts: The hang test pins only that 'Reading routing table…' is gone.
- **C-18** (info, review-security-code) src/tui/routing-inspector.ts: The provider-loader failure reason (error.message) is placed verbatim into the Model tab status row `model list unavailable (<reason>)` and into `routing: <reason>`.
- **C-19** (info, review-logic) src/tui/routing-inspector.ts: Observation, not proven: the picker's list height subtracts `notes.length`, one row per note, but each note is a free-text line (`model list unavailable (${providersError})`, `<provider>: auth failed - ...`) added to one multi-line TextRenderable.
- **C-20** (info, review-style) src/harness/provider-catalog.test.ts: The new import of ../commands/shell sits before the existing ../commands/select import, so the project-relative group is no longer alphabetical (select < shell).
- **C-21** (info, review-style) src/tui/routing-inspector.test.ts: The new test block header is written in the red-first voice ('Assumed seams', 'FlatPickerProvider.authFailed?: true', 'RoutingModalOptions.timeoutMs bounds...') but the seams now exist in the same PR.
- **C-22** (info, review-style) src/tui/tui-shell.ts: The flow 468 comment was inserted between the existing comment block and the declaration it describes.
- **C-23** (info, review-testing-practices) src/tui/provider-catalog-startup.test.ts: The PR body says the source-text assertion in provider-catalog-startup.test.ts is now a behavioural one.

```json keryx:findings
[
  {
    "id": "C-01",
    "severity": "minor",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "await loadOrRefreshProviderCatalogFromDetected([], { ...deps, redetect })",
    "problem": "Intent hidden behind a sentinel (Clean Code A1, B2). To get 'serve a fresh non-empty cache, else detect live', loadRoutingProviders calls a function named FromDetected with a dummy empty array and relies on the undocumented convention in refreshProviderCatalogFromDetected that an empty detected list plus a redetect dependency means 'detect for me'. The reader sees 'from detected' with nothing detected. The same convention makes a caller that genuinely detected no providers trigger a second live detection.",
    "impact": "Maintenance cost: the behaviour depends on a coincidence between two files, and the empty array argument reads as a bug. A later change to the sentinel rule silently changes the /routing loading path.",
    "suggested_fix": "Give the intent a name: either have loadOrRefreshProviderCatalog accept redetect in its deps and use it as its detection source (so no dummy list is passed), or add a small live-detection wrapper. At minimum, name the constant for the empty list with a comment.",
    "evidence": "slice-02 hunk 'src/tui/routing-inspector.ts @@ 190,332' end (loadRoutingProviders) against hunk 'src/harness/provider-catalog.ts @@ 197,310' (the list constant chosen by detected.length === 0 and deps.redetect !== undefined).",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "dedupe_key": "routing-inspector.ts:empty-list-sentinel",
    "merged_from": [
      "review-clean-code-w2:F-005",
      "review-architecture-w1:F-002"
    ]
  },
  {
    "id": "C-02",
    "severity": "minor",
    "file": "src/harness/provider-catalog.ts",
    "line": null,
    "quote": "excluded outright rather than",
    "problem": "Stale doc comment (Clean Code C1a). The docblock of catalogToFlatPickerProviders still says an auth-failed provider is 'excluded outright rather than shown with models that are not actually available'. The diff adds the withAuthFailed option, which makes the function return exactly such an entry (name, empty models, authFailed true), and loadRoutingProviders now always passes it. The block comment describes the default only.",
    "impact": "Maintenance cost only: a reader trusting the docblock will conclude /routing never sees auth-failed providers, and will not look for the FlatPickerProvider.authFailed handling that every consumer now needs.",
    "suggested_fix": "Extend the docblock: an auth-failed provider is excluded by default; with withAuthFailed true it is returned with no models and authFailed true, for display only.",
    "evidence": "slice-02 hunk 'src/harness/provider-catalog.ts @@ 197,310': the unchanged docblock sits directly above the changed signature catalogToFlatPickerProviders(catalog, opts: { withAuthFailed?: boolean } = {}); the only caller shown that opts in is loadRoutingProviders in routing-inspector.ts.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "provider-catalog.ts:catalogToFlatPickerProviders-doc-stale",
    "merged_from": [
      "review-clean-code-w2:F-003"
    ]
  },
  {
    "id": "C-03",
    "severity": "minor",
    "file": "src/harness/routing/table.ts",
    "line": null,
    "quote": "export function describeNotConnectedReason(assignment: CategoryAssignment, providers: readonly FlatPickerProvider[]): string {",
    "problem": "Whether an assignment is 'not connected' is decided by the predicate that `connectedPredicateFrom` returns (including its `isDeniedModel` check, the session shortcut and, in `spawn-subagent-tool.ts`, the `externalAllowedConnectedPredicate` wrapper). The reason text is decided by a second function, `describeNotConnectedReason`, which re-derives the cause from the provider list with its own rules (empty list, provider absent, model absent) and ignores the denied-model, session and external-block rules. The two can disagree: a denied model, or an external-blocked provider that is present in the list with the model listed, falls through to the generic 'not connected', and a rule added to the predicate later gets no matching reason.",
    "impact": "The reason is advisory and the generic fallback keeps the text honest, so nothing wrong is shown today. The cost is drift: the verdict and its explanation live in two places that must be edited together. `describeRejectionNotice` takes `providers` as an optional argument, so a caller can also pass a list that is not the one the verdict was made against.",
    "suggested_fix": "Have the predicate side expose the reason, for example a `connectedVerdict(providerId, modelId): 'ok' | 'list-unavailable' | 'provider-absent' | 'model-absent' | 'denied'` that `connectedPredicateFrom` and `describeNotConnectedReason` both read. Failing that, add a comment on `connectedPredicateFrom` saying the reason function mirrors it.",
    "evidence": "table.ts hunk at slice-02 lines 197-217 (predicate: auth-failed filter, session shortcut, `isDeniedModel`, model-in-list) versus lines 247-258 (reason: `live.length === 0`, `provider === undefined`, model-in-list; no denied-model or session branch). spawn-subagent-tool.ts hunk lines 373-377 wraps the predicate in `externalAllowedConnectedPredicate`, which the reason function cannot see. No test in the slice pins a denied or external-blocked model's notice.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "dedupe_key": "arch:connected-verdict-and-reason-split",
    "blocking_merge": false,
    "location_class": "in-diff",
    "merged_from": [
      "review-architecture-w2:F-006",
      "review-clean-code-w2:F-004"
    ]
  },
  {
    "id": "C-04",
    "severity": "minor",
    "file": "src/harness/routing/table.ts",
    "line": null,
    "quote": "export function flatModelOptions(providers: readonly FlatPickerProvider[], session?: SessionModelRef): FlatModelOption[] {",
    "problem": "Function size and mixed abstraction (Clean Code B1). flatModelOptions now runs about 35 lines and interleaves four concerns in one body: the session-default row, injecting the session's own model when the catalog lacks it (a local sessionSuffix constant plus an isSessionModel closure), skipping auth-failed providers, and building provider-default and per-model rows with the offline and current-session suffixes composed inline in a template literal.",
    "impact": "Maintenance cost: the next row kind or suffix lands in the same body, and the label template combining offlineSuffix and the session suffix is already hard to scan.",
    "suggested_fix": "Extract a sessionModelOption(session) helper returning the injected row, and a modelLabel(provider, modelId, session) helper for the suffix composition; keep flatModelOptions as the loop that assembles them.",
    "evidence": "slice-02 hunk 'src/harness/routing/table.ts @@ 333,395', lines added at flatModelOptions: sessionSuffix, isSessionModel, the injected options.push, the authFailed continue, the composed label.",
    "confidence": "low",
    "reviewer": "review-clean-code",
    "dedupe_key": "table.ts:flatModelOptions-size",
    "merged_from": [
      "review-clean-code-w2:F-006"
    ]
  },
  {
    "id": "C-05",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "line": null,
    "quote": "providers: () => loadRoutingProviders(opts.redetect),",
    "problem": "Because a zero-provider catalog is now never saved, the cache stays empty for as long as nothing is connected, and every reader that falls back to `redetect` repeats the full detection plus per-provider refresh. The per-turn classifier loader is one such reader (it now passes `opts.redetect`), so the 'empty cache' state is retried on each classified turn instead of once per TTL. The negative result has no cache of its own.",
    "impact": "Only reachable when detection really finds no provider, or finds providers that all fail to list models (so none are saved). In that state each turn pays up to the catalog's 8s per-provider bound plus the ollama probe. Not a correctness failure and a narrow state; it belongs to the highload and performance reviewers to size. Raised here because the cause is where the cache-negative policy sits (every reader versus the cache module).",
    "suggested_fix": "Keep the 'never serve an empty catalog as fresh' rule but record a short negative marker (for example an in-memory 'last empty refresh at' timestamp in the catalog module) so repeated callers within a few seconds do not each run a live detection; or give the classifier loader a cache-only path as before.",
    "evidence": "provider-catalog.ts `loadOrRefreshProviderCatalog*`: `if (hasProviders(fresh)) await saveProviderCatalogCache(...)` and `isServableCatalog` requiring `hasProviders`; tui-shell.ts diff hunk at ~9985 in commit 1136271ed changing the classifier `providers` loader to `() => loadRoutingProviders(opts.redetect)`; T6.json behavior_changes entry 3 (operator accepted as not operator-visible).",
    "confidence": "low",
    "reviewer": "review-architecture",
    "dedupe_key": "arch:negative-cache-repeated-redetect",
    "blocking_merge": false,
    "location_class": "in-diff",
    "merged_from": [
      "review-architecture-w1:F-003",
      "review-highload-w1:F-001",
      "review-logic-w1:F-004",
      "review-logic-w2:F-103",
      "review-performance-w1:F-001",
      "review-performance-w2:F-001"
    ]
  },
  {
    "id": "C-06",
    "severity": "minor",
    "file": "src/harness/provider-catalog.ts",
    "line": 243,
    "quote": null,
    "problem": "A refresh that yields zero providers is not saved (`if (hasProviders(fresh)) await saveProviderCatalogCache(...)`, here and at line 269). The previously cached non-empty catalog therefore stays on disk and is still served as fresh by `isServableCatalog` until its own 5-minute TTL lapses. This also holds for `force: true`.",
    "impact": "Disconnect the last provider (`keryx providers remove <p>`, which does not touch the cache) within 5 minutes of a prior refresh, then run `keryx providers status --refresh`. That call prints 'none', but the stale entry is still on disk. `/routing` opened afterwards lists the removed provider with its models until the TTL ends. Before this PR the empty result overwrote the file. The window is at most 5 minutes and only for the last provider.",
    "suggested_fix": "On an empty refresh, drop a stale cache rather than keep it: delete the cache file, or write it with a `fetchedAt` of 0 so `isCatalogFresh` is false. Alternatively, for `force: true` only, save the empty result; the 'never served as fresh' rule is already enforced on the read side by `isServableCatalog`.",
    "evidence": "provider-catalog.ts:243 and :269 skip the save on an empty result; provider-catalog.ts:263-266 and :237-240 serve `cached` when `hasProviders(cached) && isCatalogFresh(cached)`; commands/providers.ts:1513-1517 calls `loadOrRefreshProviderCatalog` with `force` and shows the in-memory result only. grep for catalog-cache writers (`saveProviderCatalogCache`, `updateProviderCatalogEntry`) shows no invalidation on `providers remove`.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "merged_from": [
      "review-logic-w1:F-001"
    ]
  },
  {
    "id": "C-07",
    "severity": "minor",
    "file": "src/harness/routing/table.ts",
    "line": 268,
    "quote": "if (live.length === 0) return \"provider list unavailable\";",
    "problem": "`describeNotConnectedReason` treats 'no non-auth-failed provider in the list' as 'provider list unavailable', and an assignment to an auth-failed provider as 'provider not connected'. It cannot tell apart: (a) the loader failed or timed out, (b) the loader succeeded and found zero providers, (c) every provider is auth-failed, (d) the assignment's provider is the auth-failed one. The function never sees `providersError`.",
    "impact": "Case (b): the Model tab says 'no providers connected - add one with /connect', while the Categories tab says 'provider list unavailable' for the same state. Case (c): the Model tab says 'auth failed - /connect', but a category says 'provider list unavailable'. Case (d): it says 'provider not connected' although the real cause is the rejected credential. AC4 asks for each failure to have its own visible text, and these labels contradict the status rows above them. Test 18 pins the empty-list wording deliberately, so this is a labelling gap, not a crash.",
    "suggested_fix": "Pass the loader error (or a tri-state: error / empty / listed) into `describeRejectionNotice` and `describeNotConnectedReason`. Return 'provider list unavailable' only when the load failed, 'no providers connected' for a successful empty list, and 'provider auth failed' when the assignment's provider is present with `authFailed`.",
    "evidence": "table.ts:268-280 filters `authFailed` out before the emptiness check; routing-inspector.ts keeps `providersError` separate and only uses it in `modelTabNotes`; `formatRoutingListLines` passes `providers` only.",
    "confidence": "high",
    "reviewer": "review-logic",
    "merged_from": [
      "review-logic-w1:F-002"
    ]
  },
  {
    "id": "C-08",
    "severity": "minor",
    "file": "src/tui/routing-classifier-source.ts",
    "line": 215,
    "quote": "const sessionProvider = providers.find((p) => p.name === opts.sessionProvider);",
    "problem": "`loadRoutingProviders` now always returns `withAuthFailed: true` entries (`{name, models: [], authFailed: true}`). Two readers outside the Model tab take `providers.find(session provider)?.models ?? [sessionModel]`. For an auth-failed session provider the lookup now hits and yields `[]` instead of falling through to `[sessionModel]`, so `deriveDefaultTable` is built from zero models.",
    "impact": "When the session's own provider is in the catalog as `auth-failed` (for example an expired OAuth grant while the session still runs), the per-turn classifier (when routing is on) and the `/routing` Categories tab derive an empty `derived` layer. Every category falls to `session-default` where it previously derived from the session model. Narrow trigger and a mild outcome; the pre-existing classifier loader used the same function and gets the changed list through `tui-shell.ts:9988`.",
    "suggested_fix": "Either keep `withAuthFailed` to the `/routing` modal's own loader and leave `loadRoutingProviders()` default as before, or make the two session lookups skip `authFailed` entries: `providers.find((p) => p.name === x && p.authFailed !== true)`.",
    "evidence": "routing-inspector.ts:536-544 (`catalogToFlatPickerProviders(catalog, { withAuthFailed: true })` is unconditional in `loadRoutingProviders`); tui-shell.ts:9988 reuses `loadRoutingProviders(opts.redetect)` for the classifier; routing-classifier-source.ts:215-217 and routing-inspector.ts (reload: `providers.find(...)?.models ?? [options.session.modelId]`). `selectClassifierModel` is unaffected (empty `models`, no loop body).",
    "confidence": "medium",
    "reviewer": "review-logic",
    "merged_from": [
      "review-logic-w1:F-003",
      "review-architecture-w2:F-007",
      "review-architecture-w1:F-005"
    ]
  },
  {
    "id": "C-09",
    "severity": "minor",
    "file": "src/harness/provider-catalog.ts",
    "line": null,
    "quote": "    // unreachable | timeout | not-supported\n    if (entry.fallbackModels.length > 0) {\n      out.push({ name: entry.name, models: entry.fallbackModels, offline: true });\n    }",
    "problem": "`catalogToFlatPickerProviders` now surfaces `auth-failed` entries (with `withAuthFailed`), but an `unreachable`, `timeout` or `not-supported` entry whose `fallbackModels` is empty is still dropped without a trace. `modelTabNotes` only knows the whole-loader error, an empty list, `authFailed` and `models.length === 0` on entries that were pushed, so this provider gets no status row. A category assigned to it then reads 'provider not connected' (`describeNotConnectedReason`: the provider is absent from a non-empty list).",
    "impact": "A user-registered OpenAI-compatible provider (registry `models` empty) or an ollama-style endpoint whose live model fetch times out is connected and has a key, but the Model tab shows nothing for it and a saved assignment says 'provider not connected'. That is the silent-omission shape AC4 forbids ('each failure shows its own visible text'), now covering auth failure but not unreachable/timeout. Narrow trigger (no curated list); the wrong text only misleads, no data is lost.",
    "suggested_fix": "In the `unreachable | timeout | not-supported` branch push `{ name, models: [], unreachable: true }` (or reuse the `authFailed` marker generalised to a `statusNote`) when `fallbackModels` is empty, and have `modelTabNotes` print `<provider>: unreachable - <describeCatalogStatus>`; keep it non-selectable like the auth-failed row. Pass the same list to `describeNotConnectedReason` so the category says why.",
    "evidence": "slice-02 provider-catalog.ts hunk 'catalogToFlatPickerProviders': the `fallbackModels.length > 0` guard is unchanged and only `auth-failed` gained an opt-in row. provider-catalog.ts:116-175 (read in repo): registry providers set `fallbackModels: [...registry.models]`, and `status` is `unreachable`/`timeout` whenever the live fetch fails; custom providers can have an empty `models`. routing-inspector.ts `modelTabNotes` (slice-02) has no branch for it.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "merged_from": [
      "review-logic-w2:F-101"
    ]
  },
  {
    "id": "C-10",
    "severity": "minor",
    "file": "src/harness/provider-catalog.test.ts",
    "line": null,
    "quote": "test(\"AC1: a shell that starts with a saved provider+model (startup detected is empty) still saves a catalog holding every provider with a stored key\"",
    "problem": "Flow 468 reuses the labels AC1 and AC2 for its new tests in a file where flow 309's tests already use the same labels for different criteria (e.g. 'refreshProviderCatalog (AC1): an unconnected OpenAI-compat provider ...', 'refreshProviderCatalog (AC1): a 401 classifies as auth-failed ...'). One name, two meanings, in the same file (Clean Code A3, consistent vocabulary). The file header still documents only flow 309's AC numbering.",
    "impact": "The flow's own verify command `bun test src/harness/provider-catalog.test.ts ... -t AC1` (and `-t AC2`) also selects flow 309's AC1/AC2 tests, so the criterion's command does not isolate the tests that prove it, and a reader grepping 'AC1' lands on two unrelated criteria. Maintenance cost only; no wrong runtime behaviour.",
    "suggested_fix": "Prefix the new titles with the flow, e.g. 'flow 468 AC1: ...' and 'flow 468 AC2: ...' (provider-catalog-startup.test.ts already does 'flow 468 AC1'), and update the verify commands in acceptance-criteria.md to the same pattern, or add a one-line note to the file header that AC labels below the flow 468 banner belong to flow 468.",
    "evidence": "Diff hunk 'src/harness/provider-catalog.test.ts @@ 314,437': new tests titled 'AC1: ...' and four titled 'AC2: ...'. Existing titles at src/harness/provider-catalog.test.ts lines 56 and 82 use '(AC1)'. acceptance-criteria.md AC1/AC2 verify commands use `-t AC1` / `-t AC2` on this same file.",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "dedupe_key": "provider-catalog.test.ts:ac-label-collision",
    "merged_from": [
      "review-clean-code-w1:F-001",
      "review-style-w2:F-002"
    ]
  },
  {
    "id": "C-11",
    "severity": "minor",
    "file": "src/tui/routing-inspector.test.ts",
    "line": null,
    "quote": "// Generous wall-clock margin over the 30ms bound; the modal must have given up by then.",
    "problem": "The AC4 hang test decides on a fixed `await new Promise((resolve) => setTimeout(resolve, 500))` followed by `settle(chrome)`. It waits for the absence of 'Reading routing table…' on wall-clock time instead of on a predicate or on `handle.ready`. `reload()` can no longer reject (loadProvidersBounded absorbs the failure), so `await handle.ready` is a deterministic, bounded wait here: it settles right after the 30 ms timeout fires and the two config loads and paint finish. If the gate is deleted, `ready` never settles and the test hits its own timeout, which is the correct red.",
    "impact": "On a loaded CI runner the 30 ms timer plus two disk loads and a render must complete within 500 ms. When they do not, the test goes red on a correct implementation. The repository already records load-induced timeout flakes in the full suite (memory: test-suite-timeout-flakes). The opposite direction costs time: on a fast machine every run pays the full 500 ms.",
    "suggested_fix": "Replace the sleep with `await handle!.ready;` (reload never rejects now) and keep the two negative assertions. Add one positive assertion from the same state, for example `expect(handle!.visibleLines().length).toBeGreaterThan(0)` with a category row such as 'default' present, so the absence of 'Reading routing table…' is not the only artifact.",
    "evidence": "slice-02.diff, hang test body (setTimeout 500 right after openRouting with timeoutMs: 30). The rule: browser/E2E determinism, 'No fixed sleeps; wait on assertions, events, responses, or polling predicates'. `ready = reload()` is returned by openRouting (routing-inspector.ts, `const ready = reload();`) and `reload` wraps `reloadUnguarded` in try/catch. | orchestrator: verifier downgraded major -> minor: the fixed sleep is real, the flake did not reproduce (30/30 pass under concurrent load, research-evidence/verify-review-testing-practices-w2_F-004-1.txt; raw/review-verifier.txt)",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:routing-hang-test-fixed-sleep",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/tui/routing-inspector.test.ts: AC4 'a provider loader that NEVER resolves' test, setTimeout(resolve, 500)"
      ],
      "enumeration_method": "Read every added test in slice-02.diff (11 AC3/AC4 tests); only this one uses a wall-clock wait, the other ten use settle(chrome) after `await handle.ready` or openModelTab. A repo-wide sleep grep was not possible (no search tool in this run); the claim is limited to the added tests."
    },
    "merged_from": [
      "review-testing-practices-w2:F-004"
    ]
  },
  {
    "id": "C-12",
    "severity": "minor",
    "file": "src/harness/provider-catalog.ts",
    "line": null,
    "quote": "const list = detected.length === 0 && deps.redetect !== undefined ? await deps.redetect() : detected;",
    "problem": "The `detected.length === 0` half of the redetect gate is unpinned. Every test that passes `redetect` (provider-catalog.test.ts AC1, provider-catalog-startup.test.ts flow 468 AC1) passes an empty `detected`; every test that passes a non-empty `detected` passes no `redetect`. No fixture builds the input that separates 'empty list, so redetect' from 'any list, so redetect'. Predicted, not run: deleting `detected.length === 0 &&` leaves the suite green. The other half, `deps.redetect !== undefined`, is covered, because tests with an empty detected list and no redetect would throw on `deps.redetect()`.",
    "impact": "The docstring above the function (provider-catalog.ts, 'Two callers need this split') says a second detection re-runs the same ollama /api/tags probe for no reason. With the half deleted, a startup that already holds a non-empty `detected` would detect twice, and no test says so. The code is correct today; the next edit to this line is unprotected. This is the gate the fix added.",
    "suggested_fix": "Add one test: loadOrRefreshProviderCatalogFromDetected with a non-empty detected list and a redetect spy, then expect the spy called 0 times and the catalog built from the passed list.",
    "evidence": "Read of provider-catalog.test.ts (AC1, AC2 x4) and provider-catalog-startup.test.ts (flow 468 AC1). Mutation not executed (exec_budget_s 0); listed in mutant_candidates M-1. | orchestrator: mutation M-1 survived (research-evidence/mutation-1.md); the reviewer's rule raises an unpinned gate to minor once a survivor is observed",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:redetect-nonempty-detected-unpinned",
    "location_class": "in-diff",
    "merged_from": [
      "review-testing-practices-w1:F-001"
    ]
  },
  {
    "id": "C-13",
    "severity": "minor",
    "file": "src/harness/routing/table.ts",
    "line": null,
    "quote": "if (session !== undefined && !providers.some((p) => p.name === session.providerId && (p.models ?? []).includes(session.modelId))) {",
    "problem": "The session-pair branches in table.ts are pinned only at their two extremes. table.test.ts AC3 drives (a) the session provider absent from the list and (b) the session provider and model both present. The middle case, which is the one AC3 names ('even when the catalog lacks them'), is not driven: the provider is in the list but its models do not include the session model, for example a live openai-codex list that omits the session's model. Predicted, not run: replacing the `.some(...)` predicate with `p.name === session.providerId` suppresses the (current session) row in that case and the suite stays green, because test 3 has no such provider and test 4 has the model. Same shape in `connectedPredicateFrom`: `(modelId === undefined || modelId === session.modelId)` has no test for the session provider with a different model id, and no test pins that an auth-failed session provider is still counted as connected, although the session check runs before the authFailed filter's absence from byName.",
    "impact": "A regression here shows up as the session's own model missing from the picker, or being treated as unconnected, on exactly the real-world catalog shape (a live list that does not contain the session model). Nothing in the suite would fail.",
    "suggested_fix": "Add to table.test.ts: flatModelOptions with providers [{name: 'openai-codex', models: ['gpt-other']}] and SESSION, expecting one '(current session)' row for gpt-test. Add connectedPredicateFrom cases for (session provider, other model) and (session provider listed as authFailed), stating the intended answers.",
    "evidence": "Read of table.test.ts lines for AC3 (four tests) against table.ts flatModelOptions and connectedPredicateFrom. Mutations not executed; listed in mutant_candidates M-2 and M-3. | orchestrator: mutations M-2 and M-3 survived (research-evidence/mutation-1.md)",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:session-pair-boundaries-unpinned",
    "location_class": "in-diff",
    "merged_from": [
      "review-testing-practices-w1:F-002"
    ]
  },
  {
    "id": "C-14",
    "severity": "minor",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "statusText = `routing: ${loadError}`;",
    "problem": "The outer catch in `reload()`, `loadError`, and the 'routing table unavailable: <reason>' list state have no test. The test titled 'a REJECTING provider loader leaves `Reading routing table…`' exercises loadProvidersBounded's catch (the loader error becomes `providersError` and an empty list), not the outer catch: nothing makes `load('project'|'user', …)` reject. Predicted, not run: replacing the catch body with `throw error;` leaves the suite green. In addition, `openModelTab` and the reject test call `handle.ready.catch(() => undefined)`, which would hide a rejecting `ready` if the catch were removed; reload() is documented as never rejecting.",
    "impact": "The case the PR body promises ('can no longer stick on Reading routing table…') for a failing config read is unpinned. A later edit that drops the outer catch makes a corrupt or unreadable routing file stick the modal on 'Reading routing table…' again with no red test. The code is correct today.",
    "suggested_fix": "Add one test with `load: async () => { throw new Error('config unreadable'); }` and assert `visibleLines()` contains 'routing table unavailable: config unreadable' and not 'Reading routing table…'. Drop the `.catch(() => undefined)` on `ready` in those tests, so a rejection fails loudly.",
    "evidence": "Read of slice-02.diff: reload() try/catch around reloadUnguarded; all 11 added tests pass `providers`, none pass `load`. Mutation not executed (exec_budget_s 0); listed as M-7. | orchestrator: mutation M-7 survived (research-evidence/mutation-1.md)",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:reload-outer-catch-unpinned",
    "location_class": "in-diff",
    "merged_from": [
      "review-testing-practices-w2:F-005"
    ]
  },
  {
    "id": "C-15",
    "severity": "minor",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "else if ((provider.models ?? []).length === 0) notes.push(`${provider.name}: 0 models`);",
    "problem": "The Model-tab note tests assert presence only. The states test checks that a 'beta … auth failed' line and a 'gamma … 0 models' line exist; it never checks that beta is NOT also reported as '0 models', that the healthy provider alpha has no note, or (in the unavailable test) that 'no providers connected' is absent next to 'model list unavailable'. Predicted, not run: (a) dropping the `else` before `if (provider.authFailed…)`'s sibling, (b) turning the `0 models` condition into `true`, and (c) turning `else if (providers.length === 0)` into a plain `if` each leave the suite green. In (c) the unavailable test would show both notes, which tells the operator the opposite of the truth ('no providers connected' while the catalog is down).",
    "impact": "Each variant is a visible wrong line on the operator's screen. The behaviour is correct today; the cost is that the next edit to modelTabNotes is unprotected, and the PR's own 'each failure as its own status row' claim is only half pinned.",
    "suggested_fix": "Add three absence assertions to the existing tests: no 'alpha:' line and no 'beta: 0 models' in the states test; `not.toContain('no providers connected')` in the unavailable test.",
    "evidence": "Read of the AC4 states test and the unavailable test in slice-02.diff against modelTabNotes. Mutations not executed; listed as M-8, M-9, M-10. | orchestrator: mutations M-8, M-9 and M-10 survived (research-evidence/mutation-1.md)",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:model-tab-notes-presence-only",
    "location_class": "in-diff",
    "merged_from": [
      "review-testing-practices-w2:F-006"
    ]
  },
  {
    "id": "C-16",
    "severity": "minor",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "return catalogToFlatPickerProviders(catalog, { withAuthFailed: true });",
    "problem": "Every added AC3/AC4 test injects `providers:`; none goes through the default loader. So `loadRoutingProviders(redetect)` (the branch to loadOrRefreshProviderCatalogFromDetected([], { …deps, redetect })), the `withAuthFailed: true` opt-in, and the two tui-shell.ts pass-throughs (`showRouting`'s `...(opts.redetect …)` and the classifier's `providers: () => loadRoutingProviders(opts.redetect)`) are exercised by no test in this slice. The auth-failed fixture (`models: [], authFailed: true`) is hand-built; its producer is catalogToFlatPickerProviders with the opt-in, and that link is untested here. Likewise 'listed, not selectable' for an auth-failed provider has no assertion on `pickerOptions()` in this slice (the test checks the note only). I could not search the rest of the test tree for a caller of loadRoutingProviders (no search tool in this run), so a test outside the slice may exist; table.test.ts and provider-catalog.test.ts are slice-01. Predicted, not run: dropping the opt-in, or the `continue` for authFailed in flatModelOptions, leaves this slice green.",
    "impact": "These are the call sites where the user-visible bug lived (the wiring, not the pure functions). The slice proves the pure pieces and the modal given a list; it does not prove that `/routing` as shipped is handed a redetect or an auth-failed row.",
    "suggested_fix": "One test for loadRoutingProviders with a temp config dir, a fetch stub and a `redetect` that returns a provider, expecting that provider in the result and, for an auth-failed fixture, an `authFailed: true` row. One `pickerOptions()` assertion that no option names 'beta'. For the tui-shell pass-throughs, a source audit in the style of provider-catalog-startup.test.ts is acceptable (the launcher declines without a TTY).",
    "evidence": "Read of slice-02.diff: no test imports or calls loadRoutingProviders; tui-shell.ts hunks at showRouting and the classifier call. Mutations not executed; listed as M-6 (wave 1), M-11, M-12. | orchestrator: mutations M-11 and M-12 survived (research-evidence/mutation-1.md)",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:routing-default-loader-wiring-untested",
    "location_class": "in-diff",
    "merged_from": [
      "review-testing-practices-w2:F-008"
    ]
  },
  {
    "id": "C-17",
    "severity": "info",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(providersTimeoutMs / 1000)}s`)), providersTimeoutMs);",
    "problem": "The hang test pins only that 'Reading routing table…' is gone. The AC the PR states is 'model list unavailable (with the reason)', and for a timeout the reason is built here. The test never opens the Model tab, so neither the 'model list unavailable (timed out …)' note nor the reason text is pinned for the timeout path (only the thrown-error path is, in the 'catalog is unavailable' test). With the test seam the message reads 'timed out after 0s' (30 ms rounds to 0 s), and nothing would notice. The assertion is also falsy-only: it passes in any state that is not the loading state.",
    "impact": "A timeout that resolves to an empty list with no error would still pass: the modal would then show 'no providers connected', telling the operator to run /connect when the real problem is a slow catalog. Wrong guidance, unpinned.",
    "suggested_fix": "In the hang test, after the wait, press Enter to open the Model tab and assert the frame contains 'model list unavailable' and 'timed out'. Round the message to ms when the bound is under a second, or assert on 'timed out' only.",
    "evidence": "Read of the hang test (no openModelTab, no pressEnter) and of loadProvidersBounded in slice-02.diff.",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:routing-timeout-reason-unpinned",
    "location_class": "in-diff",
    "merged_from": [
      "review-testing-practices-w2:F-007"
    ]
  },
  {
    "id": "C-18",
    "severity": "info",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "return { list: [], error: error instanceof Error ? error.message : String(error) };",
    "problem": "The provider-loader failure reason (error.message) is placed verbatim into the Model tab status row `model list unavailable (<reason>)` and into `routing: <reason>`. Messages come from fetch/timeout errors in the catalog code, which do not carry the Authorization header or API key; the provider catalog cache stays credential-free (name/status/models/balance/fetchedAt).",
    "impact": "No reachable harm found: I could not name a call path that puts a secret or attacker-controlled control sequence into that message. Worth knowing only if a future loader error ever embeds a URL with a key in the query string, which would then be rendered in the terminal and could end up in screenshots or logs.",
    "suggested_fix": "None required. If hardening is wanted later, pass the reason through the existing secret-redaction helper before display. What would settle it: a provider probe whose thrown error text includes a credential.",
    "evidence": "src/tui/routing-inspector.ts loadProvidersBounded/reload and modelTabNotes; src/harness/provider-catalog.ts refreshProviderCatalogFromDetected, loadOrRefreshProviderCatalog* (only entries persisted, no error strings); docs/docs/cli-reference.md states the cache never carries a credential.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "publication": "omit",
    "merged_from": [
      "review-security-code-w1:SEC-001"
    ]
  },
  {
    "id": "C-19",
    "severity": "info",
    "file": "src/tui/routing-inspector.ts",
    "line": null,
    "quote": "height: Math.max(1, bodyRows - 1 - notes.length),",
    "problem": "Observation, not proven: the picker's list height subtracts `notes.length`, one row per note, but each note is a free-text line (`model list unavailable (${providersError})`, `<provider>: auth failed - ...`) added to one multi-line TextRenderable. If a note wraps (a long loader error message) or there are more notes than `bodyRows - 1`, the note block takes more rows than were reserved, or `Math.max(1, ...)` pins the list to one row while the notes alone exceed the modal body.",
    "impact": "Would push the filter list, its idle hint or the footer past the modal panel. Needs either about 12 problem providers on the default 13-row body, or a loader error longer than the panel width. Would settle it: render the Model tab at 80x24 with a rejecting loader whose message is 150 characters and look at whether the list and hint stay inside the panel.",
    "suggested_fix": "If it matters, truncate each note to the panel width, cap the block at a few rows, and end with '+N more' so the reserved height is exact.",
    "evidence": "slice-02 routing-inspector.ts picker branch: `notes = modelTabNotes(providers, providersError)` is rendered as one TextRenderable and `height: Math.max(1, bodyRows - 1 - notes.length)` assumes one terminal row per note.",
    "confidence": "low",
    "reviewer": "review-logic",
    "publication": "question",
    "merged_from": [
      "review-logic-w2:F-102"
    ]
  },
  {
    "id": "C-20",
    "severity": "info",
    "file": "src/harness/provider-catalog.test.ts",
    "line": null,
    "quote": "import { resolveTuiStartup } from \"../commands/shell\";",
    "problem": "The new import of ../commands/shell sits before the existing ../commands/select import, so the project-relative group is no longer alphabetical (select < shell). The same group already lists ./provider-catalog-cache before ./provider-catalog, so the file does not follow a strict order either way.",
    "impact": "Cosmetic: import order within a group is slightly inconsistent. An autoformatter or import-sort lint, if the project runs one, owns this.",
    "suggested_fix": "Place `import { resolveTuiStartup } from \"../commands/shell\";` after `import { detectProviders } from \"../commands/select\";`, or leave as is if the project sorts imports by tool.",
    "evidence": "Diff lines for src/harness/provider-catalog.test.ts, import block: `+import { resolveTuiStartup } from \"../commands/shell\";` followed by the unchanged `import { detectProviders } from \"../commands/select\";`.",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "style:import-order:provider-catalog.test.ts",
    "blocking_merge": false,
    "location_class": "in-diff",
    "merged_from": [
      "review-style-w1:F-001"
    ]
  },
  {
    "id": "C-21",
    "severity": "info",
    "file": "src/tui/routing-inspector.test.ts",
    "line": null,
    "quote": "// Assumed seams (the smallest the plan names):",
    "problem": "The new test block header is written in the red-first voice ('Assumed seams', 'FlatPickerProvider.authFailed?: true', 'RoutingModalOptions.timeoutMs bounds...') but the seams now exist in the same PR. The local `type ProviderFixture = FlatPickerProvider & { readonly authFailed?: true }` re-declares a field FlatPickerProvider already carries as `authFailed?: boolean`.",
    "impact": "A reader sees a comment describing an assumption that is now fact, and an intersection type that adds nothing. Cosmetic.",
    "suggested_fix": "Reword the header to state the seams as they are (authFailed on FlatPickerProvider, timeoutMs and session on RoutingModalOptions) and drop ProviderFixture in favour of FlatPickerProvider.",
    "evidence": "Diff, routing-inspector.test.ts hunk: header comment 'Assumed seams' and `type ProviderFixture = FlatPickerProvider & { readonly authFailed?: true };`; table.ts hunk adds `readonly authFailed?: boolean;` to FlatPickerProvider.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "style:stale-assumed-seams:routing-inspector.test.ts",
    "blocking_merge": false,
    "location_class": "in-diff",
    "merged_from": [
      "review-style-w2:F-001"
    ]
  },
  {
    "id": "C-22",
    "severity": "info",
    "file": "src/tui/tui-shell.ts",
    "line": null,
    "quote": "// Flow 468: a saved provider+model (or `--provider/--model`) hands startup an",
    "problem": "The flow 468 comment was inserted between the existing comment block and the declaration it describes. The existing block ends with '`.catch` turns a genuinely unexpected throw into an empty catalog', which is about the `.catch` below the call, and the new paragraph about `redetect` now sits between that sentence and the code both refer to.",
    "impact": "The two comment paragraphs read as one run; the `.catch` sentence is now separated from the `.catch` by an unrelated note. Cosmetic.",
    "suggested_fix": "Put the flow 468 paragraph above the 'Flow 309 (AC2)' block, or directly above the `...(opts.redetect ...)` line it explains.",
    "evidence": "Diff, tui-shell.ts hunk at 4159: existing comment ends with the `.catch` sentence, followed by the three added lines and then `const providerCatalogReady ... = loadOrRefreshProviderCatalogFromDetected(opts.detected, {`.",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "style:comment-placement:tui-shell.ts:providerCatalogReady",
    "blocking_merge": false,
    "location_class": "in-diff",
    "merged_from": [
      "review-style-w2:F-003"
    ]
  },
  {
    "id": "C-23",
    "severity": "info",
    "file": "src/tui/provider-catalog-startup.test.ts",
    "line": null,
    "quote": "expect(kickoff).toContain(\"redetect\");",
    "problem": "The PR body says the source-text assertion in provider-catalog-startup.test.ts is now a behavioural one. Half true: the old exact-call-text audit was loosened to anchor on the declaration, and a behavioural test was added, but the behavioural test calls loadOrRefreshProviderCatalogFromDetected directly and supplies `redetect` itself. The production wiring (`opts.redetect` passed from launchTuiAgentShell into the refresh) is still pinned only by a source substring check on the kickoff text. It would pass if `redetect` were passed under a wrong key or to the wrong argument.",
    "impact": "The wiring in tui-shell.ts:4182-4185 is the actual bug site of this PR. The file header documents why a source audit is the idiom (the launcher declines without a TTY), so this follows a deliberate, recorded convention and is not a defect. The cost is only that the PR description overstates what is now behavioural.",
    "suggested_fix": "Either correct the PR body to say the wiring fact is still a source audit, or tighten the audit to the exact spread `...(opts.redetect !== undefined ? { redetect: opts.redetect } : {})`. No test change is required to merge.",
    "evidence": "Read of provider-catalog-startup.test.ts lines 119-125 and tui-shell.ts 4179-4189.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "testing:startup-wiring-source-audit",
    "location_class": "in-diff",
    "publication": "question",
    "merged_from": [
      "review-testing-practices-w1:F-003"
    ]
  }
]
```

## Token spend

token spend: unknown (18 dispatch(es), none reported usage)
