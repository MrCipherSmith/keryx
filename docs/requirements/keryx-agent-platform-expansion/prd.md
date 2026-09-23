# Keryx Agent Platform Expansion — PRD
Version: 0.1.3

## Problem

Keryx's skill/rule catalog, agent surface, learning loop, portability, and
harness support have each grown to cover a narrow slice of what the platform
needs, and the gaps compound each other:

- **Stack coverage is effectively two frameworks.** `src/gdskills/bundled/skills/`
  ships 72 `SKILL.md` files (planning 19, quality 17, …) and
  `src/gdskills/bundled/rules/core/` ships 34 `.mdc` rule files (30
  stack-agnostic, 4 stack-specific), but stack-specific coverage is limited to
  NestJS/Prisma
  (`review-backend`, `nestjs-dto.mdc`) and React/MobX (`review-frontend`,
  `code-mobx-store-review`, `mobx-store-template.mdc`). There is no rule or
  implementation skill for Python, Go, Rust, Java/Kotlin, C#/.NET, Swift,
  Flutter/Dart, PHP, Ruby, C/C++, per-engine SQL, Vue, Angular, Next/Nuxt, or
  Docker/K8s/Terraform/CI. No `detectStack`/`stackDetect` implementation exists
  anywhere in `src/` — stack awareness today is a manually authored
  `metadata.stack_requires` tag on four review skills, used only to gate an
  already-installed reviewer's dispatch, never to discover missing coverage.
- **There is no agent-definitions catalog.** `docs/requirements/keryx-multi-agent-engine/README.md`
  documents, as an explicit non-goal, "a separate `.claude/agents/*.md`-style
  loader — the dispatch contract is the definition surface." In practice every
  "agent" is an ad hoc `subagent_type` string and inline prompt text authored
  by whichever orchestrator `SKILL.md` calls `spawn_subagent`
  (e.g. `job-orchestrator/SKILL.md` passing `subagent_type: "general-purpose"`).
  `agent-catalogue-xref.test.ts` only lints that referenced names exist; it is
  not a registry of reusable personas.
- **Learning is manual, single-project, and enum-confidence only.** `keryx
  review learn` / `keryx skills learn apply`
  (`src/gdskills/learn.ts`) implement a real proposal-then-apply pipeline with
  file locks, versioning, and a changelog, but every stage is human-invoked,
  scoped to one project skill (`isPathInside(projectSkillsRoot, ...)` hard-
  refuses writing outside it), and confidence is a 3-value enum
  (`low|medium|high`), not a continuous score with a reinforcement/contradiction
  update rule. `skill-lifecycle.mdc` explicitly states verify/learn belongs "in
  the agent loop," never a hook, and no hook currently forwards session/turn
  content to any extractor.
- **Portability covers two harnesses.** Skill export/sync
  (`skill-runtime-exporter`, `skill-sync`) is scoped to Codex and Claude
  artifacts only, plus a single-skill plugin export (`keryx skills export
  --runtime plugin`). AGENTS.md/CLAUDE.md generation (`rules sync`/`distill`)
  targets exactly those two filenames — no Cursor `.cursorrules`, Windsurf
  rules, Gemini `GEMINI.md`, or Kiro steering generation path exists. There is
  no user-level (`~/.keryx/`) store for cross-project skills, agents, or
  learned patterns, and no bundle format to move any of it between machines or
  harnesses.
- **Three divergent hook registries, with a documented clobbering bug class.**
  `src/ctx/runtimes.ts` (guard, 6 runtimes: claude/codex/cursor/windsurf
  verified, antigravity/opencode experimental), `src/ctx/orient-runtimes.ts`
  (context injection, 3 runtimes: claude/codex/cursor), and
  `src/security/agent-hooks/runtimes.ts` (check-input/check-output, 4 runtimes:
  claude/cursor/windsurf/generic-mcp) have different, non-overlapping runtime
  coverage and, for Claude, write into the same `.claude/settings.json` event
  keys as separate array entries. For Cursor/Windsurf the two installers
  previously wrote incompatible JSON shapes under the same `hooks` key and
  silently destroyed each other; the fix invented an unverified
  `securityHooks` key that the source itself documents as matching "no
  documented contract for cursor or windsurf" (tracked in-code as OQ-3). No
  entry for Gemini CLI or Kiro exists in any of the three registries; Zed has
  no scriptable pre-exec hook at all upstream.
