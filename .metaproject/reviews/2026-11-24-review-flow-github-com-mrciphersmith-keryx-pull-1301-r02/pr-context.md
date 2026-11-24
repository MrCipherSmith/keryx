# Pull request context: MrCipherSmith/keryx#1301

Head b2043b98dba98f8b86bbd444e1e2ac99a88a4e1a, collection round 1, collected 2026-11-24T07:42:28.816Z.

## Intent (round 1)

**feat(desktop): browse Metaproject files and wiki pages as a tree**

## Summary

Flow 518. Without a search, the Metaproject sidebar is now a tree instead of a flat list of the catalog's first 200 nodes: in **Graph**, indexed files by folder (folders first, with file counts; a module folder selects its module node); in **Wiki**, pages grouped by page type. Folders load on demand, so the whole project is reachable.

- **Core:** new read-only v2 action `tree` (`scope: graph | wiki`, optional `parent`, paged with snapshot-bound cursors, `not-found` / `stale-snapshot` / `invalid-input` like the other actions). Listed in `capabilities`; v1 unchanged.
- **Transport:** Rust `RequestV2::Tree` with validation and tests. The handshake still requires only the six existing actions, so an older CLI keeps working; Desktop learns `supportsTree` from the probe.
- **Desktop:** `MetaprojectTree` (WAI-ARIA tree, roving focus, Up/Down/Left/Right/Home/End/Enter/Space), `useMetaprojectTree` (per-scope expanded set and pages, retry per folder, Show more, snapshot changes), mounted in `MetaprojectView` only with no query and a CLI that offers `tree`. A selection made elsewhere reveals its path; the item shown by default on first open does not.
- **Docs:** the Desktop Metaproject guide describes the tree, keyboard and the older-CLI behaviour.

## Review fixes

Two managed review rounds; their fixes are in this PR.

- Round 1 fixes: focus stays in the tree when a focused status row changes or leaves; tree reads are bounded to 3 in flight (Desktop's 8 read permits are shared); a v2 answer for another snapshot is refused as `stale-snapshot` in the transport for every action, so search Load more shows the Refresh catalog banner instead of "Incompatible … Choose the bundled CLI"; module folders show a **Module** label; the untyped wiki group key is one helper shared by core and Desktop.
- Round 2 fixes: focus moves to the right row when a page or two folders' answers land together; a stale-snapshot tree read shows only the banner (no Retry that cannot succeed); a read refused because every permit is busy is retried twice with a short jittered wait before the folder shows the error.

## Verification

- At the head: `cd apps/desktop && bunx tsc --noEmit && bun test src` exit 0, 1014 pass. Core tree and explorer tests pass; `bun run lint`, `bun run typecheck`, `bun run docs:check` exit 0 (re-run after round 1; round 2 touched only Desktop).
- CI on the round-1 head ran the Rust `cargo test --locked metaproject` and passed.
- Not run: no native walkthrough of the packaged app; focus behaviour is checked in the DOM test environment only.

Flow package: `.metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/`.



## CI: pending

- Issues board, Projects and session-to-Flow acceptance: passing
- Core tests (1/4, offline): pending
- Lint and typecheck: pending
- client matrix (streaming): passing
- client matrix (cancel-resume): passing
- opentui native (darwin-arm64): passing
- deploy to GitHub Pages: skipped
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- standard-pr: pending
- opentui native (darwin-x64): pending
- opentui native (linux-arm64): passing
- AC8 remaining tests: pending
- mkdocs build --strict: passing
- desktop check: pending
- team-hub-distribution: pending
- client matrix (runtime): passing
- standard-baseline: passing
- dependency-audit: passing
- metrics-contract: passing
- Core tests (3/4, offline): pending
- vscode-extension: passing
- opentui native (linux-x64): passing
- Core tests (2/4, offline): pending
- client matrix (terminal): passing
- wiki validate (gate) + freshness (report): passing
- linux sandbox (bubblewrap) live smoke: passing
- Core tests (4/4, offline): pending
- Desktop Metaproject graph and wiki acceptance: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

