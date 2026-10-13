# Implementation Plan

Status: proposed 2026-10-01, awaiting owner approval before freeze

## Approach

Two stages inside one flow, with an owner gate between them.

**Stage A — audit and target design (no public file changes).** Consolidate the
four research files into `research/audit-report.md`: inventory, docs-vs-code
drift, best-practice gap table, hygiene blockers, and the target information
architecture (README outline, site nav, page list per area). The owner approves
the target IA before Stage B touches any published file (task T6 is that gate).

**Stage B — build.** Rewrite README as a showcase (~700-1000 words of prose,
mise-style: hero, install, 30-second quickstart, feature table, "where to go
next"), move its depth into the site, restructure the MkDocs nav along Diátaxis
(Getting started / Guides / Modules / Concepts / Reference / Project), write one
page per documentation area (15 areas from `research/code-truth.md` §2), add the
"Built with Keryx" and "Project status" pages, fix CLI reference drift and put a
subcommand-level coverage test under it, add missing meta-files, and do the
pre-publication hygiene of tracked `.metaproject` content.

Decisions taken (settled; do not re-litigate during execution):

- Site generator: stay on Material for MkDocs, pin versions; use only plugins
  Zensical also supports; add a non-blocking Zensical trial build job.
- CLI reference: keep the hand-written `cli-reference.md` (it carries prose
  the help text lacks), fix drift, strip internal flow/AC ids, and extend
  `cli-reference-coverage.test.ts` from verb level to every subcommand in
  `src/lib/group-subcommands.ts`. Make `keryx --help` list real subcommands or
  defer to `keryx <group> --help`. A full generator is rejected for now: it
  would discard the reference's prose and is a larger change than the drift.
- Internal docs stay where they are; `docs/README.md` becomes a map separating
  "User documentation (site)" from "Project records".
- No comparison page; no external project names anywhere in new content.
- Russian: `README.ru.md` with a `synced-with` marker; site stays EN.
- Demo: a terminal recording generated reproducibly (VHS tape committed) if the
  tool can be installed locally; otherwise a static hero screenshot, and the
  recording becomes an owner follow-up recorded in the journal.

Rejected alternatives: full autodoc regeneration of all docs (would discard the
accurate existing guides); Zensical migration now (0.0.x, no i18n, strict
parity unverified); moving internal docs to `docs/internal/` (breaks hundreds
of references for cosmetic gain).

## Steps

See `tasks.md` (T5-T19). Order constraints: T5 → T6 (owner gate) → everything
in Stage B; T7 (hygiene) before T13 (Built-with-Keryx page links flows);
T8 (drift + test) before T11 (reference pages); T17 verification after all
content tasks; T18 review last.

## Risks

- Scale: ~40 pages to write or rewrite. Mitigation: workers per area in
  parallel lanes with disjoint files; boundary commits per task.
- Accuracy: new prose can drift as fast as old. Mitigation: every command in
  new pages is executed or checked against `--help` by the verification task;
  coverage test guards the reference.
- PII already in public history: removing from the tree does not remove it
  from history; reported to the owner as a separate decision.
- Concurrency: other sessions merge to main daily; rebase before PR and run a
  merge-tree check against open PRs.
