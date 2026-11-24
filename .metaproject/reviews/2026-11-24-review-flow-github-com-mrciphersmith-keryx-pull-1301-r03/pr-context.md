# Pull request context: MrCipherSmith/keryx#1301

Head 3ad918b66a990c7f0b04180e17d9fb74fb82713a, collection round 1, collected 2026-11-24T08:58:05.044Z.

## Intent (round 1)

**feat(desktop): browse Metaproject files and wiki pages as a tree**

## Summary

Flow 518. Without a search, the Metaproject sidebar is now a tree instead of a flat list of the catalog's first 200 nodes: in **Graph**, indexed files by folder (folders first, with file counts; a module folder selects its module node); in **Wiki**, pages grouped by page type. Folders load on demand, so the whole project is reachable.

- **Core:** new read-only v2 action `tree` (`scope: graph | wiki`, optional `parent`, paged with snapshot-bound cursors, `not-found` / `stale-snapshot` / `invalid-input` like the other actions). Listed in `capabilities`; v1 unchanged.
- **Transport:** Rust `RequestV2::Tree` with validation and tests. The handshake still requires only the six existing actions, so an older CLI keeps working; Desktop learns `supportsTree` from the probe.
- **Desktop:** `MetaprojectTree` (WAI-ARIA tree, roving focus, Up/Down/Left/Right/Home/End/Enter/Space), `useMetaprojectTree` (per-scope expanded set and pages, retry per folder, Show more, snapshot changes), mounted in `MetaprojectView` only with no query and a CLI that offers `tree`. A selection made elsewhere reveals its path; the item shown by default on first open does not.
- **Docs:** the Desktop Metaproject guide describes the tree, keyboard and the older-CLI behaviour.

## Review fixes

Three managed review rounds; their fixes are in this PR.

- Round 1 fixes: focus stays in the tree when a focused status row changes or leaves; tree reads are bounded to 3 in flight (Desktop's 8 read permits are shared); a v2 answer for another snapshot is refused as `stale-snapshot` in the transport for every action, so search Load more shows the Refresh catalog banner instead of "Incompatible … Choose the bundled CLI"; module folders show a **Module** label; the untyped wiki group key is one helper shared by core and Desktop.
- Round 2 fixes: focus moves to the right row when a page or two folders' answers land together; a stale-snapshot tree read shows only the banner (no Retry that cannot succeed); a read refused because every permit is busy is retried twice with a short jittered wait before the folder shows the error.
- Round 3 fixes: a tree read refused as stale-snapshot is parked and every catalog load re-reads it, so Refresh catalog recovers it even when the snapshot id comes back unchanged; the read-permit refusal is classified once in the platform transport; a replaced status row hands focus within its own parent.

## Verification

- At the head: `cd apps/desktop && bunx tsc --noEmit && bun test src` exit 0, 1019 pass. Core tree and explorer tests pass; `bun run lint`, `bun run typecheck`, `bun run docs:check` exit 0 (re-run after round 1; rounds 2-3 touched only Desktop).
- CI on the round-1 head ran the Rust `cargo test --locked metaproject` and passed.
- Not run: no native walkthrough of the packaged app; focus behaviour is checked in the DOM test environment only.

Flow package: `.metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/`.




## CI: pending

- typecheck-and-tests: passing
- AC8 full suite (5000 ms, preload): passing
- desktop check: pending
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- standard-pr: passing
- metrics-contract: passing
- client matrix (terminal): passing
- team-hub-distribution: passing
- opentui native (linux-x64): passing
- opentui native (darwin-x64): passing
- Core tests (3/4, offline): passing
- AC8 remaining tests: passing
- Core tests (4/4, offline): passing
- opentui native (darwin-arm64): passing
- linux sandbox (bubblewrap) live smoke: passing
- Core tests (2/4, offline): passing
- vscode-extension: passing
- client matrix (cancel-resume): passing
- Desktop Metaproject graph and wiki acceptance: passing
- client matrix (runtime): passing
- Issues board, Projects and session-to-Flow acceptance: passing
- Lint and typecheck: passing
- dependency-audit: passing
- deploy to GitHub Pages: skipped
- wiki validate (gate) + freshness (report): passing
- Core tests (1/4, offline): passing
- mkdocs build --strict: passing
- client matrix (streaming): passing
- opentui native (linux-arm64): passing
- standard-baseline: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

