# Mutation pass

Command: `bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts` (baseline exit 1, 334 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 17 ms, copy 492 ms, load 12.7/17.8/19.0.

started 2026-11-24T09:14:36.547Z.

Baseline failed (exit 1); no mutant ran. cwd: `/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree`. Last output:

```
bun test v1.4.4 (38afee6c8)

src/metaproject/MetaprojectTree.dom.test.tsx:
error: Cannot find module '../../../../src/integrations/metaproject-explorer-contract' from '/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/metaproject/MetaprojectTree.tsx'
(fail) (unnamed) [9.38ms]
81 |   ({ useMetaprojectTree: useTree, MAX_TREE_READS } = await import("./useMetaprojectTree"));
82 |   ({ METAPROJECT_PERMIT_REFUSAL: PERMIT_REFUSAL } = await import("../platform/metaproject"));
83 |   host = document.createElement("div"); document.body.append(host); root = (await import("react-dom/client")).createRoot(host);
84 | });
85 | beforeEach(async () => { await act(() => root.render(null)); });
86 | afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });
                                            ^
TypeError: undefined is not an object (evaluating 'root.unmount')
      at <anonymous> (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/metaproject/MetaprojectTree.dom.test.tsx:86:40)
      at act (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules/react/cjs/react.development.js:2512:16)
      at <anonymous> (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/metaproject/MetaprojectTree.dom.test.tsx:86:30)
(fail) (unnamed) [0.44ms]

src/metaproject/MetaprojectView.dom.test.tsx:
22 |      * @param [options.url] URL.
23 |      * @param [options.settings] Settings.
24 |      */
25 |     static register(options) {
26 |         if (this.#registered !== null) {
27 |             throw new Error('Failed to register. Happy DOM has already been globally registered.');
                           ^
error: Failed to register. Happy DOM has already been globally registered.
      at register (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules/@happy-dom/global-registrator/lib/GlobalRegistrator.js:27:23)
      at registerDom (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/test/dom.ts:8:21)
      at <anonymous> (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/metaproject/MetaprojectView.dom.test.tsx:19:3)
(fail) (unnamed) [8.75ms]
21 |   View = (await import("./MetaprojectView")).MetaprojectView;
22 |   overlayOpen = (await import("../components/ui")).overlayOpen;
23 |   host = document.createElement("div"); document.body.append(host); root = (await import("react-dom/client")).createRoot(host);
24 | });
25 | beforeEach(async () => { await act(() => root.render(null)); });
26 | afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });
                                  ^
TypeError: act is not a function. (In 'act(() => root.unmount())', 'act' is undefined)
      at <anonymous> (/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/metaproject/MetaprojectView.dom.test.tsx:26:30)
(fail) (unnamed) [0.61ms]

src/platform/metaproject.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../../../../src/integrations/metaproject-explorer-contract' from '/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/.metaproject/data/review/mutate-scratch/keryx-mutate-1IJOah/tree/src/platform/metaproject.test.ts'
-------------------------------


 0 pass
 5 fail
 1 error
Ran 5 tests across 3 files. [250.00ms]
```

Killed 0, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|

No survivor.
