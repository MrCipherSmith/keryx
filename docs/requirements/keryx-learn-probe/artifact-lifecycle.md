# Learn Probe Artifact Lifecycle
Version: 0.1.1

## Artifacts

| Artifact | Path | Written by | Contains |
|---|---|---|---|
| Plan | `probes/<pattern-id>/<probe-id>/plan.json` | probe, before the first arm | task, arms, seeds, model, provider, commit, estimate |
| Comparison | `probes/<pattern-id>/<probe-id>/comparison.json` | probe, after scoring | per-arm rates and intervals, delta, verdict, reason |
| Transcripts | `probes/<pattern-id>/<probe-id>/runs/<arm>/<seed>.ndjson` | the turn loop, one per arm per seed | the model's own events for that run |
| Evidence item | inside `candidates/<id>.json` | probe, on `improved`/`regressed` only | `sourceType: "probe"`, `sourceRef` to the comparison |

`plan.json` and `comparison.json` are the audit record. Transcripts are the raw
material and the only large artifacts.

## Creation

A probe id is derived from seven inputs — `(patternId, taskId, model, provider,
commit, taskSetDigest, runs)` — so any change that would change the measurement
lands in a different directory. A second run with the same identity resumes an
incomplete directory and reuses completed seeds, but only when its recorded
`environment` (which carries `baseRef`) and `runs` request match the invocation;
otherwise it is refused with `probe-environment-mismatch` and nothing on disk
changes. A directory that already holds a
completed `comparison.json` is never overwritten: the re-run is refused with
`probe-already-completed` (exit 2) and the file stays byte-identical. A different
result at the same identity is a bug to investigate, not a refresh to store.

## Retention

- Comparison and plan files: kept for the life of the pattern, including after
  the pattern becomes `rejected`, `expired` or `superseded`. They are the
  evidence that the decision was made with a measurement, and deleting them would
  erase the audit trail W3's `decisions.jsonl` refers to.
- Transcripts: the newest `retainRunsPerPattern` probe directories per pattern
  keep their `runs/` trees (default 20); older probe directories keep plan and
  comparison and lose `runs/`. The cap is per pattern, not global, so one noisy
  pattern cannot evict another's evidence.
- Deletion is **planned, not implemented**: today's `src/learning/prune.ts`
  deletes observation files older than 30 days and expires candidates, and knows
  nothing about probes. This package adds a third pass — `retainRunsPerPattern`
  — owned by `src/learning/probe.ts` and invoked from `keryx learn prune`. Until
  that pass lands, nothing deletes probe transcripts, and the `retainRunsPerPattern`
  key has no effect. AC17 is the test for the pass.

## Deletion

- The planned prune pass deletes `runs/` beyond the retention cap.
- Deleting a learned pattern deletes its whole `probes/<pattern-id>/` directory.
  This is the one case where comparison files go: without the record, the
  evidence item that pointed at them no longer exists either.
- Worktrees are deleted by the runner, not by retention: end of probe, failure,
  or interrupt (SIGINT/SIGTERM handler removes both). A leftover worktree is a
  bug; the runner's test asserts none remains after each fixture case.

## Crash behavior

- Crash before any arm started: `plan.json` exists, no comparison. A resume
  reprints the plan and starts over.
- Crash after one arm, before scoring: partial transcripts remain; a resume
  reuses completed seeds and runs only the missing ones. The comparison records
  `resumed: true`.
- Crash during scoring: no comparison is written; the next run scores from the
  transcripts on disk rather than re-running the model, provided the environment
  record matches.

## Gitignore

`.metaproject/data/learning/probes/` joins the existing managed ignore entries
for `observations/` and `candidates/`. The guard test asserts `git check-ignore`
matches a probes path after `keryx init`, mirroring the W3-AC9 test shape.

Probe artifacts are local by design: the comparison records a model, a provider
and a commit, and sharing it across machines would invite reading someone else's
numbers as evidence about your own repository.
