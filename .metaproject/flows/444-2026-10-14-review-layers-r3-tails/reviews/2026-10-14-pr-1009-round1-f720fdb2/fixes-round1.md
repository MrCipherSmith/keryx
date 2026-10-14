# PR 1009 round 1 — what was done with each finding

Reviewed head f720fdb2. Fixes are in the commit that follows it on `flow-444-review-layers-r3-tails`.

| Finding | Severity | Disposition | What changed |
|---|---|---|---|
| R1-01 | major | fixed | The TUI refresh argv carries `--force`; `ensurePackageLayers` takes `force`; `layers block` accepts `--force`; the `PackageGraphError` message and the `graph:` detail line name the window and the command that retries now. Tests: `review-layers.test.ts` (message, forced ensure, block flag), `review-layers-child.test.ts` (argv). |
| R1-02 | major (audit) | fixed | `buildLayersBlock` takes a `readPage` seam; a test fails one page after the collection step and pins `1 of N wiki page(s) could not be read — <page>`. Mutant `ac2-unreadable-page-dropped` is now killed (`research-evidence/mutation-2.md`, 4 of 4). |
| R1-03 | minor | fixed | `withDetachedWorktree` awaits the cleanup first and unregisters in a nested `finally`. New signal phase "the checkout's removal after the build" fails when the order is reverted (checked by hand). |
| R1-04 | minor | fixed | The text block prints `<section>: unavailable (<reason>)`, as AC2 states; tests updated. |
| R1-05 | minor | fixed in part | A phase for the `layers.json` write (new `writeLayers` seam) is added. The recover step has no hook of its own: it runs under the same handler, directly before the sweep phase that is tested, so it is not given a separate test. |
| R1-06 | minor | fixed | The signal handler waits at most 5 seconds for registered cleanups before removing the lock and re-raising. |
| R1-07 | info | none | Legacy fallback, bounded and one-off. |
| R1-08 | info | skipped | Round ids in other test names; a rename-only follow-up (AC6 names only `layers-round2`). |
| R1-09 | info | fixed | A kill that did not come from the timeout says the output limit was exceeded. |
| R1-10 | info | fixed | The `unavailable` section enum lists `affected`, `wiki`, `memory`; the TypeScript type matches; the project-local schema copy is synced from the bundled one. |