- **`keryx shell` has no user-facing hook system.** `src/harness/policy/engine.ts`
  is a genuine, tested allow/ask/deny policy engine with hard-deny and
  fail-closed semantics, and `src/harness/startup.ts` records a `StartupEvent`,
  but a targeted search of `src/harness` for
  `SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|"Stop"` returns zero
  matches. There is no project- or user-authored hook config a person can
  register a command against, even though Keryx is aware enough of other
  harnesses' hook systems to deliberately suppress them (`--safe-mode` when
  spawning `claude -p`, `src/harness/external/codec/claude-cli.ts`).
- **`gdctx`/`gdgraph` have live, reproduced defects that every other
  workstream routes through.** `keryx ctx run -- git log --oneline -5`
  misclassifies a normal stdout line containing "refuse" as an error
  (`src/ctx/lines.ts:46`, keyword-stem matching applied unconditionally).
  `keryx ctx read README.md` redacts public CI/npm badge URLs as
  `[REDACTED:url]` even though the source is tagged `trusted-project`
  (`src/commands/ctx.ts:317`). `keryx ctx rg` rejects bundled POSIX short
  flags (`-il`) that work when split (`-i -l`)
  (`src/commands/ctx.ts:1005-1006`). The `.metaproject/index.md` hard-gate
  read costs ~3,226 tokens and is re-billed every turn because the transcript
  is re-sent (measured in `docs/requirements/keryx-context-measurement/context-loading.md`);
  the mitigation (`keryx orient`) is not installed in this repo and, as
  shipped, adds its own ~2,360-token injection on top of the gate rather than
  replacing it.
- **No harness-config security audit exists.** Nothing in `src/security`
  currently sweeps `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`,
  `.claude/settings*.json`, `.codex`, `.cursor`, MCP configs, hook files, agent
  definitions, or imported bundles for secrets, prompt-injection-shaped
  auto-run instructions, over-permissive allow lists, unpinned `npx`/`uvx` MCP
  servers, or hook command injection via interpolation.

Left unaddressed, these gaps compound: a wider stack catalog (W1) without a
correctness fix to the layer everything routes through (W7) inherits its
defects at larger scale; a learning loop (W3) without a security-audited
persistence path (W8) risks promoting unsafe content; a broader harness matrix
(W5) without a portability format (W4) still locks content to two harnesses.

## Goal

Give Keryx a stack-aware, agent-defining, self-improving, portable, and
multi-harness-consistent platform layer — built deterministically, fail-closed,
and honest about what is implemented versus planned — without duplicating or
weakening the invariants Keryx has already committed to elsewhere (no
automatic promotion, hooks only tighten, proposals never write, human consent
before persistence of learned content).

## Users

- **Operator** — runs `keryx` day to day, installs stack packs, reviews
  learned-pattern proposals, decides which harnesses to enable.
- **Agent** — the coding agent executing inside a harness; consumes agent
  definitions, stack packs, hook context, and the harness capability matrix to
  decide what it can do and how.
- **Team lead** — decides install profiles, harness rollout, and whether a
  learned pattern promotes from project to user scope.
- **Maintainer** — keeps the catalog, agent definitions, and harness adapters
  honest over time via the governance gates (dedupe, evals, stocktake) and the
  audit tooling.

## Requirements

Grouped by owning workstream; each `R*` id is stable and referenced from the
owning workstream's acceptance criteria.

### W1 — Stack-aware skills & rules catalog

- **R1.1** Deterministic, offline stack detection (`keryx stack detect`) that
  writes `.metaproject/data/stack/stack.json` from marker files, extensions,
  and package manifests, with no network access.
- **R1.2** A stack pack shape (rules with `paths:` glob scoping extending a
  `common` base, skills for implement/test/review/build-fix/migrate, agent
  refs into W2) covering the stacks named in the W1 target-stack table
  (`workstreams/W1-stack-catalog.md`).
- **R1.3** Install profiles/modules/components with dry-run/JSON plan,
  install-state, `doctor`, and uninstall that removes only Keryx-managed
  files.
- **R1.4** Catalog governance: authoring standard aligned to the Agent Skills
  open standard, a pre-creation dedupe gate, trigger and behavior evals with
  pass@k, and a periodic stocktake with an explicit keep/improve/update/retire/
  merge verdict and reason.

### W2 — Agent definitions catalog

- **R2.1** A canonical `.metaproject/agents/<name>.md` format (frontmatter:
  name, description, role, tools allowlist, model tier, policy profile,
  skills, stacks, output contract, isolation) that compiles into the existing
  `spawn_subagent` dispatch contract rather than replacing it.
