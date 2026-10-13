# Publication-grade documentation: showcase README, module docs site, Metaproject summary

Status: formalized 2026-10-01
Source: owner request (session 2026-10-01), research in `research/`

## Problem

Keryx is about to be announced on public platforms (HN, Reddit, Habr, X). Its
documentation was written by and for the people building it:

- `README.md` is 1076 lines; harness internals, Jev, remote entry and CI detail
  bury the first-run story. There is no demo, no OG image, a 1.36 MB logo with
  no dark variant.
- The published site (MkDocs Material, GitHub Pages,
  https://mrciphersmith.github.io/keryx/) is 37 pages organised around the
  source tree, not around what a newcomer wants to do. `cli-reference.md` is a
  6646-line hand-written file with ~40 verified drift items and 85 internal
  "flow NNN" references; `keryx --help` itself lists a fraction of the real
  subcommands. One published page is orphaned from the nav.
- ~663 internal files (requirements packages, decisions, reports, plans) sit
  under `docs/` beside the user pages with no map telling a visitor which is which.
- The committed `.metaproject/` (341 flows, 2867 tasks, 312 review rounds) is
  the strongest evidence of engineering discipline in the repo, and nothing
  explains it to a visitor. It also contains publication blockers: raw session
  transcripts, a personal email, an external project name.

## Expected Outcome

A visitor arriving from an announcement link can, within a minute, understand
what Keryx is, install it, and see it work; can then navigate from the README to
a docs site organised by task and by module; and can inspect how the project is
built through a curated page about the committed Metaproject record and a
concise project status summary. Documentation claims match the code, and CI
keeps the CLI reference from drifting again.

Language: English is canonical for README and the docs site; `README.ru.md` is
a maintained Russian translation of the README (owner decision 2026-10-01).

## Out of Scope

- Rewriting git history (removing already-pushed PII from history) — owner
  decision, separate operation.
- Migrating the site generator to Zensical (trial build only, non-blocking).
- A "Keryx vs X" comparison page — project rule forbids naming external
  projects in Keryx docs.
- Translating the docs site (beyond README) into Russian.
- Relocating the internal `docs/requirements|decisions|analysis|...` trees
  (hundreds of inbound references); they are mapped and labelled, not moved.
- Code behavior changes, except help-text strings and a docs coverage test.
