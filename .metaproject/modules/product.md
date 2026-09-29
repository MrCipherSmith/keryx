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
  stated`; refuses to answer from a missing or stale index and names
  `keryx product index`)

An observation is a line beginning `outcome-observed:` in the flow's
`journal.md`. `index` reads it, and that flow leaves the `open` list.

## Data

- `data/product/index.json` (disposable: delete `data/product/` and `index`
  rebuilds an equivalent index, byte for byte)
