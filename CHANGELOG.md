# Changelog

All notable changes to `keryx` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

Nothing yet.

## [0.2.4] — 2026-08-03

### Documentation

- **`docs/docs/architecture.md` now has five diagrams and no longer predates the
  architecture.** It was corrected rather than rewritten: most of its 310 lines
  were accurate, and replacing verified prose with new prose would have traded
  content for churn.

  The diagrams are Mermaid in Markdown, so they diff in git and need no build
  step. Every arrow is a named module or file and the decision nodes carry their
  `file:line`.

  Three of the five exist to correct something the source contradicted:

  - the system-context diagram had to stop the document saying "no HTTP server",
    which stopped being true when remote entry shipped;
  - the harness diagram is preceded by a **two-tool-systems table**, because a
    single picture of "the tool loop" is false in both directions — the durable
    `ToolExecutorPort` returns an `outputHash` and structurally cannot feed a
    live model, while the `InteractiveTool` layer the shell runs returns content.
    And no shipped path registers a tool at all;
  - the containment diagram makes the **macOS/Linux split structural**, because
    Tier 2 does not degrade on Linux — it refuses.

  The remote-entry diagram draws the nine-step ordered decision path rather than
  listing it, because `serve-turn.ts:3-7` states that *the order rather than the
  set is the control*.

- The module map gained eight missing rows — harness, sandbox, tui, session,
  serve, projects, metrics, contracts — plus a module-versus-command
  discriminator. A module has a manifest entry, a manifest file and a
  `src/<feature>` behind a verb; `review`, `serve`, `orient` and `sync` have none
  of that. Listing `serve` as a module was an error introduced in `0.2.0`.

- Layer 1 is described as the `CLI_ROUTES` table it is, not the "flat if-chain"
  it stopped being.

## [0.2.3] — 2026-08-03

### Fixed

