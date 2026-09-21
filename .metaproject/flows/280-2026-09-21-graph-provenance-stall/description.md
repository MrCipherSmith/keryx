# gdgraph provenance stalls after a metaproject-only commit

## Problem

In a project whose last commits touched only `.metaproject/`, the graph provenance
never advances, and the wiki can therefore never record its baseline:

- `keryx sync` reports `gdgraph: up to date (built at <old commit>)` and rebuilds
  nothing, because the diff stage skips paths under `.metaproject/`;
- `keryx gdgraph build` rebuilds the artifacts (their mtime moves) but
  `.metaproject/data/gdgraph/.provenance.json` keeps the old commit;
- `keryx sync --apply` then refuses the wiki baseline with
  `provenance NOT recorded (baseline) — the code graph is stale: HEAD moved since
  the graph was built`.

So the two mechanisms disagree: the diff stage says "nothing to rebuild", the wiki
gate says "the graph is behind HEAD", and no command moves the record.

## Observed (2026-09-21, keryx 0.2.131)

`/home/altsay/olimpyx`, after two commits that touched only `.metaproject/`:

- `.provenance.json` commit `dd188942`, written 06:25:45; HEAD `811cc79`.
- `keryx gdgraph build` at 06:27:51 rewrote `artifacts/summary.md` (188 nodes,
  453 edges) and left `.provenance.json` untouched.
- `keryx sync --apply` printed `gdgraph: up to date (built at dd188942)` and the
  wiki baseline refusal above.

`/home/altsay/bots/helyx` did not hit it: its commit also changed source files, so
the diff stage rebuilt the graph and advanced provenance to the new HEAD.

## Expected

After any commit, one documented command reaches a state where the wiki baseline can
be recorded — either the diff stage advances provenance when only bookkeeping changed
(nothing to rebuild, but HEAD moved), or `keryx gdgraph build` records provenance
itself, or the wiki gate accepts a graph whose content matches the working tree.
Which of the three is correct is the design question this flow answers.

## Out of scope

- The separate, correct refusal when untracked or newly added code files exist in the
  working tree. That blocked the same two projects as well and is working as intended.
- Rebuilding wikis or graphs in other projects.

## Pointers

- `src/sync/provenance.ts:226` `recordProvenance`
- `src/sync/diff.ts:67` — lines under `.metaproject/` are skipped entirely
- `src/gdgraph/staleness.ts`, `src/gdgraph/build.ts`
- the gdwiki baseline gate that prints `provenance NOT recorded (baseline)`