- **R2.2** Exporters to Claude Code `.claude/agents/*.md`, Codex agents TOML,
  Kiro, OpenCode, and keryx shell child agents, each with honest per-harness
  support recorded through W5's matrix.
- **R2.3** An initial generic catalog plus per-stack reviewer/build-error-
  resolver pairs generated from W1 stack packs, with a single shared
  prompt-defense baseline injected by the compiler, not duplicated per file.
- **R2.4** `keryx agents list|show|export|verify` plus a guard test that every
  agent's referenced skills/tools exist.

### W3 — Self-learning loop

- **R3.1** An Observe stage that records hook events (from W6 and, via W5,
  from host harnesses) as bounded, redacted, TTL'd JSONL under
  `.metaproject/data/learning/observations/`.
- **R3.2** An Extract stage using deterministic signals first (repeated
  corrections, reverted edits, failing→passing test pairs, configured-reviewer
  comments, health regressions), with model-backed extraction only behind an
  optional capability flag.
- **R3.3** A `learned-pattern` record (id, trigger, action, evidence with
  source references, numeric confidence 0–1 with a deterministic
  reinforcement/contradiction update rule, domain, scope, status, provenance).
- **R3.4** A review/consent step (`keryx learn review|accept|reject|promote|
  graduate`, plus `keryx learn apply <id>` and `keryx review learn --reviewer
  <id>`) where nothing persists to skills/rules/memory without human
  acceptance, and a content-safety scan refuses injection-shaped learned text.
- **R3.5** Apply reuses `applyLearningProposal` as the only writer for
  skills/rules/agents. `keryx learn promote` is the only path that creates a
  user-scope pattern from project-scope evidence. `keryx bundle import` may
  transport an already-`scope: user` record into
  `~/.keryx/learning/patterns/`; it never changes a record's scope and always
  writes it at `status: candidate`. `keryx learn accept` is the only command
  that makes any record `accepted`: it writes the status transition in the
  record's own store (`.metaproject/data/learning/` for `scope: project`,
  `~/.keryx/learning/patterns/` for `scope: user`) and, for a `scope: project`
  record only, appends one entry to `~/.keryx/learning/index.json`; it refuses
  any target outside `.metaproject/data/learning/` or `~/.keryx/learning/`.
  Promote requires the pattern to have an accepted record at confidence ≥ 0.8
  in each of 2+ distinct project identities, counted from
  `~/.keryx/learning/index.json` (a cross-project evidence index appended only
  by `keryx learn accept`, a human action); promote with evidence from only
  one identity is refused. Promote still only produces a candidate pending
  human confirmation, consistent with
  `shared-agent-context-generational-memory`'s "no automatic promotion"
  non-goal; Graduate turns clusters into skill/agent/rule proposals via W1/W2
  creators.
- **R3.6** Per-reviewer profile rules under `.metaproject/rules/reviewers/<id>.mdc`,
  generalized wording only, never attributing a finding to a person, gated by
  the same consent step.

### W4 — Portability

- **R4.1** `keryx bundle export|import|inspect|verify` producing a versioned
  manifest (schema-defined) covering skills, rules, agents, learned patterns,
  memory entries, and hook configs, with per-file checksums and provenance,
  plus `keryx memory handoff` for cross-harness memory entry transfer.
- **R4.2** Import runs plan → W8 security audit → apply, never overwrites a
  user-modified file, and fails closed on checksum mismatch.
- **R4.3** A `~/.keryx/` user-level store for user-scope learned patterns,
  skills, and agents, alongside project and version-controlled team scopes.
- **R4.4** Cross-harness memory handoff: memory entries carry
  `source_harness`/`target_harnesses`; MCP memory tools bind harness identity
  at server launch, not per call; direct reads fail closed on incomplete
  scans; project-scope private directories fail closed on a `.gitignore`
  conflict.
- **R4.5** Read-only vetting of external Agent-Skills-standard catalogs
  (W8 audit + W1 dedupe scout) without copying them into the bundled tree.
- **R4.6** Harness-specific instruction-file export (AGENTS.md, CLAUDE.md,
  GEMINI.md, `.cursor/rules/*.mdc`, Kiro steering, Windsurf rules) generated
  from one canonical `.metaproject/rules` source via W5 adapters.

### W5 — Multi-harness support & capability matrix

