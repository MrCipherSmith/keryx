# Implementation Spec — Keryx update availability

Date: 2026-08-10
Agent: flow-orchestrator 1.2.0
Status: ready to freeze

## What

Implement a single typed npm version-check service and expose it through the
interactive shell, a machine-readable CLI command, and generated Metaproject
agent guidance. The feature is advisory and fail-soft; it never updates the
installation automatically or blocks project work.

## Why

The accepted project constraint `stale-installed-keryx-binary.md` records that
agents routinely execute an older installed CLI while reasoning about newer
source. A visible, bounded availability check reduces that mismatch without
turning shell startup into a network dependency.

## Scope

**In scope:** strict dependency-free SemVer, bounded registry response parsing,
typed operational outcomes, owner-only atomic user cache, one in-flight check
per shell launch, shared TUI notice, safe readline advisory, `version check`
text/JSON output, command registry, generated index guidance, tests and docs.

**Out of scope:** auto-upgrade, registry configuration, credentials, telemetry,
project-specific caches, blocking gates, and backporting to `0.2.17`.

## Approach

Use a new dependency-free service under `src/lib` with injected fetch/clock/
cache directory. It always resolves a discriminated union and never rejects for
operational failures. A fresh cache may answer immediately; otherwise one
bounded request refreshes it. `shellCommand` creates one promise before surface
selection and passes it to both TUI modes or queues it through readline IO.

The TUI notice is owned by shared shell chrome, is persistent and non-modal,
does not steal focus, and renders a fixed two-line upgrade command within the
26-column sidebar. The CLI consumes the same service. `renderIndexMarkdown`
adds best-effort once-per-session guidance rather than a misleading hard gate.

Rejected alternatives:

- `npm view` subprocess: slower, environment/config dependent, and harder to
  bound or test.
- Independent checks in each UI/index consumer: duplicate network/cache logic
  and divergent failure semantics.
- Comparing strings or only `major.minor.patch`: incorrect for prerelease and
  large numeric identifiers.
- Showing stale-cache upgrade advice: can recommend a downgrade after install.

## Steps

1. RED: add unit tests for strict SemVer, typed network outcomes, body bounds,
   fresh/stale/failure cache behavior and fixed update command.
2. GREEN: implement the version service and owner-only atomic cache.
3. RED/GREEN: add `keryx version check [--json]`, root help and command registry.
4. RED/GREEN: prove shell startup is not awaited; mount the same persistent
   advisory in agent/chat TUI and queue readline output safely.
5. RED/GREEN: update `renderIndexMarkdown` and prove init/update/rules-generated
   indexes contain non-blocking once-per-session guidance.
6. Update public docs and changelog, then run focused, changed-scope, full
   type/test, doc-link, security, standard, build/pack and Code Health gates.
7. Run independent logic/security/architecture review and resolve findings.

## Test Strategy

- Bun unit tests cover the SemVer precedence table, build metadata, prerelease,
  leading zero rejection and huge numeric identifiers.
- Service tests inject fetch/clock/cache dir for 200/equal/newer/older,
  timeout/offline/HTTP/malformed/oversized/version errors, exact TTL boundaries,
  corrupt cache and failure suppression without real network.
- CLI tests cover text/JSON output and operational exit code 0.
- Headless OpenTUI tests cover both modes, layout/focus stability and late
  completion after destroy; shell tests cover non-awaited startup and readline.
- Template/init/update/rules tests cover generated guidance. Existing no-network
  suites prove unrelated/default capability paths remain offline.

## Risks

- Concurrent shells could tear a cache without atomic replacement; use a
  same-directory temp + rename and tolerate invalid cache by refetching.
- Sidebar height is finite; keep the update panel bounded and do not expand
  worker output to compensate silently.
- Prompt guidance may be ignored; report it as advisory and make the CLI result
  factual rather than asking an agent to parse npm output itself.
- The first release containing this mechanism cannot be discovered by old code;
  document the one-time bootstrap limitation.
