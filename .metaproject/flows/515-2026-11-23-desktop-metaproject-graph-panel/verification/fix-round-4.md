# Verification runs of fix round 4 (T26)

What the orchestrator ran before it accepted T26, written out so that the runs can be repeated from this file.
The runs were made on 2026-11-23 on the tree that became the T26 commit. How a scratch copy and a mutant run are made is
in `fix-round-2.md` beside this file; the orchestrator's script (`scratch_check4.py`, which reads review round 4's
`research-evidence/mutants-r4.json`) is not tracked.

## No red check

T26 changed no production file, so there is no previous production file to put back. The mutants below are the check:
for each of R4-7, R4-8, R4-10 and R4-11 the first failing test is one of the four T26 added, which are the last four in
the file, so every earlier test passed under that mutant.

## Checks on the tree

- `cd apps/desktop && bunx tsc --noEmit`: exit 0.
- `cd apps/desktop && bun test src`: 935 pass, 0 fail across 89 files (931 before T26).
- `cd apps/desktop && bunx vite build`: exit 0.
- `bun run typecheck` at the repository root: exit 0.

## Review round 4's mutants

Ids are review round 4's (`R4-n`). File: `apps/desktop/src/metaproject/MetaprojectView.tsx`; test file:
`apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`, run with `--bail` in a scratch copy, one mutant at a time.

### R4-1

Anchor:

```
        if (quiet) setError(current => current?.source === "catalog" ? null : current);
```

Replacement:

```
        setError(current => current?.source === "catalog" ? null : current);
```

Result: **survived**; judged equivalent by the reviewer: a read that is not quiet clears the error at its start, and only the latest read can set a catalog error, so at a loud read's success the error is null or a rebuild's.

### R4-2

Anchor:

```
        // The catalog can be read again: a failed catalog read's banner goes, a failed rebuild's stays.
        if (quiet) setError(current => current?.source === "catalog" ? null : current);
        if (quiet && result.snapshotId === loadedSnapshot.current) {
          setFreshness({ snapshotId: result.snapshotId, graph: result.graph, graphReason: result.graphReason });
          return;
        }
        setCatalog(result);
```

Replacement:

```
        // The catalog can be read again: a failed catalog read's banner goes, a failed rebuild's stays.
        if (quiet && result.snapshotId === loadedSnapshot.current) {
          setFreshness({ snapshotId: result.snapshotId, graph: result.graph, graphReason: result.graphReason });
          return;
        }
        setError(current => current?.source === "catalog" ? null : current);
        setCatalog(result);
```

Result: **killed** by “a quiet re-read that succeeds after a failed catalog reload removes its banner, whether the snapshot changed or not”.

### R4-3

Anchor:

```
        // The catalog can be read again: a failed catalog read's banner goes, a failed rebuild's stays.
        if (quiet) setError(current => current?.source === "catalog" ? null : current);
        if (quiet && result.snapshotId === loadedSnapshot.current) {
          setFreshness({ snapshotId: result.snapshotId, graph: result.graph, graphReason: result.graphReason });
          return;
        }
        setCatalog(result);
```

Replacement:

```
        // The catalog can be read again: a failed catalog read's banner goes, a failed rebuild's stays.
        if (quiet && result.snapshotId === loadedSnapshot.current) {
          setFreshness({ snapshotId: result.snapshotId, graph: result.graph, graphReason: result.graphReason });
          setError(current => current?.source === "catalog" ? null : current);
          return;
        }
        setCatalog(result);
```

Result: **killed** by “a quiet re-read that succeeds after a failed catalog reload removes its banner, whether the snapshot changed or not”.

### R4-4

Anchor:

```
current?.source === "catalog" ? null : current
```

Replacement:

```
current?.source === "rebuild" ? null : current
```

Result: **killed** by “a standing error, such as a failed rebuild's, survives a quiet re-read on return”.

### R4-5

Anchor:

```
<span>{error.message}</span>
```

Replacement:

```
<span>{error.source}</span>
```

Result: **killed** by “explorer banners sit above the OpenSpec view and the freshness banner reads as one sentence”.

### R4-6

Anchor:

```
if (mounted.current) setError({ source: "rebuild"
```

Replacement:

```
setError({ source: "rebuild"
```

Result: **survived**; a guard older than this branch's fixes (a rebuild that ends after the explorer has gone writes nothing); not in the task.

### R4-7

Anchor:

```
if (generation === catalogRead.current && !quiet) setError(
```

Replacement:

```
if (!quiet) setError(
```

Result: **killed** by “a rebuild reload that a later one superseded shows no banner when it fails after the later one succeeded”.

### R4-8

Anchor:

```
        if (generation !== catalogRead.current) return;
        loaded.current = true;
        // The catalog can be read again: a failed catalog read's banner goes, a failed rebuild's stays.
        if (quiet) setError(current => current?.source === "catalog" ? null : current);
```

Replacement:

```
        if (quiet) setError(current => current?.source === "catalog" ? null : current);
        if (generation !== catalogRead.current) return;
        loaded.current = true;
        // The catalog can be read again: a failed catalog read's banner goes, a failed rebuild's stays.
```

Result: **killed** by “a quiet re-read that a failed rebuild reload superseded leaves that reload's banner when it lands”.

### R4-9

Anchor:

```
<span>{error.message}</span>
          <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>
```

Replacement:

```
<span>{error.message}</span>
          <button className="btn btn-sm" onClick={() => {}}>
```

Result: **killed** by “a return after a failed first catalog read starts no read, and its failure and Retry stay”.

### R4-10

Anchor:

```
      project.current++;
      setError(null);
```

Replacement:

```
      project.current++;
      setError(current => current?.source === "rebuild" ? current : null);
```

Result: **killed** by “a failed rebuild's banner goes when Retry reads the catalog again and the read succeeds”.

### R4-11

Anchor:

```
    setRebuilding(true);
    setError(null);
```

Replacement:

```
    setRebuilding(true);
    setError(current => current?.source === "rebuild" ? current : null);
```

Result: **killed** by “a second rebuild removes the first one's failure banner while it runs”.

### R4-12

Anchor:

```
setError({ source: "catalog", message: errMessage(cause) });
```

Replacement:

```
setError({ source: quiet ? "rebuild" : "catalog", message: errMessage(cause) });
```

Result: **survived**; judged equivalent by the reviewer: the catch is guarded by `!quiet`, so `quiet` is false wherever this line runs.
