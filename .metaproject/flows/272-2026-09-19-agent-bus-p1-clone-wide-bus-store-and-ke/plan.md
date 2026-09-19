# Implementation Plan

Status: approved for freeze

## Approach

P1 adds a new module, `src/bus/`, built on the P0 primitives in `src/lib/fs.ts`
(`withFileLock`, `writeFileAtomic`, `processIsAlive`, D-09 liveness) and on the
existing dependency-free validator in `src/contracts/validator.ts`. The CLI in
`src/commands/bus.ts` stays thin over the library.

## Steps

1. **Clone scope and marker.**
   - Move `gitCommonDir` and `gitToplevel` out of `src/flow/allocation.ts` into
     `src/lib/clone-scope.ts`, exported and otherwise unchanged. Allocation
     re-imports them; its `projectKey`, fallback and lock paths stay where they
     are. The allocation tests must pass without edits.
   - In `resolveShellEnv` (`src/harness/process/shell-spawn.ts`), set
     `KERYX_TOOL_CALL=1` so that it reaches both `shell_exec` paths. External
     and MCP children already sweep `KERYX_*`.
2. **Bus root and ids (`src/bus/paths.ts`, pure, no fs I/O).** Keep this module
   free of fs I/O, because the config-dir guards flag any file that names
   `keryxDataDir(` and also does fs I/O.
   - `resolveBusRoot(cwd)`: the key is the path of `resolveProjectRoot(cwd)`
     relative to the git toplevel, slugified, or `root`. Do not import flow's
     `slugify`; use a local copy or a lib-level one, depending on import policy.
   - Outside git, fall back to the data-dir path.
   - A strict UUID check for `instanceId` and `leaseId`. It must run before any
     path is built.
3. **Schemas (`src/bus/schema.ts`).** Define the event, presence and
   pause-lease schemas inline in TypeScript and validate them with
   `validateAgainstSchemaObject`, plus an explicit UUID check, because the
   validator does not enforce `format: uuid`. Add a consistency test against
   `docs/requirements/keryx-agent-bus/schemas/*.json`. The name pattern must
   reserve `all`, `cli` and `system`.
4. **Presence (`src/bus/presence.ts`).**
   - Write each record with `writeFileAtomic`.
   - List records and classify each as live, stale or gone per D-09. The clock,
     pid probe and host are injectable.
   - Name allocation per D-06: `agent-<n>` by default, `<name>-2` on collision.
5. **Event log (`src/bus/log.ts`).**
   - Append: under `append.lock`, set
     `seq = max(head.seq, seq of the last complete line) + 1`, write one line,
     then rewrite `head.json` atomically. Rotation happens in the same lock hold:
     at 1 MiB, keep at most two rotated segments and delete segments older than
     7 days. `head` records `{ seq, segment, segmentInode }`.
   - Bodies are redacted with `redactSensitiveText` before the 2048-byte check.
   - Reader: a cursor `{ segment, inode, offset }`. It checks for rotation
     before comparing sizes, returns complete lines only, and skips torn or
     unknown lines.
6. **Leases (read-only, `src/bus/leases.ts`).** List `leases/*.json` and apply
   the §4.3 active rule: the lease is not expired and its holder is not gone,
   or the holder is the CLI. Writing leases is P4.
7. **Send (`src/bus/send.ts`).**
   - Resolve `@name` to live instance ids. Refuse with `unknown-recipient` or
     `recipient-not-live`. `@all` becomes `["*"]`.
   - Accepted kinds: `notice`, `question`, `handoff` and `reply`. A `reply`
     requires a reply-to id.
   - Rate limit: 30 messages per minute per clone for the CLI origin, counted
     from the log under the lock. It has a test-only bypass, gated like the
     lease timing knobs.
8. **Enablement (`src/bus/enabled.ts`).** Returns `{ enabled, reason }`. The
   bus is disabled by `KERYX_BUS=off`, by shell config `bus.enabled: false`, or
   by CI (reuse `detectCi`). `KERYX_BUS_POLL_MS` is clamped to 250–10000.
9. **Prune (`src/bus/prune.ts`).** Removes presence records gone for more than
   24 h, inactive leases, and rotated segments beyond the bound.
10. **CLI (`src/commands/bus.ts`).**
    - Subcommands: `list [--json]`, `log [--since] [--limit] [--json]`, `send`
      and `prune`.
    - D-13: `send` refuses with `use-agent-tool` when `KERYX_TOOL_CALL=1`.
      `list`, `log` and `prune` are allowed. `bus-disabled` refuses `send` and
      `prune`.
    - Register it in `CLI_ROUTES` and the help text, add one registry
      descriptor per subcommand (module `bus`), and add a `## bus` section to
      `docs/docs/cli-reference.md` plus a row in the top-level table.
11. **Docs status.** Mark P1 implemented in the package README, the
    implementation plan and the roadmap.

## Rejected

- **Reading the schema JSON files at runtime.** `docs/` is not shipped in the
  npm `files`.
- **Keying the bus on the raw `cwd`, as allocation does.** Spec §2.1 requires
  the resolved project root.
- **Spawning 800 CLI processes for the concurrency test.** Use 8 processes that
  each append 100 times through a small test driver.

## Risks

- **The config-dir guards flag `keryxDataDir` combined with fs I/O in one
  file.** The pure path module avoids this.
- **Import-policy zones may forbid `src/bus` from importing `src/flow`.** Check
  and do not import flow.
- **The multi-process test's runtime.** Give it generous timeouts.
- **Local runs.** Per the operator, local runs are limited to targeted tests.
  The full suite is judged by CI on the PR.
