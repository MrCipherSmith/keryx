# Verification runs of fix round 2 (T22, T23)

What the orchestrator ran before it accepted T22 and T23, written out so that the runs can be repeated from
this file. The journal's entries on T22 and T23 report the results; review round 3 (its F-007) found that they
named no script and that the scripts lived only in a session scratch directory. Nothing in this file was run
again when it was written: it records the runs of 2026-11-23 on commits `a37719ff2` (T22) and `8f5bf6d14` (T23).

## How each run was made

Every run used a scratch copy, because a dev server was serving the worktree: `apps/desktop` copied to a temporary
directory as `<tmp>/apps/desktop` without `node_modules`, `target`, `dist`, `.vite` and `gen`; `apps/desktop/node_modules`,
the repository's `src` and its `node_modules` linked into the copy at the same relative places. Tests ran from the
copy's `apps/desktop`, each test file in its own process: `bun test <file>` for a red check, `bun test --bail <file>`
for a mutant. The orchestrator's scripts for this (`scratch_check2.py` with the modes `red` and `mutants`, and
`moved_mutants.py`) are not tracked; this section is what they do.

- **Red check.** In the copy, the named production files are replaced by their version at the previous commit
  (`git show HEAD:<path>` before the task's commit), and the named test files run. A test written for a fix must fail.
- **Mutant.** In the copy, one anchor (a string that occurs exactly once in its file) is replaced by its replacement,
  the test file runs with `--bail`, and the file is put back. `killed` means the run exited non-zero.

## T22: the new tests are red without the fix

Production files put back: `apps/desktop/src/metaproject/MetaprojectView.tsx`, `apps/desktop/src/metaproject/RelationshipList.tsx`.

`MetaprojectView.dom.test.tsx`: 65 pass, 6 fail. The six:

- a Wiki page's Relationships disclosure counts the rows its list shows, and a self-link alone shows none
- a wiki-link lookup in flight when the explorer is hidden and shown again still settles
- a page of results in flight when the explorer is hidden and shown again is still appended
- a failed quiet re-read on return shows no error and leaves the explorer as it was
- a standing error, such as a failed rebuild's, survives a quiet re-read on return
- a return while a catalog reload is in flight starts no quiet read, and the reload's failure is still shown

`RelationshipList.dom.test.tsx`: 12 pass, 1 fail: “a projection whose every edge is left out says it has no relationships”.

## T23: review round 2's surviving mutants

Ids are review round 2's (`R2-n`). Test file: `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`, except R2-28
(`apps/desktop/src/App.dom.test.tsx`). Run on the tree that held T22 and T23.

### R2-2 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (needed > below && above > below) {
```

Replacement:

```
if (needed > below) {
```

Result: **killed** by “the Filters popover stays under its button when its content fits on neither side and there is less room above”.

### R2-4 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
bottom: Math.max(POPOVER_MARGIN, height - rect.top + POPOVER_GAP)
```

Replacement:

```
bottom: height - rect.top + POPOVER_GAP
```

Result: **killed** by “a Filters button at the window's bottom edge keeps the popover above it 8 px inside the window”.

### R2-5 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
maxHeight: Math.min(MENU_MAX_HEIGHT, above) }
```

Replacement:

```
maxHeight: above }
```

Result: **killed** by “in a tall window the Filters popover keeps the menu's 420 px height cap, under its button and above it”.

### R2-6 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
maxHeight: Math.max(0, Math.min(MENU_MAX_HEIGHT, below)) }
```

Replacement:

```
maxHeight: Math.max(0, below) }
```

Result: **killed** by “in a tall window the Filters popover keeps the menu's 420 px height cap, under its button and above it”.

### R2-7 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
maxHeight: Math.max(0, Math.min(MENU_MAX_HEIGHT, below)) }
```

Replacement:

```
maxHeight: Math.min(MENU_MAX_HEIGHT, below) }
```

Result: **killed** by “in a window too short for any room beside its button, the Filters popover gets no negative height”.

### R2-9 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
return () => window.removeEventListener("resize", place);
```

Replacement:

```
return () => {};
```

Result: **killed** by “a closed Filters popover no longer measures its button when the window is resized”.

