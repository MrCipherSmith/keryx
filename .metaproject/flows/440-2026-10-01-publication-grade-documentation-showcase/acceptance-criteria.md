# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `research/audit-report.md` exists and contains the documentation inventory, the docs-vs-code drift list, a best-practice gap table, and the target information architecture (README outline, site nav, page list per documentation area); `journal.md` records the owner's approval of that target IA dated before the first commit that changes `README.md`, `mkdocs.yml` or any file under `docs/docs/`.
- AC2: `README.md` has at most 1000 words outside fenced code blocks and contains, in its first screen, a logo, a one-line value proposition, at most 6 badges, an `English | Русский` switcher, an install one-liner and a link to the docs site; it contains a quickstart, a feature table whose rows link to docs-site pages, and a "where to go next" section.
- AC3: `README.ru.md` exists, mirrors the README's sections, links back to `README.md`, and carries a `synced-with` marker naming the commit of `README.md` it translates.
- AC4: `mkdocs.yml` nav has top-level sections Getting started, Guides, Modules, Concepts, Reference and Project; each of the 15 documentation areas in `research/code-truth.md` §2 has a page stating what it is, why to use it, a runnable example, and a link to its reference section; every Markdown file under the docs directory is in the nav or listed in `not_in_nav`.
- AC5: `mkdocs build --strict` exits 0, `bun scripts/check-doc-links.ts` reports 0 broken links, and `bun scripts/check-retired-cli-spellings.ts` reports 0 undeclared spellings on the final branch.
- AC6: A test fails when any subcommand listed in `src/lib/group-subcommands.ts` is absent from `docs/docs/cli-reference.md`, and it passes on the final branch; every item marked wrong or stale in `research/code-truth.md` §3.2 and §3.4 is fixed or recorded in `journal.md` with a reason it was left.
- AC7: Every command in the README quickstart and the Getting started tutorial is executed verbatim in a fresh temporary directory, and the transcript with exit codes is saved under the flow's `artifacts/`.
- AC8: A "Built with Keryx" page explains the committed `.metaproject/` record (structure, flow anatomy, worked example, review loops, memory and rules, honest limits) and a "Project status" page states version, platforms, stable vs experimental features and project numbers; every number on both pages is reproduced by a command recorded in `journal.md`, and every linked flow is free of the hygiene findings in `research/metaproject-state.md` §6.
- AC9: `ARCHITECTURE.md`, `SUPPORT.md`, `ROADMAP.md` (or a stability statement page), a docs issue template, and an `llms.txt` served at the docs site root exist; `ARCHITECTURE.md` and the docs site are linked from the README; `package.json` has `homepage`, `bugs` and a description matching the README tagline.
- AC10: New and rewritten user-facing documentation contains no external project names, no "flow NNN" or ACn internal identifiers, and no comparison page, verified by a search recorded in `journal.md`.
- AC11: A review-orchestrator round over the final diff reports zero findings at blocker, major or minor severity.
