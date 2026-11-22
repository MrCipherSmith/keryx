# Native verification

On 2026-11-22, Keryx Desktop 0.2.11 built from `06a0f7ab2` as the isolated `dev.keryx.desktop.metaproject512` QA bundle.

The bundled CLI returned a complete catalog through a pipe from the Keryx checkout. It included 4,596 files and assets, 125 wiki pages, 198 modules and 24,655 relationships. The CLI reported a stale graph and returned the catalog without truncating it.

Searching for “Wiki, Graph, and Shared Agent Context” found `wiki:architecture/wiki-graph-sac.md`. Its outgoing `describes` links included `src/wiki/service.ts`, whose incoming imports included `src/commands/wiki.ts`. The CLI catalog took 2.26 s on the first call. Search took 0.46 s and each relationship request took 0.42 s.

AC6 remains open. The Mac was locked and the QA app window was unavailable. Native navigation, mode switching, keyboard interaction and UI timings still need to be observed with `Keryx Metaproject QA.app` on the Keryx checkout.

The same source commit passed [GitHub CI](https://github.com/MrCipherSmith/keryx/actions/runs/45006454991) and [Desktop Check](https://github.com/MrCipherSmith/keryx/actions/runs/45006455074) in [Draft PR #1283](https://github.com/MrCipherSmith/keryx/pull/1283). Automated tests ran in GitHub Actions.