- **`keryx ctx rg "pattern" src/one-file.ts` reported `(unknown)` and `0:0` for
  every hit.** ripgrep omits the filename whenever it is given a single explicit
  file path, which breaks the `file:line:col:text` shape `parseRgMatches`
  requires — so agents were handed matches they could not locate.
  `--with-filename` now joins the base argv unconditionally; it is a no-op for
  the multi-path and directory cases. (PR #211)
- **The code graph was under-resolving edges on this repository.** After the
  gdgraph fixes the same tree yields **1,873 edges against 1,397 before**, from
  649 nodes. (PR #211)
- Entropy and PII detector corrections, with fixture cases. (PR #211)

### Added

- **CI installs ripgrep.** One test spawns the real binary to prove ripgrep
  emits `file:line:col` for a single explicit path — an oracle about an external
  tool. Skipping it when the tool is absent would have left the assumption
  unverified while the job stayed green, so the tool is installed instead. This
  is what the pull request's red check actually was.

### Note on the merge

PR #211 was opened on 2026-07-26 and sat behind 24 commits. `buildRgCommand` had
been rewritten on `main` in the meantime to allowlist ripgrep flags — a caller's
`--pre=…` had reached arbitrary command execution through the one operation
agents are told to prefer over raw grep — and it now returns a result rather
than an argv. Both changes were kept: the security structure from `main`, the
`--with-filename` fix from the branch, asserted together so neither can be
dropped while the other still passes.

## [0.2.2] — 2026-08-03

### Security

- **A credential that merely exists no longer chooses the network posture of an
  unrelated command.** `keryx harness exec` decided "restricted network" from
  the count of mask inject-hosts. Those come from masks resolved against every
  provider key in the environment *and* in the user-global `auth.json` — so a
  saved key for a provider the command never touches silently widened the run to
  restricted networking with TLS termination on macOS, and blocked the command
  outright on Linux, where `restricted` is refused. The same
  `harness exec -- /bin/echo hi` worked or failed depending on whether an
  unrelated key existed on the machine.

  The posture is now decided by `resolveNetworkRestriction`, which takes the
  operator's intent and nothing derived from the environment: credentials are
  not a parameter, so they cannot reach the decision. Inject hosts still join
  the allowlist once a restricted run has been asked for — they no longer cause
  one.

  The five ways an operator can ask are a discriminated union with a total
  `switch`. The exhaustiveness was **verified, not assumed**: planting a sixth
  member fails `tsc` with `TS2366`. Nine unit tests cover each way, the fixed
  precedence, and the empty-list cases — `--allowed-domains ""` is not a request
  to restrict with no domains.

## [0.2.1] — 2026-08-03

### Security

- **The egress allowlist is now enforced inside terminated TLS tunnels.**
  Previously the allowlist was checked against the CONNECT target only. Once TLS
  termination was on, the decrypted request's `Host` header chose the upstream
  and was never re-checked — so a contained process could CONNECT to an
  allowlisted host and then address any other host from inside the tunnel. No
  decision was recorded for that inner hop either, so the egress was invisible
  in the reported rulings.

  The inner `Host` is now matched against the allowlist and passed through
  `decide(...)`, which closes both the bypass and the blind spot. Real
  credentials were never exposed — masks filter on their own inject-hosts — so
  this was a containment and observability failure, not a disclosure one.

  It ships with **a planted counter-example**: a test that sets a foreign `Host`
  inside the tunnel and asserts the refusal. Affects macOS only, because TLS
  termination is macOS only. (PR #210)

### Added

- **A macOS real-host CI job** covering the OS sandbox and the TUI pty launch.
  Until now the platform where the allowlist, credential masking and TLS
  termination actually run was the platform with no live containment test.
  (PR #210)

### Documentation

- A verification step in a flow plan is a task, not a sentence (PR #221).
- `shared-definitions` for the rules library, so places that agree connect by
  import instead of by restatement (PR #222).

## [0.2.0] — 2026-08-03

The first release since `v0.1.0`, covering 570 commits: the OS sandbox, the
agent harness and multi-agent engine, the OpenTUI shell, and the remote entry.

### Changed — packaging (read this before upgrading)

- **The npm package is now `@mrciphersmith/keryx`.** The unscoped name `keryx`
  on npm belongs to an unrelated, actively maintained project
  ([actionhero/keryx](https://github.com/actionhero/keryx)) — installing it gets
  you a different program. Install with:

  ```bash
  npm install -g @mrciphersmith/keryx
  ```

  The executable is still `keryx`; no command changes. The `curl` and `bun`
  installers described in the README are unaffected.
- `prepack` was removed. `prepare` alone builds `dist/`, so packing no longer
  runs the build twice (flagged in the 2026-07-10 readiness report).

### Added — remote entry (`keryx serve`)

- **A loopback-bound HTTP entry over the agent harness**, off by default. Bearer
  authentication compared in constant time, with only a salted hash persisted;
  `serve token issue | rotate | revoke`. Authentication runs *before* routing, so
  an unauthenticated caller cannot distinguish a known path from an unknown one.
  `refused` binds no socket at all — it is never a degraded listen.
  (R4b, flow 128, PR #216)
- **`POST /v1/turns` — remote turn submission with SSE streaming.** Idempotency
  keys are scoped per project, so two projects cannot collide on one key; turn
  records are durable; the remote policy profile is compared against the local
  one and may never be weaker; authentication failures are throttled. An `ask`
  decision terminates in a **recorded denial** — approvals are a later slice.
  (R4c, flow 133, PR #220)
- **`keryx projects` — a user-global project registry**, populated by
  `keryx init`, with `list | register | forget`. Nothing on the machine knew the
  project set before this. (R4a, flow 127, PR #215)

### Added — sandboxing and containment

- **A kernel-enforced OS sandbox under the policy engine:** workspace-write
  filesystem boundaries and secret read-deny via macOS Seatbelt and Linux
  bubblewrap, with network off / on / restricted. No new npm dependencies.
- **A loopback domain-allowlist proxy** reporting allow/deny rulings, plus opt-in
  TLS termination for HTTPS masking. Both are macOS-only and **refuse to run on
  Linux** rather than degrading to full host network.
- **Credential auto-masking**, defaulting to `auto` when the restricted sandbox
  is on, resolved env → project → global → built-in. Secrets come from the
  user-global `auth.json` only.
- **Harness hardening:** mask-without-TLS fails closed, spawn failures carry
  structured diagnostics (the exit-71 class), and a portable deep-probe script
  ships with a report schema.

### Added — the agent harness and multi-agent orchestration

- **A full execution loop** (`src/harness/`): append-only session store, an
  allow/ask/deny policy engine, a tool registry, a provider port with fake,
  Anthropic and Ollama adapters, resume and recovery, branching and compaction,
  guarded mutation with approval, replay, budget and monitoring.
  CLI: `keryx harness run | exec | extension | wave`.
- **Subagent orchestration**, reachable today through the interactive shell's
  spawn tool: a fail-closed child-model resolver, a policy-gated provider
  allowlist, depth and count caps against one shared run-scoped budget ledger
  including the cost dimension, and child-output injection quarantine (which
  flags, and never rewrites, child text).
  - Child containment rests on three things together: `shell_exec` is absent
    from a child's tool list, the child policy denies it, and the approver is
    hard-false.
- **Implemented and tested, but not yet wired to any caller:** cost-aware model
  escalation, git-worktree isolation, bounded peer messaging, and the
  orchestrator-state fold. Each of these modules is imported by exactly one file
  — its own test. They are extension points, not behaviour you get today.
  Scoped per-child credentials are in the same position: the provider option
  exists and is tested, but no production path passes it, so a live child reads
  the ambient environment.
- **A typed `MetaprojectPort`** with published schemas, so the harness, the
  interactive agent and the MCP server reach graph/wiki/memory/context in-process
  from one source instead of through subprocess wrappers.

### Added — interactive shell

- **A full-screen OpenTUI shell is now the default when `stdout` is a TTY**,
  replacing the line-based renderer; `--no-tui` and a graceful readline fallback
  remain. Adds a live `/` command composer, a persistent composer region,
  per-block collapse, and framed markdown with code and diff rendering.

### Added — observability

- **Provenance-aware execution metrics:** active-time accounting, per-run
  evidence, baseline-aware CI and a retry taxonomy. *No performance claim has
  been made* — the paired Keryx/no-Keryx protocol exists to make one honestly.

### Added

- Language-aware gdgraph import resolution: Java (Maven/Gradle source roots,
  fully-qualified-name → file mapping) and Python (dotted modules, `__init__.py`
  packages, and relative `from . import x`) source now produce real dependency
  edges instead of nodes-only graphs. TypeScript/JavaScript resolution is
  unchanged (byte-identical graph output). Seeds the Java/Python tree-sitter
  grammars on `init`/`update`.
- Symbol-aware graph navigation with `gdgraph find`, `symbol`, `path`,
  symbol-aware `affected`, and transitive caller impact via `symbol --impact`.
- Deterministically pinned tree-sitter grammar assets and explicit symbol-layer
  enable/disable/status commands.
- Hierarchical wiki collection with full module coverage, code-to-wiki backlinks,
  symbol-kind annotations, and an explicit draft-enrichment work front.
- Turn-start graph + wiki orientation hooks for Claude, Codex, and Cursor.
- Multi-runtime gdctx routing guards for Claude, Codex, Cursor, Windsurf,
  OpenCode, and other supported harnesses.
- Managed review packages for standalone reviews, flow-attached reviews, report
  ingestion, coverage tracking, decisions, and learning handoff.

### Changed

- Graph symbol resolution now disambiguates loose names and resolves cross-file
  calls before computing callers and impact.
- Agent bootstrap rules enforce the Metaproject hard gate before project work.
- Model-backed features remain opt-in, while deterministic fallbacks and asset
  availability are surfaced more clearly.
- The shipped `@xenova/transformers` runtime was removed, reducing the optional
  dependency footprint by roughly 230 MB; compatible transformer-style adapters
  can still be configured explicitly.

### Fixed

- Natural-language graph queries now redirect to the correct `find`, `ctx rg`,
  and `affected` workflow instead of silently producing low-value output.
- Wiki/code relationships and symbol caller graphs no longer under-report common
  cross-file references.
- gdgraph import-resolution metric no longer reports a false `100%` when zero
  imports were extracted (a `0/0` denominator); it reports `n/a` instead, and
  non-relative imports that fail to resolve are recorded as `unresolved` edges
  rather than silently dropped.

### Security

- The agent shell allowlist is a **boundary, not a string match**; the
  destructive risk class is wired into the shell approval gate; an approval is
  bound to the action it approves; and the agent can no longer grant itself
  shell permissions.
- Subagent isolation is pinned and a child's summary is bounded.
- Search argv is separated and caller-supplied paths are contained.
- Six adversarial review rounds on the remote-entry branch produced twelve
  blockers, all closed. Their single common cause is recorded as a durable
  lesson: [branching on a value whose domain you never wrote down](.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md).

### Documentation

- Refreshed public, developer, CLI, architecture, module, onboarding, workspace,
  and release-readiness documentation for the post-`v0.1.0` feature set.

### Known gaps

Recorded here rather than in a release announcement, because they are the things
a reader would otherwise discover by hitting them.

- **Approvals over the remote entry are not implemented.** Until they are, a
  remote turn that needs one is denied and the denial is recorded.
- **`GET /health` and cross-process liveness are absent.** No PID file exists, so
  `keryx serve status` reports configuration state only; `listening` and
  `draining` are knowable only over the authenticated `GET /v1/status`.
- **The domain allowlist, credential masking and TLS termination are macOS-only**
  and refuse to run on Linux rather than silently weakening.
- **`pii: { action: "allow" }` still redacts** — an open question about the
  policy resolver, not the detector.
- **The source-pattern guards in `src/lib/config-dir.ast.ts` are heuristics, not
  closures**, and carry a written list of known gaps as executable tests.

## [0.1.0] — 2026-07-10

First tagged release. `keryx` installs a deterministic, local, offline,
git-diffable `.metaproject/` workspace of agent-facing tooling, with an opt-in
capability seam for model/embedding features (disabled = byte-identical, zero
runtime dependencies, no sockets).

### Core modules

- **gdgraph** — code graph, symbols, and affected context. Parser-backed import
  resolution (`Bun.Transpiler.scanImports`, regex fallback), N-hop transitive
  `affected`, token-budgeted `repomap.md`, and an opt-in tree-sitter symbol layer.
- **gdctx** — token-aware wrappers for search, reads, diffs, and command output.
- **gdwiki** — project knowledge base. Deterministic `collect` derives real
  per-module signals (dependencies, key files by connectivity, entry points,
  exported symbols) as prose-first drafts; an agent enrich workflow fills the
  understanding on a cheap model; `collect --changed` for incremental runs.
- **gdskills** — bundled working skills plus project-skill create/route/verify/
  learn lifecycle, schema-governed orchestration (`subagent-dispatch` →
  `subagent-result`, STATUS protocol), and a `docpack-orchestrator` for
  requirements packages.
- **health** — aggregated code health, scoring, quality gate, and a
  churn × complexity hotspot signal.
- **testing** — test context, related-test selection, normalized reports, and an
  opt-in coverage-map TIA with an always-on smoke tier.
- **memory** — long-lived project memory with bitemporal facts, memory typing,
  optional local embedding rerank, and `--as-of`/`--class` search.
- **tasks (flow)** — agent-first flow lifecycle: frozen acceptance criteria,
  a strict status state machine, PR-gated completion (AC + PR checks + health +
  security), tracker adapters (`gh`), and natural-language discovery.

### Platform

- **Metaproject Standard** — `standard validate|doctor|capabilities|emit`, a
  self-describing manifest, and profiles.
- **MCP interop** — `keryx mcp serve [--http]`: a stdio-first server mapping
  Tools to `createXService()` methods and Resources to read-only artifacts;
  `llms.txt` and gdskills plugin export.
- **Metaproject Security** — agent input/output/artifact security: secrets, PII,
  prompt-injection and exfiltration/egress detection with HMAC-keyed hashing,
  safe redaction, a config-integrity self-protect, write-seam gates, multi-runtime
  hooks, and a red-team eval harness (advisory by default).
- **Capability seam** — `resolveCapability(id) → Adapter | null`, `optionalDependencies`
  + lazy import, deterministic fallback as a tested path, and an asset resolver
  (`assets.lock.json`, `assets list|verify|pull`).

### Tooling & UX

- `keryx init` / `update` / `modules` / `dashboard` — TTY-aware styled output
  (banners, module status, next steps) that degrades to clean plain text off-TTY.
- **Human dashboard** — a dark-first, navigable HTML admin view with a health-score
  ring, module cards, an "Attention" section, a Tasks/flows summary, and an in-page
  markdown modal for every linked `.md`.

### Reliability

- Atomic `.metaproject` writes (temp + rename) so a crash never corrupts a
  single-source-of-truth file.
- File locks (dependency-free, atomic `mkdir`) around flow mutations and gdskills
  manifest/learn read-mutate-write, so concurrent AI-agent sessions never lose
  updates.
- Serialized `process.chdir` in tests — no cross-file cwd races.

[0.1.0]: https://github.com/MrCipherSmith/keryx/releases/tag/v0.1.0
[0.2.0]: https://github.com/MrCipherSmith/keryx/compare/v0.1.0...v0.2.0
[0.2.1]: https://github.com/MrCipherSmith/keryx/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/MrCipherSmith/keryx/compare/v0.2.1...v0.2.2
[0.2.3]: https://github.com/MrCipherSmith/keryx/compare/v0.2.2...v0.2.3
[0.2.4]: https://github.com/MrCipherSmith/keryx/compare/v0.2.3...v0.2.4
[Unreleased]: https://github.com/MrCipherSmith/keryx/compare/v0.2.4...HEAD
