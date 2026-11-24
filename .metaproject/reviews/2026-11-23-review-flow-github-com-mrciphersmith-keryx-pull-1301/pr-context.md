# Pull request context: MrCipherSmith/keryx#1301

Head 9f4ec475bd93ff0a9d64c648ebc3c247cfd73a3a, collection round 1, collected 2026-11-23T21:05:29.939Z.

## Intent (round 1)

**feat(desktop): browse Metaproject files and wiki pages as a tree**

## Summary

Flow 518. Without a search, the Metaproject sidebar is now a tree instead of a flat list of the catalog's first 200 nodes: in **Graph**, indexed files by folder (folders first, with file counts; a module folder selects its module node); in **Wiki**, pages grouped by page type. Folders load on demand, so the whole project is reachable.

- **Core:** new read-only v2 action `tree` (`scope: graph | wiki`, optional `parent`, paged with snapshot-bound cursors, `not-found` / `stale-snapshot` / `invalid-input` like the other actions). Listed in `capabilities`; v1 unchanged.
- **Transport:** Rust `RequestV2::Tree` with validation and tests. The handshake still requires only the six existing actions, so an older CLI keeps working; Desktop learns `supportsTree` from the probe.
- **Desktop:** `MetaprojectTree` (WAI-ARIA tree, roving focus, Up/Down/Left/Right/Home/End/Enter/Space), `useMetaprojectTree` (per-scope expanded set and pages, retry per folder, Show more, snapshot changes), mounted in `MetaprojectView` only with no query and a CLI that offers `tree`. A selection made elsewhere reveals its path; the item shown by default on first open does not.
- **Docs:** the Desktop Metaproject guide describes the tree, keyboard and the older-CLI behaviour.

## Verification

- `bun test src/integrations` 443 pass; `bun run lint` and `bun run typecheck` exit 0.
- Desktop: `bunx tsc --noEmit` exit 0; `bun test src` 998 pass.
- `bun run docs:check` exit 0; `keryx health run` PASS.
- **Not run locally:** the Rust tests (`cargo test --locked metaproject`) — no Rust toolchain on the authoring machine; this PR's CI is the first run.
- No native walkthrough of the packaged app yet.

Flow package: `.metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/`.


## CI: pending

- opentui native (darwin-arm64): pending
- standard-pr: passing
- Core tests (1/4, offline): pending
- dependency-audit: passing
- Core tests (4/4, offline): pending
- Core tests (2/4, offline): pending
- Core tests (3/4, offline): pending
- opentui native (linux-arm64): passing
- AC8 remaining tests: pending
- deploy to GitHub Pages: skipped
- opentui native (linux-x64): passing
- Issues board, Projects and session-to-Flow acceptance: passing
- opentui native (darwin-x64): pending
- standard-baseline: passing
- client matrix (terminal): pending
- vscode-extension: passing
- wiki validate (gate) + freshness (report): passing
- client matrix (runtime): passing
- metrics-contract: passing
- linux sandbox (bubblewrap) live smoke: passing
- Desktop Metaproject graph and wiki acceptance: passing
- Lint and typecheck: passing
- client matrix (cancel-resume): passing
- client matrix (streaming): passing
- team-hub-distribution: pending
- mkdocs build --strict: passing
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- desktop check: pending

## Backend pins

_The pull request names none._

## Review comments (0, full text)

