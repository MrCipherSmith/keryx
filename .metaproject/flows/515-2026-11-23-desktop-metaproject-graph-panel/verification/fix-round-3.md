# Verification runs of fix round 3 (T24)

What the orchestrator ran before it accepted T24, written out so that the runs can be repeated from this file.
The runs were made on 2026-11-23 on the tree that became commit `46c472162`. How a scratch copy, a red check and a
mutant run are made is in `fix-round-2.md` beside this file; the orchestrator's scripts (`scratch_check3.py`,
`t24_mutants.py`) are not tracked.

## The new test is red without the fix

Production file put back to the previous commit: `apps/desktop/src/metaproject/MetaprojectView.tsx`.

`MetaprojectView.dom.test.tsx`: 86 pass, 1 fail: “a quiet re-read that succeeds after a failed catalog reload removes its
banner, whether the snapshot changed or not”.

This is the orchestrator's run, on the test file as committed in `46c472162`, which holds 87 tests; 86 + 1 is that file.
T24's result file gives 85 pass, 1 fail for its own red run of the same check. That is one test fewer than the committed
file holds, which fits a run made before the worker's last test in that file was added; the result file does not say
when the run was made. The count for the committed file is the one above. (Added in fix round 4, for review round 4's
F-005.)

## Review round 3's surviving mutants

Ids are review round 3's (`R3-n`). R3-6 and R3-11 were judged equivalent and near-equivalent by the reviewer and were not
in the task. R3-19's anchor was moved by T24 and is in the next section.

### R3-4 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
wikiRelationships.incoming + wikiRelationships.outgoing + wikiRelationships.secondStep
```

Replacement:

```
wikiRelationships.incoming + wikiRelationships.outgoing
```

Result (test file `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`): **killed** by “a Wiki page's Relationships disclosure counts a second-step row with the adjacent ones”.

### R3-7 — `apps/desktop/src/metaproject/RelationshipList.tsx`

Anchor:

```
const empty = !groups.incoming.length && !groups.outgoing.length && !groups.secondStep.length;
```

Replacement:

```
const empty = !groups.incoming.length && !groups.outgoing.length;
```

Result (test file `apps/desktop/src/metaproject/RelationshipList.dom.test.tsx`): **killed** by “a projection with rows in some groups only lists them and does not say it is empty”.

### R3-9 — `apps/desktop/src/metaproject/RelationshipList.tsx`

Anchor:

```
const empty = !groups.incoming.length && !groups.outgoing.length && !groups.secondStep.length;
```

Replacement:

```
const empty = !groups.incoming.length || !groups.outgoing.length || !groups.secondStep.length;
```

Result (test file `apps/desktop/src/metaproject/RelationshipList.dom.test.tsx`): **killed** by “a projection with rows in some groups only lists them and does not say it is empty”.

### R3-10 — `apps/desktop/src/App.tsx`

Anchor:

```
<RetainedView active={workView === "metaproject"} visible={view === "metaproject"}>
```

Replacement:

```
<RetainedView active={workView === "metaproject"} visible={workView === "metaproject"}>
```

Result (test file `apps/desktop/src/App.dom.test.tsx`): **killed** by “the Metaproject explorer is told it is hidden while another view or Settings is shown, and shown again on return”.

### R3-13 — `apps/desktop/src/App.tsx`

Anchor:

```
<MetaprojectWork cwd={cwd} view={view} workView={workView}
```

Replacement:

```
<MetaprojectWork cwd={cwd} view={workView} workView={workView}
```

Result (test file `apps/desktop/src/App.dom.test.tsx`): **survived**. No test renders `ProjectWindow`, where this call site is. It rests on the live check: in the browser dev build the explorer is hidden while another view is shown and one `catalog` request leaves on return (journal, the entries on T23 and T24).

### R3-14 — `apps/desktop/src/App.tsx`

Anchor:

```
explorer: MetaprojectView = LazyMetaprojectView }
```

Replacement:

```
explorer: MetaprojectView = (() => null) as ComponentType<ExplorerProps> }
```

Result (test file `apps/desktop/src/App.dom.test.tsx`): **killed** by “without a stand-in, the app's explorer is loaded lazily behind a visible loading status”.

### R3-15 — `apps/desktop/src/App.tsx`

Anchor:

```
onRebuild={onRebuild} onDraft={onDraft} />
```

Replacement:

```
onRebuild={async () => false} onDraft={onDraft} />
```

Result (test file `apps/desktop/src/App.dom.test.tsx`): **killed** by “the Metaproject explorer is given the app's rebuild and draft callbacks”.

### R3-16 — `apps/desktop/src/App.tsx`

Anchor:

```
<Suspense fallback={<p role="status">Loading Metaproject…</p>}>
        <MetaprojectView cwd
