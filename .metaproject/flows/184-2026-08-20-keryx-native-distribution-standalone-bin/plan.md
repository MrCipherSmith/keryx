# Implementation Plan

## Steps

1. **T6 first** (tree-sitter fix) — do this before T5/T10 so the CI build
   loop can be verified against genuinely-working tree-sitter, not the
   fallback. Add a literal `await import("web-tree-sitter")` fast path in
   `src/gdgraph/treesitter/adapter.ts` (or its direct caller), tried
   before/instead of routing through `src/capability/seam.ts`'s generic
   `resolveCapability` for this one capability specifically. Do NOT modify
   `seam.ts`'s `await import(spec.optionalDependency)` line — locked by
   `no-treesitter-import.test.ts:50`. When the literal import fails
   (dependency genuinely absent, e.g. a minimal npm install without
   optional deps), fall back to the existing deterministic behavior —
   never crash, never regress the current graceful-degradation contract.
   Prove it with a real `bun build --compile` + run test, not just unit
   tests against the dev-mode `bun run` path (dev mode already worked
   before this fix; the whole point is the compiled-binary case).
2. **T5** — release.yml build loop (4 targets), smoke test each, attach to
   `gh release create`.
3. **T8** — `scripts/install-binary.sh`, additive, installs to the same
   `~/.local/bin/keryx` `install.sh --global` uses.
4. **T7** — Homebrew formula + new tap repo `MrCipherSmith/homebrew-keryx`
   (user-approved). SHA256s cannot be real until a real release exists;
   stage the formula with placeholder/templated checksums and a clear
   note that they must be filled from the first real tagged release —
   do not fabricate checksums.
5. **T9** — correct specification.md/decisions.md's tree-sitter claim;
   record the MCP/opentui verification evidence accurately.
6. **T10** — CI verification of the build loop without a real release:
   either a separate, safe-to-run workflow (e.g. a `workflow_dispatch`-
   triggered test job that runs the same build+smoke-test steps but does
   NOT publish/tag) or local reproduction of the exact loop from
   specification.md §1. Do not push a `v*` tag — that triggers a real,
   irreversible-in-spirit publish (npm publish + GitHub Release).

## Risks

- Pushing a real release tag would publish a real npm version and GitHub
  Release — never do this as part of verification. Use a separate
  `workflow_dispatch`-triggered CI job or local builds instead.
- The Homebrew formula's checksums are only real once a real release
  exists — this flow ships the mechanism, not necessarily a fully
  populated first formula version, unless the user later cuts a real
  release and asks for the formula to be finalized.
