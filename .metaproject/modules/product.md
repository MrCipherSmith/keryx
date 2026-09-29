# product

Version: 0.1.0

## Purpose

Reads what the product set out to do out of the flows and requirements
packages the project already holds, into a disposable index, and lists the
intents closed in code that nobody has looked back at. It only reports:
nothing here gates a flow, calls a model or runs by itself.

## Commands

- `keryx product index [--json]` (reads every `.metaproject/flows/<id>-…/`
  and `docs/requirements/*/`; writes the index; reports the entries that state
  no intent)
- `keryx product open [--json]` (intents closed in code with no observation,
  each with its flow and outcome criterion, or `not measured — no instrument
  stated`; refuses to answer from a missing, unreadable or stale index and names
  `keryx product index`; stale means the index's content fingerprint of the
  flow and requirements files differs from the tree, never a file time)

An outcome criterion is a `## Outcome criteria` section in the flow's
`description.md` (`flow init` leaves the slot; an untouched hint is not a
criterion; `not measured — <reason>` is no instrument). An observation is a line
at column 0 of the flow's `journal.md`: `outcome-observed: <verdict> — <note>`,
verdict one of `helped`, `no-effect`, `harmed`, `inconclusive`. A requirements
package records `- <verdict> — <note>` under `## Outcome observations` in its
README.md (stored only; the package stays open). `index` reads it, and that
flow leaves the `open` list. A malformed line is a failure naming the flow or
package: `index` exits non-zero and the flow stays in the `open` list.

Each flow intent also carries who wrote its outcome criterion, `outcomeAuthor`
in flow.json: `agent`, `human`, or `unknown` for a flow that never recorded it.
`keryx flow init --outcome-author agent|human` sets it (`agent` when the flag is
absent, `human` only when the flag says so, never inferred);
`keryx flow outcome author <id> agent|human --reason "<why>"` changes it. That
setter is a `flow` command, not a product command: this module keeps its two
commands. The index stores the author (optional, so an older index stays valid),
`product open` and `flow status` print it, and the TUI shows it. It labels the
sample for G1a (four cells: `human`/`agent` by real criterion/`not measured`)
and gates nothing. The flow field is read through the flow facade.

## Data

- `data/product/index.json` (disposable: delete `data/product/` and `index`
  rebuilds an equivalent index, byte for byte; it carries the sha256
  `fingerprint` of the sources it was read from, and no clock)
