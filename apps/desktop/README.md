# Keryx Desktop

A macOS Tauri v2 app (`dev.keryx.desktop`) that talks to `keryx acp --profile shell`.
Rust core in `src-tauri/`, React 18 + Vite + TypeScript in `src/`. Contract:
`docs/requirements/keryx-desktop-client/specification.md`.
Installing and using the app: `docs/docs/desktop-app.md`.

Toolchain: Rust (rustup), Bun. The app is not part of the root workspace
(same as `apps/hub-web`): it has its own `package.json` and `bun.lock`.

## Dev loop

```sh
bun install --frozen-lockfile  # from the repository root, for the CLI and its bundled parser
cd apps/desktop
bun install
bun run tauri dev        # starts vite on :1420 and the native window
```

`bundle.externalBin` is `binaries/keryx`, so `cargo build` and `tauri dev`
need `src-tauri/binaries/keryx-<target-triple>` to exist (for this machine:
`keryx-aarch64-apple-darwin`). `scripts/desktop/build-sidecar.sh` produces the
real one; for a quick loop, make it a wrapper (nothing in `binaries/` except the
README is committed):

```sh
printf '#!/bin/sh\nexec bun run /path/to/keryx/src/cli.ts "$@"\n' \
  > src-tauri/binaries/keryx-aarch64-apple-darwin
chmod +x src-tauri/binaries/keryx-aarch64-apple-darwin
```

## Browser dev mode (no Tauri)

To iterate on the web view in a plain browser:

```sh
cd apps/desktop
bun install
bun run dev:browser      # dev bridge on ws://127.0.0.1:1421 + Vite on http://localhost:1420
```

Open http://localhost:1420. The welcome screen lists this repository as a
recent project (override with `KERYX_DEV_PROJECT=/path`); "Open Folder…" asks
for a path in-app, since a browser has no folder picker.

`dev/bridge.ts` is a Bun stand-in for the Rust core. It implements the same
commands (`acp_start` / `acp_send` / `acp_stop`, `settings_*`,
`version_check`, `flows_list` / `flows_get` / `flows_action` / `flows_watch`)
and events (`acp://message`, `acp://exit`, `flows://changed`, polled every
2 s), answers `fs/read_text_file` itself inside the project folder, and
spawns keryx as:

```sh
$KERYX_DEV_CMD acp --profile shell     # default: bun --no-env-file --config=/dev/null <repo>/src/cli.ts
```

Settings are kept in `~/.keryx-desktop-dev/settings.json`. The bridge listens
on loopback and accepts only the Vite origin. The web view picks its host at
runtime: Tauri when `window.__TAURI_INTERNALS__` exists, else (only in a Vite
dev build) the bridge. Production builds do not contain the bridge client;
`bun run build && grep -r 1421 dist` finds nothing.

`bun run dev:bridge` runs the bridge alone (for example next to `bun run dev`).

## Pointing the app at a development keryx

Settings has three sources: bundled, `PATH`, custom. For a dev build choose
**Custom path** and select a wrapper script, for example:

```sh
#!/bin/sh
exec bun run /path/to/keryx-worktree/src/cli.ts "$@"
```

The app runs `<keryx> acp --profile shell` with the project folder as cwd. A
keryx that rejects `--profile` is retried without it and the window shows
"this keryx has no shell profile". The minimum supported keryx is
`MIN_KERYX_VERSION` in `src-tauri/src/version.rs`.

How the binary is found at runtime: `bundled` looks for `keryx` next to the
main executable (`Keryx.app/Contents/MacOS/keryx`; Tauri strips the target
triple when bundling), falling back to `keryx` on the login-shell `PATH`.

Environment: the app captures your login-shell environment once at startup
(`$SHELL -ilc 'env -0'`, 5 s timeout) so `PATH` and provider API keys from your
shell rc files reach keryx even when the app is launched from Finder.

Logs: keryx stderr goes to `<app log dir>/keryx-acp-<window>.log`
(`~/Library/Logs/dev.keryx.desktop/`).

## Checks

```sh
bun run build                         # tsc --noEmit && vite build
cd src-tauri && cargo test            # framing, locator, fs confinement, versions, settings
cd src-tauri && cargo build
```

Live smoke against a real keryx (ignored by default):

```sh
cd src-tauri
KERYX_BIN=/path/to/keryx-wrapper cargo test --test live_smoke -- --ignored --nocapture
```

## Build

The release bundle is built from the repo root with `bun run desktop:build`
(sidecar first, then `tauri build`), or by the `desktop-release.yml` workflow.
