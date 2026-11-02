# Old-head CI triage

This is evidence for remote `8dcb765f072c5e8cb287175af7d7c9ce300ce322`, run [41392782982](https://github.com/MrCipherSmith/keryx/actions/runs/41392782982), not CI for the current integration. This workflow run reports16success and2failure; other workflows/checks are outside this downloaded run (the parent reported18success plus one expected skip overall).

Both failed jobs have the **same single failing test**, `src/hub/work/http.contract.test.ts:39`: **the Team Hub adapter accepts the served attention page with incident Evidence**. Error:

```text
Cannot find package 'i18next' from '/home/runner/work/keryx/keryx/apps/hub-web/src/api/client.ts'
```

Core gate:27,723pass,1fail,21skip,1todo across1,269files. AC8:37,942pass,1fail,55skip,1todo across1,946files. No separate TypeScript failure appears: the typecheck-and-tests job failed in test:core. Other error-looking lines are intentional passing negative scenarios, not additional failing tests.

## Current integration

**Still present**, not already fixed by chosen native/backend integration. The computed import at `http.contract.test.ts:44` loads `apps/hub-web/src/features/managed-work/adapter.ts`, which imports `api/client.ts`; its first import requires `i18next`. Only the separate UI package declares that dependency. Root CI does a root dependency install, while local UI node_modules hides the missing dependency. This is test dependency placement, not evidence that incident Evidence parsing itself is wrong.

## Recommendation and bounded reproduction

Preserve the meaningful actual-adapter assertion in the UI dependency boundary: move browser adapter +served-page integration coverage to hub-web tests, retain server AttentionPage schema and WorkClient assertions in the root suite. Alternatively explicitly install hub-web dependencies in both root full-suite jobs, accepting the expanded CI boundary. Do not silently delete the assertion or mock its parser.

Proposed bounded RED probe: execute only this exact test in a disposable fixture with actual relevant source and root-only dependencies, without UI node_modules. Then verify the relocated browser integration under its declared UI dependencies. No shared dependency renames or source edits performed; awaiting parent decision before writes. No competing full suite started.

## Artifacts

- `/tmp/pr1113-integration-old-ci-jobs.json`
- `/tmp/pr1113-integration-old-ci-failed.log`
- `/tmp/pr1113-integration-old-ci-core.log`
- `/tmp/pr1113-integration-old-ci-ac8.log`
- `/tmp/pr1113-integration-old-ci-triage.json`

Routing audit: exact named test/log investigation, graph not relevant; wiki/testing context already read; ctx searches/log compaction used; no bare rg.