### R2-16 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (quiet && result.snapshotId === loadedSnapshot.current) {
```

Replacement:

```
if (quiet) {
```

Result: **killed** by “shown again after the project's knowledge changed, the explorer shows the new catalog”.

### R2-17 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
        setFreshness(null);
```

Replacement:

_(the anchor is deleted)_

Result: **killed** by “a graph gone stale while hidden shows its reason under Details, and a rebuild's ready reload clears it”.

### R2-18 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
catalog && freshness?.snapshotId === catalog.snapshotId ? freshness : catalog
```

Replacement:

```
freshness ?? catalog
```

Result: **survived**, kept as equivalent. Every full load clears `freshness` in the same update that replaces the catalog, so `freshness` is null or belongs to the loaded snapshot and the snapshot check cannot change the result.

### R2-19 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
const quiet = quietRead.current;
    quietRead.current = false;
```

Replacement:

```
const quiet = quietRead.current;
```

Result: **killed** by “after a quiet re-read on return, a rebuild's failed catalog reload is still shown”.

### R2-26 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
const freshnessOpen = Boolean(graphState?.graphReason) && freshnessReason === graphState?.graphReason;
```

Replacement:

```
const freshnessOpen = Boolean(catalog?.graphReason) && freshnessReason === catalog?.graphReason;
```

Result: **killed** by “a graph gone stale while hidden shows its reason under Details, and a rebuild's ready reload clears it”.

### R2-28 — `apps/desktop/src/App.tsx`

Anchor:

```
<MetaprojectView cwd={cwd} visible={view === "metaproject"} onRebuild
```

Replacement:

```
<MetaprojectView cwd={cwd} onRebuild
```

Result: **killed** by “the Metaproject explorer is told it is hidden while another view or Settings is shown, and shown again on return”.

## Mutants on lines T22 moved, and of the branches T22 added

The anchors of R2-14, R2-23 and R2-24 no longer occurred once after T22, so each was written again on the line that
now carries the behaviour. `T23-1` to `T23-5` are not mutants of T23's code: they are the orchestrator's mutants of
the five branches T22 added, named after the task whose acceptance they were run for. Test file:
`apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`. The output of the run is kept, untracked, in the review
package of round 3 (`research-evidence/moved-mutants-2.txt`).

### R2-14 (moved by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (!returned || !loaded.current || catalogPending.current) return;
```

Replacement:

```
if (!returned || catalogPending.current) return;
```

Result: **killed**; the first failing test: “a return after a failed first catalog read starts no read, and its failure and Retry stay”.

### R2-23 (moved by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
    for (const node of nodes) remember(node);
```

Replacement:

_(the anchor is deleted)_

Result: **killed**; the first failing test: “a node known only from a search hit keeps its panel once the search is cleared, and Back returns to it at once”.

### R2-24 (moved by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
  }, [nodes, remember]);
```

Replacement:

```
  });
```

Result: **killed**; the first failing test: “a render that changes no node list leaves the explorer's node memory alone”.

### T23-1 (the `!quiet` gate at the start of the catalog effect, added by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
    if (!quiet) {
      project.current++;
      setError("");
    }
```

Replacement:

```
    {
      project.current++;
      setError("");
    }
```

Result: **killed**; the first failing test: “a wiki-link lookup in flight when the explorer is hidden and shown again still settles”.

### T23-2 (the `!quiet` gate in the catch, added by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (generation === catalogRead.current && !quiet) setError(errMessage(cause));
```

Replacement:

```
if (generation === catalogRead.current) setError(errMessage(cause));
```

Result: **killed**; the first failing test: “a failed quiet re-read on return shows no error and leaves the explorer as it was”.

### T23-3 (the `catalogPending` check in the visible effect, added by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (!returned || !loaded.current || catalogPending.current) return;
```

Replacement:

```
if (!returned || !loaded.current) return;
```

Result: **killed**; the first failing test: “a return while a catalog reload is in flight starts no quiet read, and the reload's failure is still shown”.

### T23-4 (the reset of `catalogPending`, added by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
          catalogPending.current = false;
```

Replacement:

_(the anchor is deleted)_

Result: **killed**; the first failing test: “shown again after being hidden, the explorer re-reads the catalog once and quietly, keeping its state”.

### T23-5 (the `!quietRead.current` gate in the effect's cleanup, added by T22) — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (!quietRead.current) project.current++;
```

Replacement:

```
project.current++;
```

Result: **killed**; the first failing test: “a wiki-link lookup in flight when the explorer is hidden and shown again still settles”.
