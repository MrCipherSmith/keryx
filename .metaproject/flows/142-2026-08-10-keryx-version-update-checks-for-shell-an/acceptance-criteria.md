# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: One dependency-free version-check service validates a fixed npm registry endpoint, uses strict SemVer 2.0 precedence, and returns typed `update-available`, `up-to-date`, or `unavailable` outcomes; only a strictly newer validated version carries the fixed npm install command.
- AC2: The service bounds registry bodies to 64 KiB, times out after 2 seconds, caches successful metadata for 24 hours, suppresses repeated failures for 15 minutes, persists through an owner-only atomic user-global cache, and never uses stale metadata to recommend an update.
- AC3: `keryx version check` supports human and `--json` output from the shared service, returns exit 0 for typed operational unavailable states, is registered in root help and the command registry, and never auto-installs an update.
- AC4: `keryx shell` starts exactly one check without awaiting it before provider/surface startup; both agent and chat TUI show the current-to-latest versions plus the complete fixed npm command in a persistent non-modal sidebar notice only for `update-available`.
- AC5: Readline agent/chat fallback emits the same update advisory only at an IO-safe boundary; up-to-date, stale, timeout, offline, malformed and late-after-destroy outcomes neither corrupt input nor claim that the installation is current.
- AC6: Managed `.metaproject/index.md` output instructs agents to run `keryx version check --json` once per session, notify on `update-available`, and never block work for timeout/offline/unavailable/unknown-command results; init, update and rules-sync generation remain consistent.
- AC7: Automated tests make no real network calls and cover SemVer ordering, response validation, cache TTL/backoff/corruption, CLI output, non-blocking startup, both TUI modes, readline fallback and generated index guidance without adding an ordinary runtime dependency.
- AC8: README/CLI documentation and changelog describe the advisory behavior and bootstrap limitation, and typecheck, focused/changed tests, documentation links, security evaluation, Metaproject Standard, build/pack smoke and Code Health gates pass or have explicitly accepted pre-existing warnings.
