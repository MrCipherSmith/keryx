# Flow 142 Change Report

Status: verified implementation, awaiting the user's completion choice

## Outcome

Keryx now has one dependency-free, fail-soft version-check service shared by
the explicit CLI and every `keryx shell` surface. It checks only npm's fixed
package endpoint, never installs automatically, and recommends the fixed manual
command only when a validated SemVer is strictly newer.

## Implementation

- Added strict SemVer 2.0 parsing and BigInt precedence comparison, a 64 KiB
  response cap, a 2-second abort timeout, 24-hour success caching, and 15-minute
  failure suppression in `src/lib/version-check.ts`.
- Added an owner-only atomic cache write and a bounded filesystem critical
  section that re-reads committed state before merge, preventing a concurrent
  failed request from erasing a fresh successful result.
- Added `keryx version check [--json]`, strict argument validation, root help,
  and a machine-readable command-registry descriptor.
- Started exactly one version-check promise before shell provider/surface
  startup. Agent and chat TUI share a reserved persistent sidebar slot;
  readline queues the notice until a safe IO boundary.
- Added generated Metaproject guidance to check once per session and treat
  offline, timeout, unavailable, and unknown-command outcomes as non-blocking.
- Updated README, CLI/workflow documentation, changelog, and the managed
  `.metaproject/index.md` output.

## Independent review and fixes

The Sol review reproduced seven findings before handoff. All were fixed and
covered by tests: valid network results now survive cache-write failure;
concurrent cache merge preserves success; a late TUI notice stays above a full
sidebar; declared oversized bodies are cancelled; CLI arguments are strict;
cached SemVer length is bounded; and timeout tests use an injected scheduler
instead of real wall-clock delay.

## Verification evidence

- Flow-focused service/CLI/TUI/readline tests: 75 passed, 0 failed.
- Changed-scope Keryx report: 347 passed, 0 failed across 20 selected files
  when `TMPDIR` uses its canonical `/private/tmp` path. The first run exposed a
  pre-existing macOS `/var` versus `/private/var` session-key fixture mismatch;
  no feature test failed.
- TypeScript: `bunx tsc --noEmit` passed.
- Documentation links: 632 checked, 0 broken.
- Security corpus: 50 cases; every detector stayed within its FN-rate ceiling.
- Metaproject Standard: passed with the existing missing `data/tasks` warning.
- Build and dry-run npm pack: passed; the pack contains the built CLI and
  remains dependency-free. The first pack attempt hit the user's root-owned npm
  cache and passed on retry with an isolated temporary cache.
- Code Health: PASS, score 93, no P0/P1 findings. Existing P2 complexity and
  missing optional coverage/test-source signals remain baseline warnings.
- Repository-wide suite observed 3063 passing, 14 skipped, and 90 unrelated
  environment/baseline failures, dominated by live-listener restrictions and
  macOS path normalization. Changed-scope and feature suites are green.

## Limitations

- A release installed before this feature cannot discover the first
  feature-bearing release through code it does not yet contain.
- Existing projects receive the agent instruction only after their generated
  Metaproject index is refreshed.
- The index text is prompt guidance, not an enforced gate; network or command
  unavailability never blocks project work.
