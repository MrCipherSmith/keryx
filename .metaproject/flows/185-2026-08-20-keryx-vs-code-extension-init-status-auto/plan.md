# Implementation Plan

## VS Code MCP config shape (researched live, WebSearch+WebFetch against
official code.visualstudio.com docs — not assumed from training data)

`.vscode/mcp.json`, top-level `servers` object (NOT `mcpServers`). Each
stdio entry: `{"type": "stdio", "command": "keryx", "args": ["mcp",
"serve", ...], "cwd"?, "env"?}`. Distinct enough from every existing
runtime (`fileRuntime`'s `mcpServers` shape, `OPENCODE_RUNTIME`'s `mcp`
shape) that `VSCODE_RUNTIME` needs its own merge/strip/validate/hasManaged
functions, mirroring `OPENCODE_RUNTIME`'s pattern in the same file
(read it in full — it's the closest existing template for "a runtime
with a genuinely different top-level key and entry shape").

## Structure

- `src/mcp/client-config.ts`: additive `VSCODE_RUNTIME` export (T5).
- New `vscode-extension/` directory at the repo root (sibling to `src/`):
  own `package.json` (VS Code extension manifest: `engines.vscode`,
  `activationEvents`, `contributes.viewsContainers/views/commands`),
  own `tsconfig.json`, `src/extension.ts` entry point. This is
  deliberately OUTSIDE the core CLI's zero-dependency/lazy-SDK-import
  policy (`no-optional-imports.test.ts` scans `src/` at the repo root,
  i.e. `/Users/.../keryx/src/`, not `vscode-extension/src/` — confirm
  this scoping before assuming the guard doesn't apply, don't just assert
  it).

## Steps

1. T5 first (small, unblocks nothing else technically but is the "core
   keryx" half of Requirement 3 — do it early).
2. T6: extension scaffold + activation + init/status flow. This is the
   foundation every other surface (status bar, tree view, etc.) mounts
   on.
3. T7-T10 can be built in parallel once T6's scaffold exists (status bar,
   tree view, output channel, hover — each touches a distinct new file
   under `vscode-extension/src/`).
4. T11: consolidate tests, write the AC evidence table (same style as
   flow 182/183's), honestly marking AC3/AC9 partial.

## Risks

- No VS Code/vsce in this environment — AC3/AC9 cannot be fully
  live-verified (see description.md's "Known environment limitation").
  Do not fabricate a "verified end to end" claim for either.
- The extension's `package.json` needs real VS Code contribution-point
  schema correctness (activation events, view container ids matching
  between `viewsContainers`/`views`/`registerTreeDataProvider` calls) —
  a typo here is invisible without a real VS Code instance to catch it.
  Cross-check every id string is used consistently across the manifest
  and the TypeScript that registers against it.
