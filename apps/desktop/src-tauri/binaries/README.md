# Sidecar binaries

`tauri.conf.json` declares `bundle.externalBin: ["binaries/keryx"]`, so the
build expects `keryx-<target-triple>` in this folder (for example
`keryx-aarch64-apple-darwin`). `scripts/desktop/build-sidecar.sh` produces
them. Nothing in here except this file is committed.

For a quick local `cargo build` or `tauri dev` you can point the expected name
at any executable, for example a wrapper that runs a development keryx:

```sh
printf '#!/bin/sh\nexec bun run /path/to/keryx/src/cli.ts "$@"\n' \
  > keryx-aarch64-apple-darwin && chmod +x keryx-aarch64-apple-darwin
```
