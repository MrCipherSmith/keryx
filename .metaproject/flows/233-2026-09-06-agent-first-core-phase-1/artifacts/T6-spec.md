# T6 pre-code specification — contained resource readers

Scope is limited to `src/lib/descriptor-read.ts`, `src/lib/contained-read.ts`,
`src/sac/secure-resource-read.ts`, `src/mcp/resources.ts`,
`src/harness/tool/metaproject-adapter.ts`, and the adjacent harness health
result union. No dispatch, redaction, security-service, package, lock,
flow-state, or unrelated files.

## Implementation contract

- `descriptor-read.ts` owns the POSIX/Bun `openat`/read/close bridge. It opens
  the owner directory and every canonical relative component with
  `O_NOFOLLOW`. It checks root and final descriptor identity, rejects
  non-regular files before reading, and supports a byte cap. Unsupported
  descriptor constants/FFI fail with the existing SAC-safe capability message.
- `secure-resource-read.ts` remains a SAC wrapper preserving
  `readWorkspaceFileNoFollow` path validation, `O_NOFOLLOW` semantics, and
  existing error text. MCP/harness import the shared lib only.
- `contained-read.ts` exports `readContainedFile(ownerRoot, candidatePath,
  options?) => Promise<Buffer>` and `ContainedReadError`. It rejects a
  symlinked/replaced owner root, canonicalizes internal links, refuses
  escapes/nonfiles/oversize reads, uses the descriptor chain, and exposes a
  deterministic `beforeOpen` hook plus an unsupported-backend fixture for
  tests. Error messages are static and contain no caller path.
- MCP resources use per-class roots, canonical owner/root identity,
  cycle-aware traversal with internal links, regular-file checks, and the
  shared reader for reads. External links and root replacement are
  absent/rejected without target disclosure.
- Harness wiki direct reads and skills catalog/load use the same shared reader.
  Catalog traversal follows internal links once by canonical directory
  identity, skips external/cyclic targets, and retains project-relative paths.
  The configured health port result accepts `incomplete`.

## Verification plan

Run the focused T5 suites, focused SAC regressions if needed, and
`bun run typecheck`. Do not run the full test suite while other RED work is
active.

