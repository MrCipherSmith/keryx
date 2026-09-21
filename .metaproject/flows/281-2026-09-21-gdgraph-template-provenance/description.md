# `keryx gdgraph build` records no provenance in a scaffolded project

## Problem

In any project created or updated by keryx, `keryx gdgraph build` rebuilds the graph
artifacts and never writes `.metaproject/data/gdgraph/.provenance.json`.

`gdgraphCommand` delegates `build` to the copied local runner
`.metaproject/core/gdgraph/cli.ts` whenever that file exists and treesitter is off —
which is every scaffolded project. That copied runner, templated from
`src/lib/templates.ts`, has no `recordProvenance` call, so the in-process call in
`src/commands/gdgraph.ts` (right after `buildGraph()`) is unreachable there.

The result is a command whose documented effect — "build the graph" — silently leaves
the freshness record untouched. `keryx sync --apply` is unaffected: it records
provenance itself, which is why the gap stayed invisible.

## Found by

Flow 280 (the graph-provenance stall), during its reproduction on a scratch project:
a fresh `keryx init --yes` plus `gdgraph build` produced artifacts and no
`.provenance.json` at all. Flow 280 fixed the separate diff-stage defect and left this
one documented in a comment in `src/commands/gdgraph.ts`, deliberately unfixed: the
repair belongs in the template, a wider surface than that flow's change.

## Expected

`keryx gdgraph build` leaves the same freshness record whichever path runs it — the
in-process build or the copied runner — or the delegation stops silently swallowing
that responsibility.

## Open question for the flow to answer

Where the repair belongs:

- the template (`src/lib/templates.ts`) gains the `recordProvenance` call, and every
  project picks it up on the next `keryx update`; existing projects stay broken until
  they update;
- or `gdgraphCommand` records provenance after the delegated run returns, so the
  behaviour is identical regardless of the copied runner's age;
- or the delegation is removed for `build`.

The second is the likely answer — it fixes every existing project without an update —
but the decision belongs to whoever reads the delegation's reason for existing.

## Out of scope

- The diff-stage stall fixed by flow 280.
- Any other command delegated to the copied runner (`query`, `affected`, …), unless
  the chosen repair changes them too.
