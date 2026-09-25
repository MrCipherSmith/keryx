# W7: gdgraph and gdctx correctness — ctx defects, read-only git allowlist, correctness benchmark, slim index

Status: formalized
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (W7-AC1..AC9), prd.md R7.1-R7.8, implementation-plan.md Wave 0.
Base branch: feat/agent-platform-expansion. Owner: MrCipherSmith.

## Problem

Every later workstream routes navigation, search and large-output reading through
`keryx ctx` and `keryx gdgraph`. Three live defects make agents route around them:

- GDCTX-1: `ctx run` promotes ordinary stdout lines to "Errors / Warnings" by English
  keyword stem (`refuse`, `cannot`, `crash`) even on exit 0 with empty stderr
  (`src/ctx/lines.ts` `FAILURE_STEMS`, applied to the merged stream).
- GDCTX-2: `ctx read` redacts public badge/image URLs as `[REDACTED:url]` in files it
  itself tags `source: "trusted-project"`; `src/security/resolve.ts` never consults the source.
- GDCTX-3: `ctx rg -il` is rejected while `-i -l` works (`buildRgCommand` has no bundle expansion).

Plus hook friction (bounded read-only git commands blocked or routed), no golden
correctness benchmark in CI, freshness note not audited on every gdgraph query path,
the index hard-gate budget not enforced by a test, and zero memory hits for gdctx/gdgraph.

## Expected Outcome

The three defects fixed with regression tests; `GIT_READONLY_ALLOW` in the ctx hook;
golden gdgraph-edge and gdctx fact-preservation fixtures run by `bun test` in CI;
every gdgraph query path prints the freshness note; index gate ≤400 tokens enforced by
a test against both the template and the live file; four known-mistake memory entries.

## Out of Scope

- The escape-marker audit log (W6 hook composition).
- Fixing `orient`'s hook point (follow-on per W7 §5).
- A broader source-blindness audit of every SecurityCategory (W8 input).
- Fixing GDGRAPH-3 (`tsconfig extends`) beyond a fixture that records current behavior,
  unless the fixture shows the fix is a small bounded change.
