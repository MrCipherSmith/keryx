# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: docs/requirements/keryx-native-distribution/specification.md §6
(AC1-AC7), carried forward with AC3/AC4/AC5 grounded in this flow's own
live re-verification (context.md) rather than the docpack's original,
partially-incorrect claims.

## Criteria

- AC1: All four platform binaries (darwin-arm64/x64, linux-x64/arm64) build successfully via the release.yml for-loop, on the existing single ubuntu-latest runner, no new runner matrix.
- AC2: Each binary passes a smoke test (`--help` exits 0, non-empty output) before being attached to a release, same rigor as the existing npm-tarball smoke test.
- AC3: `gdgraph build` against a real file succeeds from a compiled binary via GENUINE tree-sitter parsing (not the deterministic fallback) — verified by the T6 literal-import fix, not merely "the process didn't crash."
- AC4: `mcp serve` from a compiled binary is verified with a real, connecting MCP client performing a full handshake and at least one real tool listing — already satisfied by this flow's own live probe (context.md), reconfirmed in CI.
- AC5: The OpenTUI shell's native library load is verified from a compiled binary (already confirmed via a real `createCliRenderer()` construction in this flow's probe); full interactive-TTY verification remains best-effort (CI TTY emulation or manual check), named honestly if not fully exercised.
- AC6: The Homebrew formula installs and `keryx --version` matches the tagged release version, with the pinned SHA256 verified by `brew` itself.
- AC7: Existing npm and clone-based install paths are unchanged — release.yml's existing smoke-test step continues to pass unmodified.
