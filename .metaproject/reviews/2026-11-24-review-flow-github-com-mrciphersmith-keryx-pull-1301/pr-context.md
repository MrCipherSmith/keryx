# Pull request context: MrCipherSmith/keryx#1301

Head f43a13c3f35e488744bb8906c2c275d433f8d98b, collection round 1, collected 2026-11-24T07:10:02.392Z.

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


## CI: passing

- typecheck-and-tests: passing
- AC8 full suite (5000 ms, preload): passing
- opentui native (linux-arm64): passing
- standard-pr: passing
- opentui native (linux-x64): passing
- metrics-contract: passing
- deploy to GitHub Pages: skipped
- vscode-extension: passing
- AC8 remaining tests: passing
- Core tests (1/4, offline): passing
- opentui native (darwin-x64): passing
- client matrix (cancel-resume): passing
- dependency-audit: passing
- desktop check: passing
- Desktop Metaproject graph and wiki acceptance: passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- linux sandbox (bubblewrap) live smoke: passing
- opentui native (darwin-arm64): passing
- Lint and typecheck: passing
- client matrix (runtime): passing
- client matrix (terminal): passing
- Core tests (4/4, offline): passing
- Core tests (3/4, offline): passing
- standard-baseline: passing
- Issues board, Projects and session-to-Flow acceptance: passing
- Core tests (2/4, offline): passing
- team-hub-distribution: passing
- wiki validate (gate) + freshness (report): passing
- mkdocs build --strict: passing
- client matrix (streaming): passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