- **R5.1** One harness adapter registry unifying the three existing hook
  registries, with the full W5 `SurfaceFlag` set (block, prompt-gate,
  inject-context, pre-tool-context, observe, post-tool, session-start, stop,
  skills, agents, instructions, mcp) and a single merge/strip/validate
  path per settings file, closing the `securityHooks` (OQ-3) clobbering class.
- **R5.2** New adapters for Gemini CLI, Kiro, GitHub Copilot (agent), and Zed
  via ACP (policy traveling with the Keryx agent through `src/acp/permission.ts`);
  Antigravity/OpenCode remain `experimental` until independently verified.
- **R5.3** A generated, CI-validated harness capability matrix
  (native/adapter/instruction-only/unsupported) with required fields (id,
  state, surfaces supported/unsupported, install command, verification
  command, risk notes, last verified, source docs) and a `keryx integrations
  matrix [--check]` command.
- **R5.4** `keryx integrations install|doctor|uninstall --runtime <id>` across
  all Keryx-managed host-harness surfaces with install-state and idempotent
  sentinels. This is a distinct namespace from Keryx's own agent-runtime
  `keryx harness run|exec|extension|wave`, whose behavior and help stay
  unchanged.

### W6 — keryx shell lifecycle hooks

- **R6.1** A hook runtime inside `src/harness` with events SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PreCompact,
  Stop, SubagentStart, SubagentStop, SessionEnd, configured via
  `.metaproject/hooks.json` and `~/.keryx/hooks.json`, JSON-I/O compatible
  with the Claude Code hook contract (stdin JSON, exit 2 = block, stdout JSON
  decision/additionalContext).
- **R6.2** Hooks compose with `src/harness/policy/engine.ts` by tightening
  only (deny/ask/add context; never overriding a hard deny or turning deny
  into allow), with deterministic ordering, timeouts, sandboxed execution via
  the existing OS sandbox, and no network by default.
- **R6.3** Fail-closed behavior for `gate`-class hooks on failure/timeout in
  every profile; `gate-advisory`-class hooks (e.g. `keryx.impact-evidence`)
  fail open with a recorded warning in `read-only-review` and
  `monitored-trusted-local`, and fail closed in `unattended-untrusted`;
  `observe`/`context`-class hooks always fail open with a recorded warning.
- **R6.4** Keryx's own ctx guard, security check-input/output, W3 learning
  observer, and W8 impact-evidence injector register as built-in hooks through
  this runtime.
- **R6.5** ACP/serve/trigger unattended runs support the hook runtime; child
  agents inherit the parent's explicit hook set only, never an implicit host
  hook set (mirroring the existing `--safe-mode` rationale).

### W7 — gdgraph & gdctx correctness

- **R7.1** A defect register (GDCTX-1 stdout error misclassification,
  GDCTX-2 trusted-project image-URL redaction, GDCTX-3 bundled short-flag
  rejection) with reproductions and regression tests.
- **R7.2** A correctness benchmark using golden fixtures for graph edges and
  ctx fact preservation, building on
  `fixtures/benchmark/keryx/gdctx-fact-preservation.json`.
- **R7.3** A new `GIT_READONLY_ALLOW` set in `src/ctx/hook-classify.ts` (`git
  status`, `git blame`, `git branch`, `git tag`, bounded `git log --oneline
  -N`, `git diff --stat`) that the ctx hook allows without routing — never
  blocked, never requiring the raw-command escape marker — distinct from
  `GIT_ROUTABLE`, whose routed commands still go through compact output.
- **R7.4** POSIX short-flag bundling support in `keryx ctx rg`'s flag
  validator.
- **R7.5** Trust-aware redaction that honors the `source: "trusted-project"`
  tag already passed to `redactRaw`.
- **R7.6** Stdout/stderr-aware error classification in `keryx ctx run`,
  replacing unconditional keyword-stem matching.
- **R7.7** Audit every gdgraph query path (`affected`, `query`, …) to call the
  existing `printStaleNote`/`checkGraphStaleness` freshness self-check
  (`src/gdgraph/staleness.ts`, `src/commands/gdgraph.ts:583-593`) and add
  fixture coverage for it — the self-check itself is not new — plus memory
  entries recorded for each closed defect, addressing the current zero-hit gap
  in `keryx memory search "gdgraph"` / `"gdctx"`.
- **R7.8** Reduce the `.metaproject/index.md` hard-gate read to a ≤400-token
  pointer table read in place of the current file (GDCTX-5).

### W8 — Harness-config security audit & impact-evidence gate

