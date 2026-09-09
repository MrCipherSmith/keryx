# T18 implementation spec: owner identity replacement race

## Contract

The shared contained reader must authorize a canonical path and then open the same owner root and target that were authorized. A replacement of the owner root with another real directory, or replacement of the resolved regular target before descriptor opening, must fail closed with the existing typed race error. Internal symlinks remain allowed when their canonical target remains inside the owner root. SAC continues to use the descriptor primitive and its no-follow chain. Unsupported backends, FIFO rejection, and byte limits retain their existing behavior.

## Design

1. Capture the owner root `dev`/`ino` identity during authorization in `readContainedFile`.
2. Resolve the requested path and capture the canonical target `dev`/`ino` identity before the async pre-open hook.
3. Pass both identities to `readDescriptorChainAsync`.
4. Recheck the pinned root identity before opening and compare the opened root descriptor with the same identity. Compare the final descriptor with the pinned target identity before reading.
5. Add deterministic RED/GREEN tests that replace the owner root with another real directory and replace the target at the same path after canonical resolution.

## Scope

Owned files: `src/lib/contained-read.ts`, `src/lib/descriptor-read.ts`, and `src/lib/contained-read.test.ts`. No dependency, flow, package, or unrelated source changes.

## Initial RED evidence

Before the implementation, the two new regression cases failed because the replacement directory/file bytes were returned. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-15-49-060Z_run.log`.
