Reviewed SHA: 9f4ec475bd93ff0a9d64c648ebc3c247cfd73a3a — the PR has since moved on (now f43a13c3f, fix round 1) (head of https://github.com/MrCipherSmith/keryx/pull/1301; base a5d1ab236fe85dee62a758a19390049dde4eb7f9)

# Managed Review Report — round 1

Evidence level: static only — did not run: reviewer tests, Rust compile; orchestrator ran: tests-to-run, core 443 pass, Desktop 998 pass

Package: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1301`
Reviewers (23 replies): review-architecture w1/w2, review-degradation w1/w2, review-frontend w1/w2, review-highload w1/w2, review-layout w1/w2, review-logic w1/w2, review-performance w1/w2, review-pr-contract w1/w2, review-regression w1/w2, review-security-code w1/w2, review-testing-practices w1, review-ui-ux w1/w2.

Finding ids are local to this report: `<reviewer-short>-<wave>-<reviewer's own id>`. Every reviewer finding is carried through unchanged in severity; nothing was dropped or merged away. Replies with no findings: review-layout w2, review-regression w1 and w2, review-security-code w2.

## Stage counts

| Stage | Count |
|---|---|
| Raw findings from reviewers | 52 |
| Dropped by pre-filter | 0 |
| Refuted by verifier | 0 |
| Verified `unverifiable` by site-check (all three majors; code shape confirmed, behaviour not reproduced) | 3 |
| Retained | 52 |

Severity: blocker 0, major 3, minor 20, info 29.

## Verification (Wave C)

Claims are in `research-evidence/verifications.json` (pass 1 and pass 2 merged, ids rewritten to this report's ids, other fields verbatim).

- `frontend-w1-F-001` — unverifiable, site-check (pass 1): every named site exists; no test drives keyboard activation of a status row followed by an activeElement check.
- `highload-w1-F-001` — unverifiable, site-check (pass 2): unbounded client fan-out confirmed in code; it meets the pre-existing fail-fast `MAX_ACTIVE = 8` read permit in `metaproject.rs`. Not executed.
- `logic-w1-F-001` — unverifiable, site-check (pass 2): `moveTo` is the only writer of `focusRequest`; the premise that React skips the commit on a same-value `setFocusId` was not reproduced.

## Duplicates and related findings (kept as separate objects)

- Focus loss when a status row changes key: `frontend-w1-F-001` (major) and `ui-ux-w1-UX-001` (minor) describe the same defect. `logic-w1-F-001` (major) is a different focus defect in the same component (pending `focusRequest` after same-row Home/End).
- Unbounded tree re-read fan-out after a snapshot change: `highload-w1-F-001` (major) and `performance-w1-F-002` (minor) are the same defect; `performance-w1-F-001` (sequential reveal paging) is related.
- Wiki untyped group key `"other"` not exported from the contract: `architecture-w1-F-001` and `architecture-w2-F-001` (both minor) are the same defect, raised from the client and the core side. Related: the fallback is unreachable today (`frontend-w2-F-002`, `logic-w2-F-002`, `testing-practices-w1-I2`) and it sorts mid-list (`ui-ux-w2-UX-001`).
- `wikiTree` quadratic group copy: `performance-w2-F-001` (minor). review-security-code w2 notes the same quadratic spread in its prose ("Resource bounds / DoS") and classes it as a performance concern, not an attacker vector; it raised no finding object.
- Tree read runs the full v2 catalog pipeline: `highload-w2-F-001` and `performance-w2-F-002` (both info) are the same observation.
- Lingering scroll request for a symbol selection: `logic-w1-F-002` and `performance-w1-F-004` (both info) are the same site.
- No ArrowUp test for AC5: `frontend-w2-F-001` and `testing-practices-w1-F4` (both minor) are the same gap.
- Stale-snapshot branch: `degradation-w1-F-002` (unreachable branch) and `testing-practices-w1-F3` (untested) cover the same code.
- Wiki group display label produced in core: `architecture-w2-F-002` (info) and `ui-ux-w2-UX-002` (info) concern the same label split.
- CLI reference does not document `tree`: `pr-contract-w1-PC-001` and `pr-contract-w2-PC-002` (both info); `pr-contract-w2-PC-001` (minor) is the related PR-body claim.

## Findings by severity


### Blocker (0)

None.


### Major (3)

- `frontend-w1-F-001` (review-frontend, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Status rows use a different key per state (loading:/error:/more: + parent).
- `highload-w1-F-001` (review-highload, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Child-process fan-out over a user-sized collection with no client bound.
- `logic-w1-F-001` (review-logic, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — moveTo sets focusRequest and relies on a commit for the layout effect to consume it.

### Minor (20)

- `architecture-w1-F-001` (review-architecture, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — The client re-derives the core's wiki tree grouping rule (untyped pages -> group key "other") instead of taking it from the contract.
- `architecture-w2-F-001` (review-architecture, high confidence) `src/integrations/metaproject-explorer-v2.ts` — The wiki tree's grouping rule (a page's group key is its pageType, or the private constant `WIKI_UNTYPED_GROUP = "other"` when absent) is part of the tree contract that clients depend on to build reveal paths, but it is not exported from the shared contract...
- `degradation-w1-F-001` (review-degradation, high confidence) `apps/desktop/src/platform/metaproject.ts` — The handshake moved to negotiateMetaprojectExplorer and the old negotiateMetaproject survives as a one-line wrapper whose only callers are the platform tests.
- `degradation-w1-F-002` (review-degradation, high confidence) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — This branch cannot run: every tree read sends expectedSnapshotId = pinned, and requestMetaprojectV2 -> matchesRequest (platform/metaproject.ts:311) already rejects a response whose snapshotId differs, throwing the generic Error 'Incompatible Metaproject v2 ...
- `frontend-w2-F-001` (review-frontend, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.dom.test.tsx` — No test dispatches ArrowUp; the keyboard test covers ArrowDown, ArrowRight, ArrowLeft, Home, End, Enter and Space only, while AC5 lists Up as well.
- `performance-w1-F-001` (review-performance, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Reveal of an outside selection resolves one ancestor read or one next page per render step; each is a separate metaproject_request (one CLI child spawn).
- `performance-w1-F-002` (review-performance, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — After a snapshot change all loaded folders are dropped and the expanded set kept; every expanded folder whose parent is loaded is read at once, with no concurrency bound, each a separate CLI child process.
- `performance-w2-F-001` (review-performance, high confidence) `src/integrations/metaproject-explorer-v2.ts` — wikiTree allocates a fresh copy of the group's array for every wiki page it adds, making grouping O(W^2) in the size of a page-type group.
- `pr-contract-w2-PC-001` (review-pr-contract, high confidence) `docs/docs/guides/desktop-metaproject.md` — PR body claims: "The handshake still requires only the six existing actions, so an older CLI keeps working; Desktop learns `supportsTree` from the probe." The diff confirms Desktop now USES `tree` without requiring it (apps/desktop/src/platform/metaproject....
- `testing-practices-w1-F1` (review-testing-practices, high confidence) `src/integrations/metaproject-explorer-tree.test.ts` — This test, and the 'never symbols' claim in the root test's name, assert only that no symbol node appears.
- `testing-practices-w1-F2` (review-testing-practices, high confidence) `src/integrations/metaproject-explorer-tree.test.ts` — AC1 requires sorted children, but the fixtures can't separate the sort graphTree/wikiTree add from the order the producer already emits.
- `testing-practices-w1-F3` (review-testing-practices, high confidence) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — This PR adds the tree's stale-snapshot handling: an answer for another snapshot is refused, and a `stale-snapshot` answer or error calls `onStale`, which MetaprojectView wires to `markStale`.
- `testing-practices-w1-F4` (review-testing-practices, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — AC5 lists Up/Down/Left/Right/Home/End/Enter/Space.
- `testing-practices-w1-F5` (review-testing-practices, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Empty trees are tested only for a graph that is not built (partial: true).
- `testing-practices-w1-F6` (review-testing-practices, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.dom.test.tsx` — 'data arriving never moves focus' asserts only that focus stayed outside.
- `testing-practices-w1-F7` (review-testing-practices, medium confidence) `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx` — 'the selection shown by default reveals nothing' asserts only negative state: folders collapsed, and no tree reads beyond the roots.
- `ui-ux-w1-UX-001` (review-ui-ux, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Criterion WCAG 2.4.3 Focus Order / Nielsen #3.
- `ui-ux-w1-UX-002` (review-ui-ux, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Criterion WCAG 4.1.3 Status Messages / State: error.
- `ui-ux-w1-UX-003` (review-ui-ux, high confidence) `apps/desktop/src/metaproject/MetaprojectView.tsx` — Criterion WCAG 2.4.6 Headings and Labels / 1.3.1.
- `ui-ux-w1-UX-004` (review-ui-ux, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Criterion Nielsen #4 Consistency and standards / #6 Recognition over recall.

### Info (29)

- `architecture-w1-F-002` (review-architecture, medium confidence) `apps/desktop/src/metaproject/MetaprojectView.tsx` — The production prop type keeps the bare protocol number only for older test doubles, and initial tree support is switched on by the presence of an injected requestTree.
- `architecture-w1-F-003` (review-architecture, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — The reveal state machine (ensure/more/setExpanded/setHandled over ancestor steps) is orchestrated from a dependency-less useEffect in the rendering component while the data model lives in useMetaprojectTree.
- `architecture-w1-F-004` (review-architecture, high confidence) `apps/desktop/src/platform/metaproject.ts` — The required capability set moved from the contract's METAPROJECT_CAPABILITIES to a Desktop-local literal mirrored by Rust ACTIONS.
- `architecture-w2-F-002` (review-architecture, medium confidence) `src/integrations/metaproject-explorer-v2.ts` — The core reader now produces a human-readable display label for wiki groups (`domain-model` -> `Domain model`) in the transport response, while Desktop owns every other display label for the explorer (`apps/desktop/src/metaproject/labels.ts`: NODE_KIND_LABE...
- `degradation-w1-F-003` (review-degradation, low confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — The graph tree has no row for a root module (path ".", which the Core accepts as a module node, metaproject-explorer-v2.ts:41) nor for a module whose folder holds no indexed file nodes: graphTree lists only folders that contain file nodes and attaches a mod...
- `degradation-w2-DEG-W2-001` (review-degradation, medium confidence) `docs/docs/guides/desktop-metaproject.md` — On base, the Graph sidebar without a query listed the v2 catalog's interleaved nodes (wiki pages, modules, files, OpenSpec specs and changes — catalog groups at metaproject-explorer-v2.ts catalog(), and MetaprojectView.tsx:599 passes all results in Graph mo...
- `frontend-w1-F-002` (review-frontend, medium confidence) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — On a snapshot change the hook mutates generation.current and state.current during render.
- `frontend-w2-F-002` (review-frontend, high confidence) `docs/docs/guides/desktop-metaproject.md` — The 'Other' wiki group is unreachable today: every wiki node is built with pageType from the fixed WIKI_PAGE_TYPES list (src/integrations/metaproject-explorer.ts:78), so wikiTree's '??
- `frontend-w2-F-003` (review-frontend, medium confidence) `docs/docs/guides/desktop-metaproject.md` — Folders and files are ordered with compareText (code-unit comparison), so upper-case names sort before lower-case ones; the guide calls this 'name order'.
- `highload-w1-F-002` (review-highload, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — The reveal effect runs on every render with no attempt cap.
- `highload-w2-F-001` (review-highload, medium confidence) `src/integrations/metaproject-explorer-v2.ts` — A tree read needs only the graph's node list (or the wiki nodes), but it goes through the same pipeline as a catalog read: `graphRequest` maps `tree` to `{ action: "catalog" }` (default branch), and `metaprojectExplorerV2` then loads the whole graph, reads ...
- `layout-w1-LY-001` (review-layout, medium confidence) `apps/desktop/src/metaproject/metaproject.css` — Unverified (not measured).
- `layout-w1-LY-002` (review-layout, low confidence) `apps/desktop/src/metaproject/metaproject.css` — Unverified (not measured).
- `logic-w1-F-002` (review-logic, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — For a symbol, or a wiki node in Graph mode, revealSteps yields no row, but a scroll request is still set to an id the tree never renders.
- `logic-w1-F-003` (review-logic, high confidence) `apps/desktop/src/metaproject/MetaprojectView.tsx` — The prop doc says that injecting requestTree without a negotiation turns the tree on.
- `logic-w2-F-001` (review-logic, high confidence) `src/integrations/metaproject-explorer-v2.ts` — graphTree treats every `graphPresent === false` as 'no graph'.
- `logic-w2-F-002` (review-logic, high confidence) `src/integrations/metaproject-explorer-v2.ts` — The fallback group `other` is never produced today: wikiPages (metaproject-explorer.ts:63-78) only reads the folders of WIKI_PAGE_TYPES and always sets `pageType: type`, and no WIKI_PAGE_TYPES type is named `other`.
- `performance-w1-F-003` (review-performance, medium confidence) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — Tree state is published by forcing a render of the Explorer that owns the hook, so each expand/collapse, page arrival or setHandled re-renders the whole Explorer and all visible tree rows (rows not memoized).
- `performance-w1-F-004` (review-performance, high confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — For a symbol selection the tree never renders an `n:<symbolId>` row, so the scroll request stays set and the no-deps useLayoutEffect re-queries all [data-row] elements on every render until another reveal overwrites it.
- `performance-w2-F-002` (review-performance, medium confidence) `src/integrations/metaproject-explorer-v2.ts` — Each tree page goes through metaprojectExplorerV2, which loads the whole graph (catalog-mode loadExplorerGraph, JSONL parse, SHA-256 over all nodes and edges), reads OpenSpec and builds relationships, while graphTree then uses only the files under one prefix.
- `pr-contract-w1-PC-001` (review-pr-contract, medium confidence) `docs/docs/cli-reference.md` — This diff makes `tree` an optional action.
- `pr-contract-w2-PC-002` (review-pr-contract, medium confidence) `docs/docs/cli-reference.md` — PR body: "Core: new read-only v2 action `tree` (`scope: graph | wiki`, optional `parent`, paged with snapshot-bound cursors ...).
- `security-code-w1-F-001` (review-security-code, high confidence) `apps/desktop/src/platform/metaproject.ts` — validTreeEntry checks a folder path is checkout-relative and a group key is non-empty, but not that a folder is a direct child of the requested parent or that a group key is bounded.
- `testing-practices-w1-I1` (review-testing-practices, medium confidence) `apps/desktop/src/platform/metaproject.test.ts` — The 'rejects malformed tree pages' table omits three validator gates added in apps/desktop/src/platform/metaproject.ts: a wiki group under a non-null parent (`parent === null`), a folder with an empty name (`value.name.length > 0`), and an empty-string pare...
- `testing-practices-w1-I2` (review-testing-practices, medium confidence) `src/integrations/metaproject-explorer-v2.ts` — The producer always sets pageType from WIKI_PAGE_TYPES (src/integrations/metaproject-explorer.ts:78), so no core fixture can reach the untyped 'other' group.
- `ui-ux-w1-UX-005` (review-ui-ux, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Folder and group counts are bare numbers.
- `ui-ux-w1-UX-006` (review-ui-ux, medium confidence) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Restraint.
- `ui-ux-w2-UX-001` (review-ui-ux, high confidence) `src/integrations/metaproject-explorer-v2.ts` — Wiki root groups are sorted purely by display name, so the catch-all 'Other' group (pages without a page type, WIKI_UNTYPED_GROUP) lands in the middle of the list rather than last.
- `ui-ux-w2-UX-002` (review-ui-ux, high confidence) `src/integrations/metaproject-explorer-v2.ts` — The tree now labels a page type in human form ('Domain model', 'Business rule'), while the details panel's 'Page type' fact (NodeDetailsPanel.tsx `{node.pageType && <Fact label="Page type">{node.pageType}</Fact>}`) and the Wiki article meta line (Metaprojec...

## Not run

- Rust `cargo test` / compile for `apps/desktop/src-tauri` (no local Rust toolchain; CI only). The `metaproject.rs` changes and the Rust capability test are verified statically only.
- Live UI measurements (Playwright/Storybook) for review-layout: `layout-w1-LY-001` and `layout-w1-LY-002` are unmeasured.
- Reviewer-side test runs: no reviewer executed tests; the verifier ran none (all three claims are site-checks).
- Red tests proposed by the verifier for `highload-w1-F-001` and `logic-w1-F-001` were not written or run, so neither major is `confirmed`.
- Mutation pass: 52 candidates in `research-evidence/mutants.json` were not run.

```json keryx:findings
[
  {
    "id": "frontend-w1-F-001",
    "severity": "major",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "rows.push({ type: \"loading\", id: `loading:${parent}`, level, parent });",
    "problem": "Status rows use a different key per state (loading:/error:/more: + parent). When the row holding DOM focus changes state or disappears, React unmounts that <li> and nothing restores focus; activeElement becomes <body>. Paths: keyboard Enter on an error row (Retry -> loading row), keyboard Enter on Show more when the next page is the last (more row removed), arrowing onto a Loading row and the children arriving, and a new snapshot collapsing the tree to a root loading row.",
    "impact": "The tree's onKeyDown is on the <ul role=tree>; with focus on <body>, arrows/Home/End/Enter stop working and a keyboard user must Tab back into the tree after every keyboard Retry or last Show more. Breaks the roving-focus behaviour AC5 claims; tests click these controls and never assert focus after a keyboard activation.",
    "suggested_fix": "Key every status row of a parent with one stable id (status:${parent}) so loading/error/more update the same <li> in place; in the layout effect, when focusId no longer names a rendered row and the tree held focus before the update, focus the row now at the old index (first appended entry after Show more, parent folder for a vanished Loading row). Add tests that press Enter on Show more (last page) and on the error row and assert document.activeElement stays inside the tree.",
    "evidence": "MetaprojectTree.tsx flatten(): loading row id `loading:${parent}`, error row `error:${parent}`, more row `more:${parent}`; activate() -> model.retry / model.more; useMetaprojectTree retry() sets status loading, read() drops nextCursor on the last page, snapshot change resets folders. MetaprojectTree.dom.test.tsx 138-169 and 315-326 drive Retry/Show more by .click(); 226-236 only checks focus is not taken from outside.",
    "confidence": "high",
    "reviewer": "review-frontend",
    "dedupe_key": "metaproject-tree-status-row-focus-loss",
    "blocking_merge": false,
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "apps/desktop/src/metaproject/MetaprojectTree.tsx flatten(): loading row (`loading:${parent}`)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx flatten(): failed-folder error row (`error:${parent}`)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx flatten(): failed-next-page error row (`error:${parent}`)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx flatten(): Show more row (`more:${parent}`)",
        "apps/desktop/src/metaproject/useMetaprojectTree.ts snapshot reset in render (all folders dropped -> root loading row)"
      ],
      "enumeration_method": "Enumerated every Row variant pushed in flatten() (entry, loading, error x2, more) and every model transition that changes a parent's row type (ensure, retry, more, read success without nextCursor, not-found forget, snapshot reset). Entry rows keep a stable d:/n: id across loads and are not in the class; every status-row transition changes or removes the key."
    }
  },
  {
    "id": "highload-w1-F-001",
    "severity": "major",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "for (const parent of unread) model.ensure(scope, parent);",
    "problem": "Child-process fan-out over a user-sized collection with no client bound. `flatten` collects every visible parent with no loaded folder into `unread`, and this effect calls `model.ensure` for all of them in one pass; each `ensure` -> `read` is one `metaproject_request` -> one CLI child (~0.8 s, loads the whole graph). After any new snapshot (Refresh, Rebuild graph, the quiet catalog re-read on returning to the view) `useMetaprojectTree` drops every loaded folder and keeps the expanded set, so once the root answers, every expanded top-level folder (and, a level later, every expanded child of those) is read at the same moment. The only bound is Rust `ReadPermit::acquire` (metaproject.rs, `MAX_ACTIVE: usize = 8`, a process-wide static), which does not queue: the 9th concurrent read fails with `unavailable: Too many Metaproject reads. Retry shortly.`.",
    "impact": "Trigger: a user has 7 or more sibling folders expanded in Graph (or sibling groups in Wiki) and the snapshot changes, while the explorer re-issues its own detail/neighbors reads for the selection. Outcome: the reads beyond the 8 permits fail; those folders render 'Could not load. Too many Metaproject reads. Retry shortly.' and stay failed until the user clicks Retry on each one; and because the permit is shared by every project window, the same burst can make the explorer's detail/neighbors reads (or another window's reads) fail with the same error. Old-generation tree reads are not cancelled and keep their permits until their child exits (up to the 150 s child timeout), so two refreshes in quick succession double the pressure.",
    "suggested_fix": "Bound tree reads on the client: route `read` in useMetaprojectTree.ts through a small FIFO limiter (e.g. at most 2-3 tree reads in flight; queued reads check `current()` before starting so a retired generation never spawns), leaving permits for the explorer's own reads. Optionally treat an `unavailable` answer from the permit as retryable once with backoff and jitter rather than a terminal folder error. Rule: async-patterns.mdc Rule 3 / concurrency-patterns.mdc Rule 4 (bounded child fan-out, default 4).",
    "evidence": "MetaprojectTree.tsx `flatten` pushes every missing expanded parent into `unread`; the effect `for (const parent of unread) model.ensure(scope, parent)` issues them together. useMetaprojectTree.ts on snapshot change: `const keep = (scope) => ({ ...emptyScope(snapshot), expanded: scope.expanded, handled: scope.handled })` (folders dropped, expanded kept); `read` calls `send(root, input)` with no limiter. metaproject.rs:184-200 `static ACTIVE: AtomicUsize`, `const MAX_ACTIVE: usize = 8`, `Err(\"unavailable: Too many Metaproject reads. Retry shortly.\".into())`; v2_request acquires the permit per request before spawn_blocking; cli_response uses `Duration::from_secs(150)`. Failed folders are not auto-retried (`unread` only lists parents with no folder entry), so the error rows persist.",
    "confidence": "medium",
    "reviewer": "review-highload",
    "blocking_merge": false,
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "apps/desktop/src/metaproject/MetaprojectTree.tsx: effect `for (const parent of unread) model.ensure(scope, parent)` (fan-out site)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx: reveal effect `model.ensure(scope, step.parent)` / `model.more(scope, step.parent)` (one read per render, sequential; not a fan-out)",
        "apps/desktop/src/metaproject/useMetaprojectTree.ts: `read` (the single spawn point all tree reads pass through; where the bound belongs)",
        "apps/desktop/src/metaproject/useMetaprojectTree.ts: `retry` and `more` (user-initiated, one parent each; not a fan-out)"
      ],
      "enumeration_method": "keryx ctx rg -n --all \"model.ensure|const ensure|const read = |unread.push\" apps/desktop/src/metaproject/ (3 production hits in MetaprojectTree.tsx/useMetaprojectTree.ts, the rest are test doubles), plus reading every caller of `read` in useMetaprojectTree.ts (ensure, more, retry). Only the `unread` effect issues several reads in one pass."
    }
  },
  {
    "id": "logic-w1-F-001",
    "severity": "major",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "  const moveTo = (row: Row | undefined) => {\n    if (!row) return;\n    setFocusId(row.id);\n    focusRequest.current = true;\n  };",
    "problem": "moveTo sets focusRequest and relies on a commit for the layout effect to consume it. Home on the first row or End on the last row targets the row whose id already equals focusId (kept in sync by onFocus), so React bails out of setFocusId, nothing commits, and focusRequest stays true. The next commit for any reason (folder page arriving, reveal setHandled after a selection made elsewhere, snapshot reset) focuses the tabbable treeitem.",
    "impact": "Repro: focus the first tree row, press Home, then click a node in the graph canvas. The reveal re-renders the tree and keyboard focus jumps from the canvas into the tree. This violates the plan ('Focus is never moved by data arriving') and AC6 ('without moving focus').",
    "suggested_fix": "In moveTo, when row.id === focusId, focus the row element directly (querySelector by data-row with CSS.escape) and return without setting focusRequest. Add a DOM test: Home on the first row, trigger a model update, assert document.activeElement is unchanged.",
    "evidence": "MetaprojectTree.tsx: moveTo is the only writer of focusRequest.current = true. The layout effect (no deps) is its only reader and needs a commit. onFocus: () => setFocusId(row.id) keeps focusId equal to the focused row. The Home/End cases call moveTo(rows[0]) / moveTo(rows.at(-1)) unconditionally.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "metaproject-tree-pending-focus-request",
    "class_scope": {
      "sites": [
        "apps/desktop/src/metaproject/MetaprojectTree.tsx:155"
      ],
      "enumeration_method": "Read every write of focusRequest in MetaprojectTree.tsx (the only file with a roving-focus request ref in the slice). moveTo is the sole writer. Its callers are ArrowDown/ArrowUp (index±1, always a different row), ArrowRight (the first child, a different row), ArrowLeft (the parent, a different row), Home and End (can equal the current row). Only Home and End can target the current row, and both go through moveTo, so the class has one site."
    }
  },
  {
    "id": "architecture-w1-F-001",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "const group = node.pageType || \"other\";",
    "problem": "The client re-derives the core's wiki tree grouping rule (untyped pages -> group key \"other\") instead of taking it from the contract. Core owns it as an unexported constant (src/integrations/metaproject-explorer-v2.ts:33 WIKI_UNTYPED_GROUP, applied at :145 with `??`); the client copy uses `||`, so the two already differ for an empty-string pageType.",
    "impact": "Wiki reveal (AC6) depends on the client predicting the server's group key; a change to the core rule silently stops reveal at the root with no test tying the two sides.",
    "suggested_fix": "Export a single key helper or constant from src/integrations/metaproject-explorer-contract.ts and use it in both metaproject-explorer-v2.ts and revealSteps.",
    "evidence": "MetaprojectTree.tsx revealSteps (slice-01 diff); keryx ctx rg '\"other\"|pageType' src/integrations/metaproject-explorer-v2.ts -> lines 33 and 145.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "architecture-w2-F-001",
    "severity": "minor",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "const key = node.pageType ?? WIKI_UNTYPED_GROUP;",
    "problem": "The wiki tree's grouping rule (a page's group key is its pageType, or the private constant `WIKI_UNTYPED_GROUP = \"other\"` when absent) is part of the tree contract that clients depend on to build reveal paths, but it is not exported from the shared contract module. Desktop re-implements it independently in `apps/desktop/src/metaproject/MetaprojectTree.tsx` revealSteps: `const group = node.pageType || \"other\";` (a hand-copied literal, and `||` where core uses `??`). Cross-module coupling on an unpublished rule.",
    "impact": "If core renames the untyped group or changes the grouping key, Desktop's 'selection made elsewhere reveals its path' silently stops finding the group (reveal ends with not-found, no error). The `??`/`||` divergence would also split an empty-string pageType between the two sides; today `metaproject-explorer.ts` always sets pageType from the wiki folder type, so no concrete defect is triggered now — hence minor.",
    "suggested_fix": "Export the rule from `src/integrations/metaproject-explorer-contract.ts` (e.g. `export const METAPROJECT_WIKI_UNTYPED_GROUP = \"other\"; export function metaprojectWikiGroupKey(node: MetaprojectNode): string { return node.pageType || METAPROJECT_WIKI_UNTYPED_GROUP; }`) and use it in both `wikiTree` (metaproject-explorer-v2.ts) and `revealSteps` (MetaprojectTree.tsx), which already imports the contract module.",
    "evidence": "Slice-02 diff, metaproject-explorer-v2.ts hunk @@ 71,177: `const WIKI_UNTYPED_GROUP = \"other\";` (module-private) and `const key = node.pageType ?? WIKI_UNTYPED_GROUP;`. Context read: apps/desktop/src/metaproject/MetaprojectTree.tsx:58 `const group = node.pageType || \"other\";`. `keryx ctx rg \"pageType\" apps/desktop/src --glob '!*.test.*'` shows that single Desktop re-derivation; `keryx ctx rg pageType src/integrations` shows the single core derivation at metaproject-explorer-v2.ts:145.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/integrations/metaproject-explorer-v2.ts:145",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx:58"
      ],
      "enumeration_method": "keryx ctx rg \"pageType\" over apps/desktop/src (non-test) and src/integrations + src/wiki; only these two sites derive a wiki tree group key"
    }
  },
  {
    "id": "degradation-w1-F-001",
    "severity": "minor",
    "degradation_class": "debt",
    "evidence_kind": "consumer-trace",
    "file": "apps/desktop/src/platform/metaproject.ts",
    "line": null,
    "quote": "export async function negotiateMetaproject(cwd: string, call: InvokeExplorer = invokeFor(cwd)): Promise<1 | 2> {",
    "problem": "The handshake moved to negotiateMetaprojectExplorer and the old negotiateMetaproject survives as a one-line wrapper whose only callers are the platform tests. Production (MetaprojectView default) now calls negotiateMetaprojectExplorer, while most handshake cases in metaproject.test.ts (lines ~50-119) still go through the wrapper.",
    "impact": "Two exported entry points for one handshake; the wrapper is a leftover of the old surface that exists only to keep tests compiling, and readers cannot tell which one the app uses.",
    "suggested_fix": "Point the existing handshake tests at negotiateMetaprojectExplorer (asserting `.protocol`) and delete negotiateMetaproject, or mark it explicitly as a test-only alias.",
    "evidence": "consumer-trace: keryx ctx rg 'negotiateMetaproject[^E]' over apps/desktop finds only platform/metaproject.ts:277 (definition) and 11 hits in platform/metaproject.test.ts; MetaprojectView.tsx imports negotiateMetaprojectExplorer (slice-01 diff, import block) and uses it as the default negotiator. Base: MetaprojectView imported negotiateMetaproject directly (removed line in the same hunk).",
    "confidence": "high",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "degradation-w1-F-002",
    "severity": "minor",
    "degradation_class": "debt",
    "evidence_kind": "consumer-trace",
    "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
    "line": null,
    "quote": "if (page.snapshotId !== pinned) throw new MetaprojectRequestError(\"stale-snapshot\", \"Project knowledge changed while loading.\");",
    "problem": "This branch cannot run: every tree read sends expectedSnapshotId = pinned, and requestMetaprojectV2 -> matchesRequest (platform/metaproject.ts:311) already rejects a response whose snapshotId differs, throwing the generic Error 'Incompatible Metaproject v2 response. Choose the bundled CLI in Desktop Settings.' (line 305). The hook's doc comment ('`onStale` is told when the CLI answers for another snapshot', line 66) therefore describes behaviour that does not happen: for that case onStale is not called and the folder shows the misleading 'Choose the bundled CLI' error row.",
    "impact": "Dead code plus a doc comment that misstates the stale path; low user impact because the Core answers a mismatched pin with a `stale-snapshot` error code (AC2), which the catch branch handles correctly.",
    "suggested_fix": "Drop the unreachable check and reword the comment to 'told when the CLI answers stale-snapshot'; or, if a mismatched answer must be treated as stale, make matchesRequest's snapshot mismatch throw MetaprojectRequestError('stale-snapshot', ...) so both this hook and loadMoreSearch get the stale banner.",
    "evidence": "consumer-trace: read() in useMetaprojectTree.ts builds input with expectedSnapshotId: pinned and calls latest.current.request = requestMetaprojectTree -> requestMetaprojectV2 (platform/metaproject.ts), whose matchesRequest returns false when response.snapshotId !== request.expectedSnapshotId, leading to the generic throw before the hook's .then runs. Refute attempt: checked whether requestTree can be something other than requestMetaprojectTree in production: MetaprojectView passes `requestTree ?? requestMetaprojectTree` and App passes no requestTree, so the guard always applies. Sibling MetaprojectView.tsx:674 has the same shape (pre-existing).",
    "confidence": "high",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "frontend-w2-F-001",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.dom.test.tsx",
    "line": null,
    "quote": "test(\"keys move, expand, collapse and select as a WAI-ARIA tree\", async () => {",
    "problem": "No test dispatches ArrowUp; the keyboard test covers ArrowDown, ArrowRight, ArrowLeft, Home, End, Enter and Space only, while AC5 lists Up as well.",
    "impact": "The ArrowUp branch of MetaprojectTree's onKeyDown can regress with the AC5 verify command still passing.",
    "suggested_fix": "Add an ArrowUp step to the existing keyboard test, e.g. after moving to server.ts press ArrowUp and expect focus on client.ts.",
    "evidence": "slice-02 MetaprojectTree.dom.test.tsx keyboard test; keryx ctx rg 'ArrowUp' over MetaprojectTree.dom.test.tsx and MetaprojectView.dom.test.tsx returns no match; acceptance criterion AC5 in the payload.",
    "confidence": "high",
    "reviewer": "review-frontend",
    "location_class": "in-diff"
  },
  {
    "id": "performance-w1-F-001",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "if (folder.nextCursor && folder.more?.status !== \"failed\") { model.more(scope, step.parent); return; }",
    "problem": "Reveal of an outside selection resolves one ancestor read or one next page per render step; each is a separate metaproject_request (one CLI child spawn). For a file late in a large folder it pages sequentially through every 100-entry page.",
    "impact": "In this checkout src/commands has 479 direct files: revealing a late file from a graph click needs root + src + up to 5 pages = ~7 sequential reads, ~5-6 s at the ~0.8 s/read the flow cites; all intermediate pages are appended to the visible tree. Async and correct; accepted by the plan; latency is out of scope.",
    "suggested_fix": "Track with the read-latency stage: a tree request that returns the page containing a named child (or the ancestors' pages in one call) would make reveal one round trip.",
    "evidence": "slice-01 MetaprojectTree.tsx reveal useEffect; metaproject.rs spawns a CLI per request (spawn_blocking + Command::new); git ls-files direct-children counts: src/commands 479, src/review 374, src/tui 339.",
    "confidence": "medium",
    "reviewer": "review-performance",
    "location_class": "in-diff"
  },
  {
    "id": "performance-w1-F-002",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "for (const parent of unread) model.ensure(scope, parent);",
    "problem": "After a snapshot change all loaded folders are dropped and the expanded set kept; every expanded folder whose parent is loaded is read at once, with no concurrency bound, each a separate CLI child process.",
    "impact": "Unbounded fan-out over a caller-sized set (async-patterns.mdc Rule 3; off a hot path, so minor): a rebuild with many expanded sibling folders spawns that many concurrent CLI processes.",
    "suggested_fix": "Cap concurrent tree reads in useMetaprojectTree.read (e.g. 4) with a small queue.",
    "evidence": "slice-01 MetaprojectTree.tsx unread effect; useMetaprojectTree.ts snapshot reset keeps `expanded` and empties `folders`.",
    "confidence": "high",
    "reviewer": "review-performance",
    "location_class": "in-diff"
  },
  {
    "id": "performance-w2-F-001",
    "severity": "minor",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "    groups.set(key, [...groups.get(key) ?? [], node]);",
    "problem": "wikiTree allocates a fresh copy of the group's array for every wiki page it adds, making grouping O(W^2) in the size of a page-type group.",
    "impact": "Runs on every Wiki tree request (root, each group expand, each Show more page). Negligible for small wikis (about 2M element copies for 2,000 pages in one group), but needless quadratic work on a path that scales with the wiki.",
    "suggested_fix": "const list = groups.get(key); if (list) list.push(node); else groups.set(key, [node]);",
    "evidence": "slice-02 hunk @@ 71,177 @@ of src/integrations/metaproject-explorer-v2.ts, function wikiTree; reasoned count: one spread per page, each of the group's current length.",
    "confidence": "high",
    "reviewer": "review-performance",
    "location_class": "in-diff"
  },
  {
    "id": "pr-contract-w2-PC-001",
    "severity": "minor",
    "file": "docs/docs/guides/desktop-metaproject.md",
    "line": null,
    "quote": "serves. Desktop accepts a CLI that lists every action it uses, so a CLI newer",
    "problem": "PR body claims: \"The handshake still requires only the six existing actions, so an older CLI keeps working; Desktop learns `supportsTree` from the probe.\" The diff confirms Desktop now USES `tree` without requiring it (apps/desktop/src/platform/metaproject.test.ts: \"a CLI offering only the six actions Desktop always sends negotiates and reports no tree\"; MetaprojectView.tsx:752 `const treeScope = protocol === 2 && supportsTree && ...`). Three unchanged doc sentences still equate 'accepted' with 'lists every action it uses': desktop-metaproject.md:309 \"Desktop accepts a CLI that lists every action it uses\", desktop-metaproject.md:332 troubleshooting row \"The selected CLI returned invalid Metaproject capabilities | The CLI lacks a read action this Desktop uses.\", and cli-reference.md:8301 \"Desktop accepts any CLI whose list includes the ones it uses.\"",
    "impact": "A reader of these lines concludes that a CLI lacking `tree` (an action this Desktop now uses) is refused with 'invalid Metaproject capabilities', which contradicts the new guide text (\"With an older CLI, the list stays the flat catalog list\") the same PR added. The code is correct; the cost is a reader who trusts the stale wording.",
    "suggested_fix": "Reword the three sites from 'every action it uses' to 'every action it requires' (the six in METAPROJECT_REQUIRED_ACTIONS), and note that Desktop uses optional actions such as `tree` only when the CLI lists them.",
    "evidence": "Found with `keryx ctx rg -n 'every action it uses|action this Desktop uses|includes the ones it uses' docs README.md` (3 matches: docs/docs/guides/desktop-metaproject.md:309, :332; docs/docs/cli-reference.md:8301). None of the three lines is in the diff; slice-02 hunk @@ 308,336 @@ of the guide shows lines 309 and 332 as context only.",
    "confidence": "high",
    "reviewer": "review-pr-contract",
    "location_class": "pre-existing",
    "class_scope": {
      "sites": [
        "docs/docs/guides/desktop-metaproject.md:309",
        "docs/docs/guides/desktop-metaproject.md:332",
        "docs/docs/cli-reference.md:8301"
      ],
      "enumeration_method": "keryx ctx rg for the three phrasings of 'accepts a CLI listing the actions it uses' across docs and README.md; 3 matches"
    }
  },
  {
    "id": "testing-practices-w1-F1",
    "severity": "minor",
    "file": "src/integrations/metaproject-explorer-tree.test.ts",
    "line": null,
    "quote": "expect(result.entries.some((entry) => entry.type === \"node\" && entry.node.kind === \"symbol\")).toBe(false);",
    "problem": "This test, and the 'never symbols' claim in the root test's name, assert only that no symbol node appears. The fixture writes symbols.jsonl, but a tree request never loads it. MetaprojectExplorerV2's graphRequest() maps a `tree` request to the default `{ action: \"catalog\" }`, and loadExplorerGraph reads symbols.jsonl only for search, symbol detail or calls/defines neighbors (src/integrations/metaproject-explorer.ts:180). model.nodes holds no symbol for these assertions to exclude.",
    "impact": "AC1's 'never symbols' is not tested. The assertion passes whether or not graphTree filters symbols. If a later change loads symbols for tree reads, or drops the `node.kind !== \"file\"` filter's symbol exclusion, this test stays green. Today that filter is pinned only by module nodes.",
    "suggested_fix": "Give the assertion a positive artifact. Either unit-test graphTree/MetaprojectExplorerV2.tree with a GraphModel whose nodes include `{ kind: \"symbol\", path: \"src/a.ts\" }`, and assert that the src listing and the folder counts (src: 4) exclude it. Or first prove that the symbol layer is loaded on the path under test (a symbol node is present in the model) before asserting its absence from the entries.",
    "evidence": "src/integrations/metaproject-explorer-v2.ts graphRequest(): `default: return { action: \"catalog\" };`. src/integrations/metaproject-explorer.ts:180 loads symbols only for `request.action === \"search\"` or a symbol detail/neighbors. Tests: metaproject-explorer-tree.test.ts, 'lists a nested folder's children and never returns symbols'.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-F2",
    "severity": "minor",
    "file": "src/integrations/metaproject-explorer-tree.test.ts",
    "line": null,
    "quote": "expect(pages.entries.map(label)).toEqual([\"node:wiki:components/alpha.md\", \"node:wiki:components/zeta.md\"]);",
    "problem": "AC1 requires sorted children, but the fixtures can't separate the sort graphTree/wikiTree add from the order the producer already emits. (1) The wiki producer reads page files in filename order (`readdir(...).filter(...).sort()`, src/integrations/metaproject-explorer.ts:67), and the titles Alpha/Zeta follow the filenames alpha.md/zeta.md. The new `pages.sort(... compareText(a.title, b.title) ...)` therefore has nothing to reorder. (2) builtGraph writes nodes.jsonl with each folder's files already in ascending path order (src/lib/deep/c.ts before d.ts, many/file-00..14 in order), so `files.sort((a, b) => compareText(a.path, b.path))` also gets pre-sorted input. Folder order IS pinned, because src, docs, pkg and many are inserted out of order.",
    "impact": "If either sort comparator is removed or broken, the suite stays green while the tree lists files or wiki pages out of order (wiki by filename instead of title).",
    "suggested_fix": "Give the wiki pages titles that invert filename order (for example components/alpha.md titled '# Zeta' and zeta.md titled '# Alpha'), then assert title order. Write nodes.jsonl in reverse or shuffled order (for example list many/file-14 before many/file-00, and src/lib/deep/d.ts before c.ts). Mutants T5 and T9 confirm both once they are run.",
    "evidence": "Producer: src/integrations/metaproject-explorer.ts:67 `(await readdir(path.join(root, dir))).filter((name) => name.endsWith(\".md\")).sort()`. Fixture: builtGraph `files` array and wikiOnly titles '# Zeta'/'# Alpha' in zeta.md/alpha.md.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-F3",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
    "line": null,
    "quote": "if (page.snapshotId !== pinned) throw new MetaprojectRequestError(\"stale-snapshot\", \"Project knowledge changed while loading.\");",
    "problem": "This PR adds the tree's stale-snapshot handling: an answer for another snapshot is refused, and a `stale-snapshot` answer or error calls `onStale`, which MetaprojectView wires to `markStale`. No test reaches it. Both fake tree readers always answer with `snapshotId: input.expectedSnapshotId` (MetaprojectTree.dom.test.tsx reader(), MetaprojectView.dom.test.tsx treeExplorer().requestTree), and the MetaprojectTree harness passes `onStale: () => {}`. `keryx ctx rg 'onStale|stale-snapshot'` over both DOM test files finds only that no-op.",
    "impact": "If the snapshot check or the onStale call is removed, the suite stays green. The tree would then render rows from a different snapshot, and the 'Project knowledge changed while loading' banner would never appear for tree reads. AC6 ('drops stale ... answers') is covered only for answers that arrive after a local snapshot change, not for a CLI that has already moved on.",
    "suggested_fix": "In MetaprojectView.dom.test.tsx, have treeExplorer answer one tree read with `snapshotId: \"s2\"` while the catalog is still s1. Also reject one read with `new MetaprojectRequestError(\"stale-snapshot\", ...)`. Assert that the explorer's stale banner (Refresh catalog) appears and that the folder shows no rows from that answer. Mutants U1 and U2 pin it.",
    "evidence": "MetaprojectTree.dom.test.tsx: `return Promise.resolve({ schemaVersion: 2 as const, snapshotId: input.expectedSnapshotId ?? SNAPSHOT, ...` and `onStale: () => {}`. MetaprojectView.dom.test.tsx treeExplorer: `snapshotId: input.expectedSnapshotId ?? \"\"`. MetaprojectView.tsx:754 `onStale: markStale`.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-F4",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "case \"ArrowUp\": moveTo(rows[index - 1]); break;",
    "problem": "AC5 lists Up/Down/Left/Right/Home/End/Enter/Space. The keyboard test 'keys move, expand, collapse and select as a WAI-ARIA tree' presses every key except ArrowUp. `keryx ctx rg ArrowUp` over MetaprojectTree.dom.test.tsx and MetaprojectView.dom.test.tsx returns 0 matches.",
    "impact": "If ArrowUp handling is removed or inverted, the suite stays green, while one of the documented keys (docs/docs/guides/desktop-metaproject.md key table) and an AC5 behaviour is unverified.",
    "suggested_fix": "In the keyboard test, after `ArrowDown` to src, press `ArrowUp` and assert `focused()` is 'docs'. Optionally also assert that ArrowUp on the first row keeps focus there.",
    "evidence": "keryx ctx rg -n 'ArrowUp' on both DOM test files: 0 matches. AC5 text in pr-context requirements.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-F5",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "? root.partial ? \"The graph is not built yet. Rebuild the graph to browse its files.\" : \"No indexed files.\"",
    "problem": "Empty trees are tested only for a graph that is not built (partial: true). No test covers a built graph with no indexed files or an empty wiki. On Desktop, 'No indexed files.' and 'No Wiki pages.' have 0 matches in the tests. In core, no fixture has `graphPresent` true and zero file nodes: builtGraph always has files, and wikiOnly has no graph. That leaves the `parent !== undefined` guard in `if (parent !== undefined && !folders.size && !files.length) throw notFoundParent();` unpinned. That guard keeps an empty root from answering `not-found`.",
    "impact": "If that guard is removed, an empty but built graph's root answers not-found. Desktop would then show 'Could not load.' instead of 'No indexed files.', and the suite stays green.",
    "suggested_fix": "Core: a fixture with an empty nodes.jsonl (graph present). Assert that `tree({scope:'graph'})` resolves to `{ entries: [], partial: false }`. Desktop: two DOM tests, one with a root answer `{ entries: [], partial: false }` in graph scope ('No indexed files.') and one in wiki scope ('No Wiki pages.'). Mutants T2 and M9 cover it.",
    "evidence": "keryx ctx rg 'No indexed files|No Wiki pages' over the DOM tests: 0 matches. metaproject-explorer-tree.test.ts fixtures: wikiOnly (no storage) and builtGraph (files always present).",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-F6",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.dom.test.tsx",
    "line": null,
    "quote": "await act(async () => { tree.release(\"src|\"); });\n    expect(document.activeElement).toBe(outside);",
    "problem": "'data arriving never moves focus' asserts only that focus stayed outside. It never checks that the held page arrived and rendered. If the release did nothing (wrong key, the read never sent, rows not rendered), the test still passes.",
    "impact": "The test can pass when the path it names ('data arriving') never ran.",
    "suggested_fix": "After the release, add `expect(item(\"client.ts\")).not.toBeNull();` (and that no row reads 'Loading…') before the focus assertion.",
    "evidence": "Test body: only `expect(document.activeElement).toBe(outside)` follows the release.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-F7",
    "severity": "minor",
    "file": "apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx",
    "line": null,
    "quote": "expect(treeRow(\"src\").getAttribute(\"aria-expanded\")).toBe(\"false\");\n  await act(async () => { button(\"Wiki\").click(); });",
    "problem": "'the selection shown by default reveals nothing' asserts only negative state: folders collapsed, and no tree reads beyond the roots. It never checks that a default selection exists, for example that the details panel shows src/client.ts or the Guide article in Wiki. If the fallback selection stopped being set, nothing would be revealed for that reason too, and the test passes.",
    "impact": "The rule it pins (MetaprojectView passes `selected={route.selection ? activeNode : undefined}`) is unprotected against a regression that also drops the fallback selection. The test cannot tell 'default selection not revealed' from 'no default selection'.",
    "suggested_fix": "Before the collapsed assertions, assert the fallback is selected: `host.querySelector('[aria-label=\"Graph node details\"]')?.textContent` contains 'src/client.ts' in Graph, and the Guide article heading in Wiki. Mutant W2 confirms it.",
    "evidence": "Test body asserts aria-expanded=false twice plus the treeCalls list. MetaprojectView.tsx:929 `selected={route.selection ? activeNode : undefined}`.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "ui-ux-w1-UX-001",
    "severity": "minor",
    "reviewer": "review-ui-ux",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "if (row.type === \"error\") model.retry(scope, row.parent);\n    else if (row.type === \"more\") model.more(scope, row.parent);",
    "problem": "Criterion WCAG 2.4.3 Focus Order / Nielsen #3. Status rows are focusable treeitems (operator choice: they stay in keyboard navigation), but activating them replaces the focused <li> with a row of a different React key, so the focused element is unmounted and document.activeElement falls to <body>. Paths: (a) Enter/Space on a folder error row -> retry() sets the folder to loading -> row `error:<parent>` becomes `loading:<parent>`; (b) Enter on a failed-next-page error row -> `error:<parent>` becomes `more:<parent>`; (c) Enter on Show more when the answer has no nextCursor -> `more:<parent>` is removed; (d) a keyboard user arrows onto a `loading:<parent>` row and the data arrives -> that row is removed. Nothing restores focus: `focusRequest` is set only by `moveTo`, and `focusId` keeps pointing at the removed id, so `tabbable` falls back to the selected row or rows[0].",
    "impact": "A keyboard or screen-reader user who presses Retry or pages through a large folder (any folder with more than 100 entries) loses their place: arrow keys stop working (the keydown handler is on the <ul>, which no longer contains focus), and Tab re-enters the tree at the selected row or the first row, possibly hundreds of rows away from where they were.",
    "suggested_fix": "When the focused row's id disappears from `rows`, move focus to its successor in the same parent: on retry/more keep focus on the row that replaces it (e.g. give the error, loading and more rows of one parent a shared stable key/`data-row` such as `status:<parent>`), and when the more row is removed after the last page focus the first newly appended entry (or the last entry of the parent). Set `focusRequest.current = true` only when DOM focus was inside the tree, so data arriving still never steals focus from elsewhere. Add a dom test: focus the error row, press Enter, assert document.activeElement is still a treeitem.",
    "evidence": "Read MetaprojectTree.tsx in the diff: flatten() emits ids `loading:${parent}`, `error:${parent}`, `more:${parent}` and the <li key={row.id}>; activate() calls model.retry/model.more; useLayoutEffect focuses only when focusRequest.current is set (only moveTo sets it). useMetaprojectTree.retry() sets status \"loading\" (folder path) or more.status \"loading\" (page path). MetaprojectTree.dom.test.tsx Retry/Show more tests (lines ~138-169, ~315-326) click via .click() and assert rows, never document.activeElement after activation. Not observed on a render: no build was supplied.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "apps/desktop/src/metaproject/MetaprojectTree.tsx: activate() error branch (folder Retry)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx: activate() error branch (failed next page Retry)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx: activate() more branch (last page removes the row)",
        "apps/desktop/src/metaproject/MetaprojectTree.tsx: flatten() loading row replaced when data arrives"
      ],
      "enumeration_method": "Enumerated every row type flatten() emits whose id is not an entry id (loading, error, more) and every transition in useMetaprojectTree (ensure, retry, more, read resolve/reject) that changes that row's id or removes it."
    },
    "dedupe_key": "metaproject-tree-focus-lost-on-status-row-replace"
  },
  {
    "id": "ui-ux-w1-UX-002",
    "severity": "minor",
    "reviewer": "review-ui-ux",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "<span>Could not load. {row.message}</span>",
    "problem": "Criterion WCAG 4.1.3 Status Messages / State: error. The Loading row carries role=\"status\", but when a read fails that row is replaced by an error row with no live region (no role=\"alert\"/\"status\", no aria-live), so the failure is never announced. Same for a failed next page (the \"Loading…\" status inside the more row is replaced by the silent error row).",
    "impact": "A screen-reader user who expanded a folder hears \"Loading…\" and then nothing; the folder silently shows an error they discover only by navigating to it.",
    "suggested_fix": "Put the error text in a live region: e.g. <span role=\"status\">Could not load. {message}</span> (polite, matching the loading row) or keep one persistent visually-hidden role=\"status\" region in the tree that announces load failures.",
    "evidence": "Diff of MetaprojectTree.tsx: loading row renders <span role=\"status\">Loading…</span>; more row renders <span role=\"status\">Loading…</span> while loading; error row renders a plain <span> and a <button>. Not verified with a screen reader (no render supplied).",
    "confidence": "high",
    "dedupe_key": "metaproject-tree-error-not-announced"
  },
  {
    "id": "ui-ux-w1-UX-003",
    "severity": "minor",
    "reviewer": "review-ui-ux",
    "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
    "line": null,
    "quote": "<nav className=\"metaproject-list\" aria-label=\"Search results\" ref={list}>",
    "problem": "Criterion WCAG 2.4.6 Headings and Labels / 1.3.1. The landmark name is pre-existing, but this change puts the file/wiki tree inside it exactly when there is no search query, and changes the visible heading to \"Files · N\" / \"Wiki · N\". The landmark is still announced as \"Search results navigation\" while it holds the \"Project files\" tree.",
    "impact": "Screen-reader users navigating by landmark are told the sidebar holds search results when no search was made; the accessible name disagrees with the visible heading.",
    "suggested_fix": "Name the landmark from its visible heading (give the <h2> an id and use aria-labelledby), or derive aria-label from the same state as listHeading (\"Search results\" with a query, \"Project files\"/\"Wiki pages\" with the tree, \"Catalog\" otherwise).",
    "evidence": "MetaprojectView.tsx:918 (current head) keeps aria-label=\"Search results\"; the diff adds the treeScope branch inside this <nav> and the listHeading cases \"Files · ...\" / \"Wiki · ...\". Located with `keryx ctx rg 'aria-label=\"Search results\"' apps/desktop/src` (one site).",
    "confidence": "high",
    "dedupe_key": "metaproject-list-landmark-name"
  },
  {
    "id": "ui-ux-w1-UX-004",
    "severity": "minor",
    "reviewer": "review-ui-ux",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "<span className=\"metaproject-tree-name\" {...(module && { onClick: onRowClick(row) })}>{entry.name}</span>",
    "problem": "Criterion Nielsen #4 Consistency and standards / #6 Recognition over recall. A module folder and a plain folder render identically (chevron, name, count), but a click on the name, or Enter, of a module folder selects the module and re-centres the graph, while the same gesture on a plain folder expands it. The behaviour itself is an operator decision (journal: module folder keys \"Оставить\"); the defect is that nothing on the row tells the user which behaviour they will get.",
    "impact": "Users who click a folder name to open it sometimes get a graph navigation instead and the folder stays closed; they have to learn per folder which ones are modules.",
    "suggested_fix": "Keep the behaviour, add a cue: a small \"Module\" kind label (NODE_KIND_LABELS.module, as node rows already show their kind) or the module icon on module folder rows, and a title/aria-description such as \"Select module; use the arrow to expand\".",
    "evidence": "Diff: folder rows render chevron + name + count for both cases; only `module` switches the click handlers and adds aria-selected. journal.md records the operator decision on keys, not on visual distinction. Not observed on a render.",
    "confidence": "medium",
    "dedupe_key": "metaproject-tree-module-folder-no-cue"
  },
  {
    "id": "architecture-w1-F-002",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
    "line": null,
    "quote": "type Negotiate = (cwd: string) => Promise<1 | 2 | MetaprojectNegotiation>;",
    "problem": "The production prop type keeps the bare protocol number only for older test doubles, and initial tree support is switched on by the presence of an injected requestTree. Follows the file's existing seam pattern (negotiates derived from injection), so no new named violation.",
    "impact": "Production behaviour branches on which test seams are present; the union widens the contract for future callers.",
    "suggested_fix": "Optionally migrate test doubles to return MetaprojectNegotiation and narrow Negotiate.",
    "evidence": "slice-01 diff, MetaprojectView.tsx hunks @@ 123,178 and @@ 231,304.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "architecture-w1-F-003",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "// Reveal a selection made elsewhere: expand its ancestors, reading and paging as needed; stop at a failure.",
    "problem": "The reveal state machine (ensure/more/setExpanded/setHandled over ancestor steps) is orchestrated from a dependency-less useEffect in the rendering component while the data model lives in useMetaprojectTree. The React layering rule the skill cites (code-style-patterns.mdc Rule 2) is absent from this checkout, so this is an opinion, not a named violation.",
    "impact": "Reveal is testable only through the DOM and re-evaluates after every render.",
    "suggested_fix": "Optionally move revealSteps and the step loop into the model as reveal(scope, node).",
    "evidence": "slice-01 diff, MetaprojectTree.tsx; .metaproject/rules/stacks/react/ does not exist (ls).",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "architecture-w1-F-004",
    "severity": "info",
    "file": "apps/desktop/src/platform/metaproject.ts",
    "line": null,
    "quote": "export const METAPROJECT_REQUIRED_ACTIONS = [",
    "problem": "The required capability set moved from the contract's METAPROJECT_CAPABILITIES to a Desktop-local literal mirrored by Rust ACTIONS. Each side pins its literal by test (metaproject.test.ts:117; Rust tree_stays_optional_for_a_cli); cross-language drift is not checked. Intended by plan.md.",
    "impact": "None today; a future required action must be added in two places.",
    "suggested_fix": "None required.",
    "evidence": "keryx ctx rg METAPROJECT_REQUIRED_ACTIONS|METAPROJECT_CAPABILITIES apps/desktop src --all.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "publication": "omit"
  },
  {
    "id": "architecture-w2-F-002",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "function wikiGroupName(key: string): string {",
    "problem": "The core reader now produces a human-readable display label for wiki groups (`domain-model` -> `Domain model`) in the transport response, while Desktop owns every other display label for the explorer (`apps/desktop/src/metaproject/labels.ts`: NODE_KIND_LABELS, RELATIONSHIP_KIND_LABELS). Presentation wording is split across the CLI/Desktop boundary.",
    "impact": "No defect. Changing a group's wording, or localising it, now needs a CLI release rather than a Desktop change, and an older CLI keeps its labels. Opinion without a named rule violation, hence info.",
    "suggested_fix": "Optional: keep `name` in the contract for other clients, but let Desktop label groups from `key` via labels.ts (falling back to `name`), so Desktop wording stays in one place.",
    "evidence": "Slice-02 diff, metaproject-explorer-v2.ts hunk @@ 71,177 (`wikiGroupName`) and the AC1 test expecting `group:domain-model:Domain model:1`; context read of apps/desktop/src/metaproject/labels.ts.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "location_class": "in-diff",
    "publication": "question"
  },
  {
    "id": "degradation-w1-F-003",
    "severity": "info",
    "publication": "question",
    "degradation_class": "behaviour-delta",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "if (node.path === \".\" || !node.path) return [];",
    "problem": "The graph tree has no row for a root module (path \".\", which the Core accepts as a module node, metaproject-explorer-v2.ts:41) nor for a module whose folder holds no indexed file nodes: graphTree lists only folders that contain file nodes and attaches a module only to such a folder (metaproject-explorer-v2.ts:117-129). On base, without a query, the Graph list was the flat catalog, where such a module could appear if it was among the catalog's first 200 nodes. With the tree, those modules are reachable from the list only by search, and a reveal of one does nothing. This repository's module map has no \".\" module, so whether any real project hits this depends on data. If true: minor, a module shown on base's no-query list is reachable only through search.",
    "impact": "Possible loss of no-query access to root-level or file-less modules in projects that have them.",
    "suggested_fix": "Check: run `keryx metaproject-explorer --request '{\"version\":2,\"action\":\"catalog\"}'` on a project whose graph has a module with path \".\" (or a module folder with no indexed files) and see whether that module appears among the root tree entries.",
    "evidence": "Read, not run: revealSteps returns [] for path \".\"; graphTree root entries are folders with file counts plus root files only. Refute attempt: keryx ctx rg over .metaproject/data/gdgraph/artifacts/module-map.json found no \".\" module in this repository, so it is left as a question rather than a finding.",
    "confidence": "low",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "degradation-w2-DEG-W2-001",
    "severity": "info",
    "reviewer": "review-degradation",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "base-diff",
    "location_class": "in-diff",
    "publication": "finding",
    "file": "docs/docs/guides/desktop-metaproject.md",
    "line": null,
    "quote": "- In **Graph**, it shows the folders and files of the checkout. The header",
    "problem": "On base, the Graph sidebar without a query listed the v2 catalog's interleaved nodes (wiki pages, modules, files, OpenSpec specs and changes — catalog groups at metaproject-explorer-v2.ts catalog(), and MetaprojectView.tsx:599 passes all results in Graph mode). With a tree-capable CLI the Graph sidebar now lists only folders (module folders) and file nodes: wiki pages, spec/change nodes and the root module (`module:.`) are no longer browsable there without a search. The guide describes the new content but does not say these kinds left the Graph list.",
    "impact": "A user who reached a spec, change or the root module from the Graph sidebar must now search, or use the Wiki/OpenSpec views. Base only showed the first ~200 interleaved nodes, so this was already partial; it is the plan's intended design (AC1/AC6), hence info.",
    "suggested_fix": "Optionally add one sentence to the guide's Browse the tree section: wiki pages are under Wiki, specs and changes under OpenSpec, and search reaches any item.",
    "evidence": "base-diff: base guide said the list header shows 'Catalog · shown of total' for the catalog list; head guide (this slice) says Graph shows folders and files. graphTree (metaproject-explorer-v2.ts, head) keeps only node.kind === 'file' plus module-backed folders. Refute: read plan rows 62-67 — the tree replacing the flat list is intended, so not filed above info.",
    "confidence": "medium"
  },
  {
    "id": "frontend-w1-F-002",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
    "line": null,
    "quote": "generation.current++;",
    "problem": "On a snapshot change the hook mutates generation.current and state.current during render. Idempotent under StrictMode double render, so no wrong behaviour today.",
    "impact": "None demonstrated. A discarded concurrent render (transition) would drop loaded children twice and re-read; the explorer has no such transition now.",
    "suggested_fix": "No change needed now. If catalog updates ever render inside startTransition, move the reset out of render (state keyed by snapshot, or compare in useLayoutEffect).",
    "evidence": "useMetaprojectTree.ts: `if (state.current.graph.snapshot !== snapshot) { generation.current++; ... state.current = {...} }` in the hook body.",
    "confidence": "medium",
    "reviewer": "review-frontend",
    "dedupe_key": "metaproject-tree-render-phase-ref-write",
    "blocking_merge": false,
    "location_class": "in-diff"
  },
  {
    "id": "frontend-w2-F-002",
    "severity": "info",
    "file": "docs/docs/guides/desktop-metaproject.md",
    "line": null,
    "quote": "Pages without a page type are under **Other**.",
    "problem": "The 'Other' wiki group is unreachable today: every wiki node is built with pageType from the fixed WIKI_PAGE_TYPES list (src/integrations/metaproject-explorer.ts:78), so wikiTree's '?? \"other\"' fallback never fires.",
    "impact": "None at runtime; the guide describes a fallback users will not see.",
    "suggested_fix": "Optional: drop the sentence, or keep it as forward-compatible wording.",
    "evidence": "src/integrations/metaproject-explorer.ts:78 sets pageType: type for every page; metaproject-explorer-v2.ts wikiTree uses node.pageType ?? WIKI_UNTYPED_GROUP.",
    "confidence": "high",
    "reviewer": "review-frontend",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "frontend-w2-F-003",
    "severity": "info",
    "file": "docs/docs/guides/desktop-metaproject.md",
    "line": null,
    "quote": "indexed files. In each folder, its",
    "problem": "Folders and files are ordered with compareText (code-unit comparison), so upper-case names sort before lower-case ones; the guide calls this 'name order'.",
    "impact": "Cosmetic: order can differ from what a user expects from a file manager.",
    "suggested_fix": "Optional: word it as code-point order, or sort with a locale-aware compare.",
    "evidence": "metaproject-explorer-v2.ts graphTree: [...folders].sort(([a], [b]) => compareText(a, b)) with compareText = a < b ? -1 : Number(a > b).",
    "confidence": "medium",
    "reviewer": "review-frontend",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "highload-w1-F-002",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "if (!folder) { model.ensure(scope, step.parent); return; }",
    "problem": "The reveal effect runs on every render with no attempt cap. If a parent it just found listed in its grandparent answers `not-found`, useMetaprojectTree deletes that folder and its expanded key, the next render re-expands it (earlier step) and re-ensures it, and the loop spawns one CLI read per cycle until the selection changes.",
    "impact": "No trigger with the current Core: `V2Read.read` checks `expectedSnapshotId` before the parent, and `graphTree`/`wikiTree` list only folders/groups they would answer for under the same snapshot, so a listed parent cannot answer `not-found` in that snapshot. Recorded so a future change to the tree service (e.g. a folder listed from one source and resolved from another) does not turn it into a read loop.",
    "suggested_fix": "On a `not-found` during reveal, mark the selection handled (as the `failed` branch already does), e.g. have the not-found path record the parent as 'gone' for the current generation so reveal stops instead of re-ensuring.",
    "evidence": "useMetaprojectTree.ts not-found branch deletes the folder and filters the expanded set; reveal effect has no deps array and only stops on `tree.handled === selection`, which the not-found path does not set. src/integrations/metaproject-explorer-v2.ts `read` -> `checkSnapshot(...)` first; `graphTree` throws `notFoundParent()` only when the prefix holds no file node.",
    "confidence": "medium",
    "reviewer": "review-highload",
    "blocking_merge": false,
    "location_class": "in-diff"
  },
  {
    "id": "highload-w2-F-001",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "const { entries, partial } = scope === \"graph\" ? graphTree(this.model, parent) : { entries: wikiTree(this.model.nodes, parent), partial: false };",
    "problem": "A tree read needs only the graph's node list (or the wiki nodes), but it goes through the same pipeline as a catalog read: `graphRequest` maps `tree` to `{ action: \"catalog\" }` (default branch), and `metaprojectExplorerV2` then loads the whole graph, reads OpenSpec, and runs `buildRelationships` (with its per-target filesystem checks) before `V2Read.tree` uses `this.model.nodes` alone. The snapshot id hashes the relationships and diagnostics, so they cannot simply be skipped without changing the snapshot contract shared with the other actions.",
    "impact": "Trigger: each folder expansion and each Show more page is one CLI child doing a full catalog-cost load. Outcome: no failure on its own, but each tree child holds one of Desktop's 8 process-wide read permits for that whole duration, so the burst described in review-highload-w1 F-001 (expanded folders re-read after a new snapshot) keeps permits longer and the refusal window for the explorer's detail/neighbors reads widens. No load level is stated, so no stall is claimed.",
    "suggested_fix": "No change required for this PR. If w1 F-001's client-side limiter is not enough in practice, give `tree` a lighter load path that still produces the same snapshot id (e.g. reuse a cheaper snapshot derivation), or measure a tree read on a large checkout before deciding.",
    "evidence": "metaproject-explorer-v2.ts: `graphRequest(...)` default `return { action: \"catalog\" }`; `metaprojectExplorerV2`: `Promise.all([load(root, graphRequest(request)), readOpenSpec(root)])`, then `await buildRelationships(source, graph, root, track)`, `await confirm()`, then `new V2Read(...).read(request, freshness)`; `V2Read.tree` reads only `this.model` / `this.model.nodes`. Snapshot: `hash([model.base.snapshotId, source.catalog.snapshotId, openEdges, diagnostics])`. metaproject.rs:185-199 `MAX_ACTIVE: usize = 8`, fail-fast `Too many Metaproject reads`.",
    "confidence": "medium",
    "reviewer": "review-highload",
    "blocking_merge": false,
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "layout-w1-LY-001",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/metaproject.css",
    "line": null,
    "quote": ".metaproject-tree-name { flex: 1 1 auto; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    "problem": "Unverified (not measured). A tree row's name is the only shrinkable item (min-inline-size: 0) while its indent grows 16px per level and its trailing kind label / count is flex: none and nowrap. In the narrow-host list column the name has no floor and is computed to reach about 12px at level 5 and 0px from level 6; past that the row's fixed parts exceed the column, and the nav (overflow: auto) scrolls sideways. The previous flat list wrapped names (overflow-wrap: anywhere) and had no indent, so it did not have this shape.",
    "impact": "At the 720px window minimum with the details panel open, a user browsing a deep folder (e.g. apps/desktop/src-tauri/src/... is level 5; .metaproject/skills/gdskills/review/<skill>/ files are level 6) would see file names truncated to a few characters or invisible while the 'File' label still shows, and no title tooltip carries the full name. Wiki rows carry the wider 'Wiki page' label on every row, leaving roughly 33px for a title at level 2 in a 150px column.",
    "suggested_fix": "Measure first (see evidence). If confirmed: cap the indent (e.g. min(level-1, N) * var(--sp-4) or a smaller per-level step in the <=760px container query), drop the redundant per-row kind label in the tree where the scope already implies it (every graph node row is a File, every wiki node row a Wiki page), and add a title attribute with the full name/path on .metaproject-tree-name so an ellipsised name stays readable.",
    "evidence": "Arithmetic only, from source: tokens.css --sp-1 4px, --sp-3 12px, --sp-4 16px, --fs-sm 12px; MetaprojectTree.tsx row style paddingInlineStart calc(var(--sp-3) + (level-1) * var(--sp-4)); .metaproject-row padding var(--sp-2) var(--sp-3) (inline-end 12px kept, block overridden) and 1px border; .metaproject-tree-chevron inline-size 12px; gap var(--sp-1); metaproject.css @container metaproject (max-width: 760px) grid-template-columns minmax(150px, 190px) and, with details, minmax(150px, 180px); tauri.conf.json minWidth 720. Name width = 150 - (12 + 16(L-1)) - 12 - 2 - 12 - 8 - label; with a ~28px label: L=5 -> ~12px, L=6 -> <0. Not measured: exec_budget_s=0 and no real-CSS tier in apps/desktop (bun test runs happy-dom). What would settle it: mount the explorer in a real engine (Tauri webview or Playwright Chromium) at a 720px window with the details panel open, expand to a level-5 and a level-6 file, and read getBoundingClientRect().width of .metaproject-tree-name and nav.metaproject-list scrollWidth vs clientWidth.",
    "confidence": "medium",
    "reviewer": "review-layout",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "layout-w1-LY-002",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/metaproject.css",
    "line": null,
    "quote": ".metaproject-tree-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); min-block-size: 28px; padding-block: var(--sp-1); color: var(--fg-muted); font-size: var(--fs-sm); }",
    "problem": "Unverified (not measured). Loading and error rows do not carry .metaproject-row, so they get the inline-start indent from the inline style but no inline-end padding and no 1px border, while entry and 'Show more' rows have 12px end padding plus border. The error row's Retry button can therefore sit flush against the list's inline end, 13px further out than the counts on the rows above it.",
    "impact": "Cosmetic misalignment of the Retry button and error text against neighbouring rows' trailing column; no clipping expected because the row wraps (flex-wrap: wrap).",
    "suggested_fix": "Give .metaproject-tree-status padding-inline-end: var(--sp-3) and a 1px transparent border (or add the shared row class) so status rows share the entry rows' box.",
    "evidence": "Read from source: MetaprojectTree.tsx renders loading/error li with className 'metaproject-tree-status' only; .metaproject-row (padding var(--sp-2) var(--sp-3), border 1px) applies to entry and more rows. Offset computed, not measured; settle by measuring the Retry button's right edge vs a sibling row's .count-label right edge in a real engine.",
    "confidence": "low",
    "reviewer": "review-layout",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "logic-w1-F-002",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "    scrollRequest.current = selected.kind === \"module\" ? `d:${selected.path}` : `n:${selected.id}`;",
    "problem": "For a symbol, or a wiki node in Graph mode, revealSteps yields no row, but a scroll request is still set to an id the tree never renders. It lingers until the next reveal, and the symbol's file row is not scrolled to.",
    "impact": "No visible defect beyond the symbol's file not being scrolled into view, which the journal already lists as untested.",
    "suggested_fix": "Set scrollRequest only when the steps end at a row: a file node step, or a module folder. Alternatively, reveal the symbol's file row.",
    "evidence": "revealSteps returns [] for non-file/module/symbol kinds in graph scope and pushes no node step for symbols. flatten creates rows only for folder/group/node entries, and graph node entries are files.",
    "confidence": "high",
    "reviewer": "review-logic",
    "publication": "finding"
  },
  {
    "id": "logic-w1-F-003",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
    "line": null,
    "quote": "   * a negotiation, it alone turns the tree on.",
    "problem": "The prop doc says that injecting requestTree without a negotiation turns the tree on. Without requestV2, protocol initialises to 1 and treeScope requires protocol === 2, so the tree stays off.",
    "impact": "A test author following the doc gets the flat list. This affects the test seam only.",
    "suggested_fix": "Reword it as: 'injected together with requestV2 and without a negotiation, it turns the tree on'.",
    "evidence": "useState(negotiates ? null : requestV2 ? 2 : 1); treeScope = protocol === 2 && supportsTree && ...",
    "confidence": "high",
    "reviewer": "review-logic",
    "publication": "finding"
  },
  {
    "id": "logic-w2-F-001",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "if (!model.graphPresent) return { entries: [], partial: true };",
    "problem": "graphTree treats every `graphPresent === false` as 'no graph'. loadExplorerGraph also sets graphPresent=false when nodes.jsonl/edges.jsonl exist but fail to parse (it records graphError 'Graph storage could not be read; rebuild the graph'). The tree then answers an empty partial page and Desktop (MetaprojectTree.tsx:206) shows 'The graph is not built yet.'",
    "impact": "Wording only: the user sees 'not built' for a built-but-unreadable graph. The remedy (rebuild) is the same, and the catalog banner still carries graphReason, so nothing is lost or wrong in data.",
    "suggested_fix": "Optional: leave as is, or let the not-built empty state read 'The graph is missing or could not be read. Rebuild the graph to browse its files.'",
    "evidence": "src/integrations/metaproject-explorer.ts:115-119 (catch sets graphPresent=false and graphError); metaproject-explorer-v2.ts graphTree first line; MetaprojectTree.tsx:206 empty-state text.",
    "confidence": "high",
    "reviewer": "review-logic",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "logic-w2-F-002",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "const key = node.pageType ?? WIKI_UNTYPED_GROUP;",
    "problem": "The fallback group `other` is never produced today: wikiPages (metaproject-explorer.ts:63-78) only reads the folders of WIKI_PAGE_TYPES and always sets `pageType: type`, and no WIKI_PAGE_TYPES type is named `other`. The guide's sentence 'Pages without a page type are under Other' and the Desktop tests' 'Other' group describe a state the CLI cannot emit.",
    "impact": "None at runtime; a harmless fallback for the optional `pageType` field. The guide promises a group users will never see.",
    "suggested_fix": "Keep the fallback (it guards the optional field), and optionally drop or soften the guide sentence about untyped pages.",
    "evidence": "src/integrations/metaproject-explorer.ts:63 and :78; src/wiki/types.ts:13-21 (closed WikiPageType union without 'other').",
    "confidence": "high",
    "reviewer": "review-logic",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "performance-w1-F-003",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
    "line": null,
    "quote": "const [, render] = useReducer((value: number) => value + 1, 0);",
    "problem": "Tree state is published by forcing a render of the Explorer that owns the hook, so each expand/collapse, page arrival or setHandled re-renders the whole Explorer and all visible tree rows (rows not memoized).",
    "impact": "Extra VDOM work per tree change; Explorer's heavy derivations are memoized, so no measured cost.",
    "suggested_fix": "If needed later, move tree state into an external store subscribed only by MetaprojectTree and memoize rows.",
    "evidence": "slice-01 useMetaprojectTree.ts; keryx ctx rg useMemo in MetaprojectView.tsx/RelationshipGraph.tsx.",
    "confidence": "medium",
    "reviewer": "review-performance",
    "location_class": "in-diff"
  },
  {
    "id": "performance-w1-F-004",
    "severity": "info",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "scrollRequest.current = selected.kind === \"module\" ? `d:${selected.path}` : `n:${selected.id}`;",
    "problem": "For a symbol selection the tree never renders an `n:<symbolId>` row, so the scroll request stays set and the no-deps useLayoutEffect re-queries all [data-row] elements on every render until another reveal overwrites it.",
    "impact": "One DOM query per render; negligible cost, but an unreachable request.",
    "suggested_fix": "Set no scroll request for symbols (or scroll to the containing file row when known).",
    "evidence": "slice-01 MetaprojectTree.tsx revealSteps (symbol yields only folder steps) and the useLayoutEffect.",
    "confidence": "high",
    "reviewer": "review-performance",
    "location_class": "in-diff"
  },
  {
    "id": "performance-w2-F-002",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "      case \"tree\": return this.tree(request);",
    "problem": "Each tree page goes through metaprojectExplorerV2, which loads the whole graph (catalog-mode loadExplorerGraph, JSONL parse, SHA-256 over all nodes and edges), reads OpenSpec and builds relationships, while graphTree then uses only the files under one prefix. The pipeline is pre-existing and shared by every v2 action; the tree turns it into a per-click cost (per expand, per Show more, per ancestor on reveal).",
    "impact": "On a large checkout each folder expand may take about as long as a full catalog read. Frequency is human clicks, not keystrokes or frames, and no timing was supplied, so no bottleneck is demonstrated.",
    "suggested_fix": "No change required in this PR. Time `tree` against `catalog` on a large checkout; if expand latency approaches the catalog load, track a lighter load path for tree (skip OpenSpec and relationship building) separately.",
    "evidence": "metaprojectExplorerV2 (metaproject-explorer-v2.ts, Promise.all of load(root, graphRequest(request)) and readOpenSpec(root), then buildRelationships); graphRequest default returns { action: \"catalog\" } for tree; loadExplorerGraph in metaproject-explorer.ts hashes all nodes/edges.",
    "confidence": "medium",
    "reviewer": "review-performance",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "pr-contract-w1-PC-001",
    "severity": "info",
    "file": "docs/docs/cli-reference.md",
    "line": null,
    "quote": "Require the actions you send and ignore the others. A later CLI can list more actions, and Desktop accepts any CLI whose list includes the ones it uses.",
    "problem": "This diff makes `tree` an optional action. Desktop sends it only when the CLI lists it, and requires only METAPROJECT_REQUIRED_ACTIONS (apps/desktop/src/platform/metaproject.ts: \"Optional actions (`tree`) are used only when the answering CLI lists them\"). The CLI reference's metaproject-explorer section still describes only required actions and never mentions `tree`. The sentence is still true as a sufficient condition, but it no longer describes the handshake.",
    "impact": "A client or CLI author reading the reference cannot learn that `tree` exists or that it is optional. Following \"require the actions you send\" literally would make a client refuse an older CLI, which is the defect T5/T6 fixed in Desktop. No runtime effect.",
    "suggested_fix": "Optional: after cli-reference.md line 8301, add one sentence saying that some actions, such as `tree`, are optional: Desktop sends them only when the CLI lists them and works without them.",
    "evidence": "keryx ctx rg over docs and README for the capability wording found cli-reference.md:8295-8301. Diff side: slice-01 platform/metaproject.ts adds METAPROJECT_REQUIRED_ACTIONS and requestMetaprojectTree (\"call only when the negotiation reported `supportsTree`\"), and Rust adds RequestV2::Tree (\"Optional: sent only to a CLI whose capabilities list `tree`, so it is not in `ACTIONS`\").",
    "confidence": "medium",
    "reviewer": "review-pr-contract",
    "location_class": "pre-existing",
    "publication": "finding"
  },
  {
    "id": "pr-contract-w2-PC-002",
    "severity": "info",
    "file": "docs/docs/cli-reference.md",
    "line": null,
    "quote": "Read a bounded catalog, node detail, search results, or a neighborhood from the current project for Desktop.",
    "problem": "PR body: \"Core: new read-only v2 action `tree` (`scope: graph | wiki`, optional `parent`, paged with snapshot-bound cursors ...). Listed in `capabilities`\". The guide the diff edits links readers to this section as the \"CLI response contract\" (desktop-metaproject.md, context line \"[CLI response contract](../cli-reference.md#metaproject-explorer)\"), but the section names no `tree` request or response. The section was already non-exhaustive (it omits openspec-list/openspec-history too), so this is a completeness note, not a contradiction.",
    "impact": "A third-party client author reading the CLI reference cannot learn the `tree` request shape (scope, parent, cursor) or its not-found/stale-snapshot/invalid-input answers without reading src/integrations/metaproject-explorer-contract.ts.",
    "suggested_fix": "Optionally add one sentence and an example `{\"version\":2,\"action\":\"tree\",\"scope\":\"graph\",\"parent\":\"src\"}` to the metaproject-explorer section.",
    "evidence": "docs/docs/cli-reference.md:8285-8301 read in full; `keryx ctx rg -n 'openspec-history' docs README.md src/integrations` shows no user-facing doc enumerating v2 actions (only docs/requirements/keryx-metaproject-openspec/specification.md:101-107, a requirements table for the OpenSpec feature, judged merely related).",
    "confidence": "medium",
    "reviewer": "review-pr-contract",
    "location_class": "pre-existing",
    "publication": "question"
  },
  {
    "id": "security-code-w1-F-001",
    "severity": "info",
    "file": "apps/desktop/src/platform/metaproject.ts",
    "line": null,
    "quote": "      return scope === \"graph\" && isMetaprojectRelativePath(value.path) && typeof value.name === \"string\"",
    "problem": "validTreeEntry checks a folder path is checkout-relative and a group key is non-empty, but not that a folder is a direct child of the requested parent or that a group key is bounded.",
    "impact": "Defence-in-depth only: a misbehaving CLI could place rows under the wrong folder. Not reachable by an attacker: the CLI is the probed local executable, and any value echoed back as a parent is re-validated by Rust relative_path/valid_text before it reaches argv (no shell, no filesystem sink on the Desktop side).",
    "suggested_fix": "Optionally require a folder's path to equal `${parent}/${name}` (or name at the root) and cap a group key at 4096 characters in validTreeEntry.",
    "evidence": "slice-01 apps/desktop/src/platform/metaproject.ts validTreeEntry/validTree; apps/desktop/src-tauri/src/metaproject.rs valid_v2 Tree arm and relative_path.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "location_class": "in-diff",
    "blocking_merge": false
  },
  {
    "id": "testing-practices-w1-I1",
    "severity": "info",
    "file": "apps/desktop/src/platform/metaproject.test.ts",
    "line": null,
    "quote": "{ ...wikiRoot, entries: [{ type: \"group\", key: \"\", name: \"Guide\", pages: 1 }] },",
    "problem": "The 'rejects malformed tree pages' table omits three validator gates added in apps/desktop/src/platform/metaproject.ts: a wiki group under a non-null parent (`parent === null`), a folder with an empty name (`value.name.length > 0`), and an empty-string parent (`parent.length > 0`).",
    "impact": "These gates are possibly unpinned. This is a reading observation; no mutation was run (P1, P2 and P5 are proposed).",
    "suggested_fix": "Add `{ ...wikiRoot, parent: \"guide\" }` (a group under a group), `{ ...graphRoot, entries: [{ type: \"folder\", path: \"src\", name: \"\", files: 1 }] }` and `{ ...graphRoot, parent: \"\" }` to the malformed list.",
    "evidence": "Malformed list in the diff, compared against validTreeEntry/validTree in apps/desktop/src/platform/metaproject.ts.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "testing-practices-w1-I2",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "const key = node.pageType ?? WIKI_UNTYPED_GROUP;",
    "problem": "The producer always sets pageType from WIKI_PAGE_TYPES (src/integrations/metaproject-explorer.ts:78), so no core fixture can reach the untyped 'other' group. Desktop's revealSteps hard-codes the same key (`node.pageType || \"other\"`), and the Desktop tests use a fake 'other' group. No test ties the two together.",
    "impact": "If either side's key drifts, nothing goes red. Today the branch cannot be reached from the loader, so there is no user-visible effect.",
    "suggested_fix": "Either drop the fallback, or export the constant from the contract module and use it in both places.",
    "evidence": "src/integrations/metaproject-explorer.ts:78 `pageType: type`. MetaprojectTree.tsx revealSteps `const group = node.pageType || \"other\";`.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "ui-ux-w1-UX-005",
    "severity": "info",
    "reviewer": "review-ui-ux",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "<span className=\"count-label\">{entry.type === \"folder\" ? entry.files : entry.pages}</span>",
    "problem": "Folder and group counts are bare numbers. In the accessible name of the treeitem they read as e.g. \"src 1234\" with no unit; sighted users must infer that the number is indexed files (not direct children).",
    "impact": "Minor ambiguity; unverified with a screen reader.",
    "suggested_fix": "Add a visually hidden unit or an aria-label on the count (\"1234 files\" / \"12 pages\"), or a title on the count.",
    "evidence": "Diff of MetaprojectTree.tsx folder/group row. Unverified: no render or screen-reader run; settled by reading the accessibility tree of a rendered row.",
    "confidence": "medium",
    "publication": "finding",
    "dedupe_key": "metaproject-tree-count-unlabelled"
  },
  {
    "id": "ui-ux-w1-UX-006",
    "severity": "info",
    "reviewer": "review-ui-ux",
    "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
    "line": null,
    "quote": "<span className=\"metaproject-meta\">{NODE_KIND_LABELS[entry.node.kind]}</span>",
    "problem": "Restraint. The tree's node rows are always files in Graph and always wiki pages in Wiki (validTreeEntry enforces this), so the kind label repeats the same word on every leaf row and takes width from the already-truncated name.",
    "impact": "Visual noise and less room for file names in a narrow sidebar; no information is conveyed.",
    "suggested_fix": "Drop the kind label on tree node rows (keep it in search results, where kinds are mixed), or replace it with something that varies, e.g. the wiki page status.",
    "evidence": "platform/metaproject.ts validTreeEntry: `value.node.kind === (scope === \"graph\" ? \"file\" : \"wiki\")`. Visual effect not measured.",
    "confidence": "medium",
    "publication": "finding",
    "dedupe_key": "metaproject-tree-redundant-kind-label"
  },
  {
    "id": "ui-ux-w2-UX-001",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "      .sort((a, b) => compareText(a.name, b.name) || compareText(a.key, b.key));",
    "problem": "Wiki root groups are sorted purely by display name, so the catch-all 'Other' group (pages without a page type, WIKI_UNTYPED_GROUP) lands in the middle of the list rather than last.",
    "impact": "With the closed WikiPageType set (src/wiki/types.ts) the Wiki tree reads Architecture, Business rule, Component, Decision, Domain model, Integration, Other, Service, User scenario. A catch-all bucket between real categories breaks the common convention that 'Other' is last (Nielsen #4 consistency and standards; grouping should match meaning), so users scanning for Service or User scenario pass a non-category first.",
    "suggested_fix": "Sort typed groups by name and append the WIKI_UNTYPED_GROUP group last, e.g. sort key `[key === WIKI_UNTYPED_GROUP ? 1 : 0, name, key]`; extend the 'groups wiki pages by page type' test with an untyped page to pin the order.",
    "evidence": "Code read: wikiTree() root branch sorts by compareText(a.name, b.name); WIKI_UNTYPED_GROUP = 'other' gives name 'Other' via wikiGroupName. Page-type set read from src/wiki/types.ts WikiPageType. Ordering derived by hand, not rendered.",
    "confidence": "high",
    "reviewer": "review-ui-ux",
    "location_class": "in-diff"
  },
  {
    "id": "ui-ux-w2-UX-002",
    "severity": "info",
    "file": "src/integrations/metaproject-explorer-v2.ts",
    "line": null,
    "quote": "function wikiGroupName(key: string): string {",
    "problem": "The tree now labels a page type in human form ('Domain model', 'Business rule'), while the details panel's 'Page type' fact (NodeDetailsPanel.tsx `{node.pageType && <Fact label=\"Page type\">{node.pageType}</Fact>}`) and the Wiki article meta line (MetaprojectView.tsx `[detail.node.pageType, detail.node.status, detail.node.path]`) still show the raw key ('domain-model'). The humanizer lives in the CLI, so Desktop has no single label source for page types the way it has NODE_KIND_LABELS for kinds.",
    "impact": "The same concept appears under two spellings on one screen: the user opens group 'Domain model' and the selected page's panel says 'domain-model' (Nielsen #4 consistency; #2 real-world language).",
    "suggested_fix": "Give page types one label source used by tree, panel and article meta: either a PAGE_TYPE_LABELS map in apps/desktop/src/metaproject/labels.ts (next to NODE_KIND_LABELS) applied to the panel/meta, or keep the CLI's `name` and apply the same humanizer in the two Desktop sites.",
    "evidence": "wikiGroupName replaces '-' with ' ' and capitalizes the first letter (test expects 'group:domain-model:Domain model:1'); raw pageType rendered at NodeDetailsPanel.tsx and MetaprojectView.tsx found with `keryx ctx rg -n pageType apps/desktop/src/metaproject --glob '!*.test.*'` (4 sites, 2 render raw). Not rendered.",
    "confidence": "high",
    "reviewer": "review-ui-ux",
    "location_class": "in-diff"
  }
]
```

## Token spend

token spend: unknown (23 dispatch(es), none reported usage)

## Review parity

- **Not run: 52 candidates: T1, T2, T3, T4, T5, T6, ….** They stay pending; a pass that runs them can still change a severity.
- **Not verified:** AC3 (Rust) remains unverified until CI runs cargo test. (review-architecture-w1:fu1, narrowed, remains: CI cargo test --locked metaproject result on the PR head)
- **Not verified:** Measure LY-001 in a real layout engine (packaged app or Playwright Chromium) at the 720px window minimum with the details panel open: width of .metaproject-tree-name on a level-5 and level-6 graph row (review-layout-w1:fu1, narrowed, remains: measurement of LY-001 at the 720px window minimum)
- **Not verified:** PR-body claims settled only in slice-02 (Core `tree` action listed in capabilities, v1 unchanged, Desktop Metaproject guide describes the tree, keyboard and older-CLI behaviour) were not checked by th (review-pr-contract-w1:fu1, narrowed, remains: a pr-contract pass over slice-02)
- **Not verified:** Run the 52 mutant_candidates in this result through keryx review mutate (core suite for T*/C*, desktop suite for P*/U*/M*/W*; M2 can loop, so use --timeout-ms). Report each survivor as a minor 'gate u (review-testing-practices-w1:fu1, narrowed, remains: the mutation pass over the 52 candidates)
- **Not verified:** slice-01, apps/desktop/src/metaproject/MetaprojectTree.tsx (outside this reviewer's slice, read for context): keyboard focus is lost when a status row a keyboard user activated is replaced. Enter on a (review-ui-ux-w2:fu1, narrowed, remains: a dedicated check of this note against MetaprojectTree.tsx)
- **Not verified:** slice-01, MetaprojectTree.tsx container rows: the count badge `<span className="count-label">{entry.files | entry.pages}</span>` has no unit, so the treeitem's accessible name reads like 'src 4' with (review-ui-ux-w2:fu2, narrowed, remains: a dedicated check of the count badge wording)
- **Not verified:** slice-01, MetaprojectTree.tsx empty state: 'The graph is not built yet. Rebuild the graph to browse its files.' names the remedy but offers no control in place; the Rebuild graph button lives in the h (review-ui-ux-w2:fu3, narrowed, remains: a dedicated check of the empty-state wording)