- **R8.1** `keryx security audit-harness [--fix-proposals] [--json] [--ci]`
  covering AGENTS.md/CLAUDE.md/GEMINI.md, `.claude/settings*.json`, `.codex`,
  `.cursor`, MCP configs, all Keryx-known hook files, W2 agent definitions,
  skill script directories, and imported W4 bundles.
- **R8.2** Checks for secrets, prompt-injection/auto-run instructions,
  over-permissive allow lists or missing deny entries, bypass flags, unpinned
  `npx`/`uvx` MCP servers, hook command injection via interpolation,
  exfiltration, silent error suppression, and agents with unrestricted tools
  or no model tier — reusing existing `src/security` detectors and MCP-manifest
  scanning.
- **R8.3** Findings carry severity and a score; fixes are proposals only,
  applied through a separate, explicit step.
- **R8.4** An impact-evidence gate on the first edit of a file per session
  that injects deterministic evidence (`keryx gdgraph affected`, `keryx test
  related`, memory caveats) as additional context, with an optional strict
  mode, destructive-command rollback requirement, denial dampening, batch
  honesty, exemption globs, and graduated kill switches, running via W6 in
  keryx shell and via W5 in host harnesses.

## Success criteria

Measurable; each references the corresponding metric in
[metrics-and-validation.md](metrics-and-validation.md).

- W1: stack coverage count increases from 2 stacks to the full W1 target-stack
  table (`workstreams/W1-stack-catalog.md`) only as governance evals
  (trigger-eval accuracy, pass@k) pass per stack batch — see Wave 4 gating.
- W2: agent export succeeds for every harness the capability matrix marks
  `native` or `adapter`, and fails closed with a named reason for every
  harness marked `unsupported`.
- W3: learned-pattern acceptance rate and rejection reasons are tracked from
  the first reviewed batch; zero patterns persist without a recorded human
  accept.
- W4: bundle round-trip fidelity (export → import → inspect) is 100% for
  checksummed content; zero user-modified files are overwritten in any
  recorded import.
- W5: the generated harness capability matrix passes its CI validator with
  every required field populated for every listed harness.
- W6: hook latency p95 is measured and published before any hook is enabled
  by default in an unattended profile.
- W7: the ctx guard false-block rate on read-only git commands drops to zero
  for the `GIT_READONLY_ALLOW` set (R7.3), and the gdctx fact-preservation
  score on the existing benchmark fixture does not regress.
- W8: audit findings precision is measured against a labeled fixture set
  before `--ci` mode is recommended as a merge gate.

## Risks

- **Compounding defects.** Building W1/W2/W3 content on top of unfixed W7
  defects (stdout misclassification, redaction false positives) means every
  new skill/agent/pattern inherits the same routing noise. Mitigated by
  sequencing W7 first (decision D-8).
- **Promotion pressure.** A numeric confidence score and a project→user
  promotion path (W3) is exactly the shape `shared-agent-context-generational-
  memory` warns against if promotion becomes automatic. Mitigated by keeping
  promotion a human-confirmed candidate, never an automatic write (decision
  D-4).
- **Hook proliferation.** Adding a fourth hook-writing surface (W6, alongside
  the three that already exist for host harnesses) without unifying them
  first (W5) risks reproducing the exact clobbering-bug class already fixed
  once for Cursor/Windsurf. Mitigated by requiring W5's unified registry
  before W6 lands new adapters (implementation-plan Wave 0/1 ordering).
- **Content-scale-out without governance.** Generating stack packs and
  per-stack agents in bulk before the dedupe/eval/stocktake gates exist would
  reproduce today's untested-catalog risk at 10x the size. Mitigated by
  decision D-7 (batches of ~4 stacks, gated by W1 governance evals).
- **Honesty drift.** A generated harness capability matrix (W5) or audit
  report (W8) that is not CI-validated can silently go stale, exactly as
  `keryx-context-measurement` documents happened to the `keryx orient` fix.
  Mitigated by requiring CI validation as an acceptance criterion, not a
  recommendation.

## Recommendation

Approve this package for Wave 0 (W7 correctness, W5-a unified adapter
registry) after review. Do not authorize Wave 4 (stack pack / per-stack agent
scale-out) until W1's governance gates (dedupe, trigger/behavior evals,
stocktake) exist and have run at least one batch successfully. Treat W3's
promotion step and W6's default-on hook posture as decision gates requiring
explicit sign-off, not default behavior.