```

Replacement:

```
<Suspense fallback={null}>
        <MetaprojectView cwd
```

Result (test file `apps/desktop/src/App.dom.test.tsx`): **killed** by “without a stand-in, the app's explorer is loaded lazily behind a visible loading status”.

### R3-17 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
generation === project.current && shownSelection.current === from
```

Replacement:

```
shownSelection.current === from
```

Result (test file `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`): **killed** by “a rebuild's catalog reload retires a wiki-link lookup in flight: it neither opens its target nor names a path”.

### R3-18 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
projectGeneration !== project.current
```

Replacement:

```
false
```

Result (test file `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`): **killed** by “a rebuild's catalog reload retires a page of results in flight: it is not appended”.

### R3-20 — `apps/desktop/src/metaproject/MetaprojectView.tsx`

Anchor:

```
if (!quietRead.current) project.current++;
```

Replacement:

_(the anchor is deleted)_

Result (test file `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`): **survived**. Alone it changes nothing a test can see: a read that is not quiet moves `project.current` twice, once in the cleanup and once in the body, and either move retires pending work. See R3-19 and T24-7 below.

## Mutants of T24's own change, and the two moves of `project.current`

File: `apps/desktop/src/metaproject/MetaprojectView.tsx`; test file: `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`.
The ids `T24-n` are the T24 worker's (its result file lists ten; T24-3 and T24-10 were run by the worker only: T24-3, the
`if (quiet)` before the clear dropped, survives as equivalent, and T24-10, an added `else setError(null)`, is killed).

### R3-19, on the line T24 moved it to (the body's move of `project.current` removed)

Anchor:

```
      project.current++;
      setError(null);
```

Replacement:

```
      setError(null);
```

Result: **survived**. Alone it changes nothing a test can see, for the reason given under R3-20.

### T24-7 (R3-19 and R3-20 together: both moves removed)

Anchor:

```
      project.current++;
      setError(null);
```

Replacement:

```
      setError(null);
```

Anchor:

```
if (!quietRead.current) project.current++;
```

Replacement:

_(the anchor is deleted)_

Result: **killed**; the first failing test: “a rebuild's catalog reload retires a wiki-link lookup in flight: it neither opens its target nor names a path”.

### T24-1 (the clear on a quiet success removed)

Anchor:

```
        if (quiet) setError(current => current?.source === "catalog" ? null : current);
```

Replacement:

_(the anchor is deleted)_

Result: **killed**; the first failing test: “a quiet re-read that succeeds after a failed catalog reload removes its banner, whether the snapshot changed or not”.

### T24-2 (a quiet success clears any error)

Anchor:

```
current?.source === "catalog" ? null : current
```

Replacement:

```
null
```

Result: **killed**; the first failing test: “a standing error, such as a failed rebuild's, survives a quiet re-read on return”.

### T24-4 (a failed catalog read recorded as a rebuild's)

Anchor:

```
setError({ source: "catalog", message: errMessage(cause) });
```

Replacement:

```
setError({ source: "rebuild", message: errMessage(cause) });
```

Result: **killed**; the first failing test: “a quiet re-read that succeeds after a failed catalog reload removes its banner, whether the snapshot changed or not”.

### T24-5 (a failed rebuild recorded as a catalog read's)

Anchor:

```
setError({ source: "rebuild", message: errMessage(cause) });
```

Replacement:

```
setError({ source: "catalog", message: errMessage(cause) });
```

Result: **killed**; the first failing test: “a standing error, such as a failed rebuild's, survives a quiet re-read on return”.

### T24-6 (a failed quiet read sets the error)

Anchor:

```
if (generation === catalogRead.current && !quiet) setError(
```

Replacement:

```
if (generation === catalogRead.current) setError(
```

Result: **killed**; the first failing test: “a failed quiet re-read on return shows no error and leaves the explorer as it was”.

### T24-8 (a read that is not quiet no longer clears the error at its start)

Anchor:

```
      project.current++;
      setError(null);
```

Replacement:

```
      project.current++;
```

Result: **killed**; the first failing test: “a return after a failed first catalog read starts no read, and its failure and Retry stay”.

### T24-9 (a rebuild no longer clears the error at its start)

Anchor:

```
    setRebuilding(true);
    setError(null);
```

Replacement:

```
    setRebuilding(true);
```

Result: **killed**; the first failing test: “a rebuild the user starts removes a failed catalog read's banner, and one that reloads nothing leaves it gone”.
