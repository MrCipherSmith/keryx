# Context

Collected deterministically by `keryx flow init` at 2026-09-30T14:26:45.677Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.802] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
2. [1.802] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
3. [1.756] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
4. [1.699] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.692] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Collected 2026-09-30 by context-collector. Paths are relative to the worktree root.
`[V]` = verified by reading the code/doc; `[I]` = inferred from search hits, not opened.

### A. `keryx:index` block

Render
- `src/lib/agent-entrypoint-blocks.ts:37-83` `renderProjectMetaprojectReferenceBlock({enableTasks, modelChoice})` — the only renderer of the project block [V]. Line 57 hard-codes "this AGENTS.md/CLAUDE.md file". Line 3 `AgentEntrypointFileName = "AGENTS.md" | "CLAUDE.md"`.
- `src/lib/agent-entrypoint-blocks.ts:5-35` `renderGlobalMetaprojectBootstrapBlock` — GLOBAL (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, …) via `src/agents/bootstrap.ts:23-89`; home-dir files, out of scope [V].
- `src/lib/templates.ts:1718-1723` `renderAgentEntrypoint({source})` — default file body = H1 + block [V].
- `src/lib/model-choice.ts` `buildModelChoiceBlockInput(root)` / `renderModelChoicePolicy` — flow 336/348 model guidance; it is a line INSIDE the index block, not a separate writer. Header lines 27-34 state the output "gets committed to the repository" and that Codex gets it through AGENTS.md — both assumptions change [V].

Insert / replace / detect / strip
- `src/rules/agent-entrypoints.ts:163-202` `ensureMetaprojectReference(filePath, {enableTasks, root})` — replace-or-insert; `:279-311` `replaceManagedBlock`; `:313-341` `insertMetaprojectBlockNearTop`; `:131-161` pre-scaffold safety (`assertMetaprojectReferenceSafe`, `UnterminatedMetaprojectReferenceError`); markers at `:121-122` [V].
- `src/rules/marker-matching.ts` — shared whole-line, fence-aware matcher (`computeFencedRanges`, `indexOfMarkerLine`, `hasMarkerLine`); reuse it for the migration strip [I: imported at agent-entrypoints.ts:13, distill.ts:10].
- `src/rules/distill.ts:135-148` `stripManagedBlock` (private, fence-aware) — closest existing "remove the block" code; `:162-177` `extractOtherManagedBlocks` preserves `keryx:rules` / `keryx:instructions` [V].
- Two NAIVE strippers that ignore fences: `src/lib/templates.ts:1819-1834` `extractAgentRuleBody` (indexOf) and `src/commands/review-jev-rules.ts:180-182` `stripKeryxManagedBlock` (regex) [V].
- Substring detector: `src/integrations/surfaces-w5b.ts:374-380` `agentsMdHasKeryxBlock` → `INSTRUCTIONS_ZED.probe` `:382-397` reports "AGENTS.md is missing Keryx's block — run `keryx update`" [V].
- No public "remove the index block from a file" function exists, and no project-level uninstall command removes it (`keryx integrations uninstall` covers hooks/`keryx:rules`/`keryx:instructions` only; no `src/commands/uninstall.ts`) [V].

Callers
- `syncAgentRules` (`agent-entrypoints.ts:51-119`): `src/commands/init.ts:592`, `src/commands/update.ts:495`, `src/commands/rules.ts:127`, `src/rules/distill.ts:61` [V].
- `distillAgentEntrypoints` (`distill.ts:56-110`): `src/commands/rules.ts:107`; its `rewriteEntrypoint` `:272-292` REWRITES the whole root file then calls `ensureMetaprojectReference` [V].
- `listRootEntrypoints` (`distill.ts:116-120`, read-only twin): `init.ts:551`, `update.ts:428`, `rules.ts:87` [V].

Where the entrypoint list is decided
- `agent-entrypoints.ts:226-266` `findAgentEntrypoints` — candidates `[...manifestSources, "AGENTS.md","agents.md","CLAUDE.md","claude.md"]`, realpath-deduped; `:268-277` `ensureDefaultAgentEntrypoints` CREATES both AGENTS.md and CLAUDE.md when missing (`createDefault !== false`). Same candidate list duplicated at `distill.ts:117` [V].
- The source list doubles as the IMPORT list: each source is mirrored to `.metaproject/rules/<slug>.md` (`agent-entrypoints.ts:102-109`, `ruleFileNameFor` `:222`) and named in `skills/project-rules/README.md` and `routing.md` (`templates.ts:18,37,283`). "Where the block goes" and "which files are imported as rules" are one list today; the change must split them.

`agentEntrypoints` typing / reading / writing — three local types, two shapes
- `init.ts:236-240` type `{index, readme, root: string[]}`; read `:553`; written by `buildManifest` `:1946-1950` [V].
- `update.ts:185-187` type `{root?: string[]}`; read `:428`, `:497`; written `:1454-1487` `updateManifestAgentEntrypoints` (sets `root` and `metaproject`), and `:1415-1418` `writeRecoveredManifest` hard-codes `["AGENTS.md","CLAUDE.md"]`; `normalizeManifest` (called `:1699`) is the existing place for legacy-shape migration (`migrated` flag → rewrite at `:468-472`) [V].
- `rules.ts:36-39` type `{root?, metaproject?}`; read `:87,109,129`; written `:194-206` `persistManifestEntrypoints` [V].
- This repo's manifest carries all four keys: `.metaproject/metaproject.json:257-265` [V].
- Schema: `src/standard/schemas.ts` `METAPROJECT_SCHEMA` does NOT mention `agentEntrypoints` (zero hits under `src/standard/`), nor does any file in `docs/requirements/` [V by search]. Whether the top-level schema allows extra properties was not opened [I]. Prose contracts only: `docs/docs/workspace-and-lifecycle.md:155,227`, `docs/docs/architecture.md:498`, `docs/docs/modules.md:1288`.

### B. Other writers of AGENTS.md / CLAUDE.md

- "Claude-only rules" section: NO writer in `src/` or `scripts/` (zero hits). It is hand-written, outside the block, and is tracked team content — it must stay in CLAUDE.md [V]. `src/gdskills/bundled/rules/core/opus-5-5-prompting.mdc:14-15,105` documents "cited from CLAUDE.md, not AGENTS.md".
- Model guidance (flow 336/348): inside the index block only (A) [V].
- `keryx rules distill`: rewrites the root files wholesale (`distill.ts:290`) — a deliberate tracked-file edit the user asked for, but it then re-inserts the block in the same file [V].
- `rules-export` surface (opt-in): `keryx:rules` block into `CLAUDE.md` (`src/integrations/surfaces-rules.ts:177-181`) and `AGENTS.md` (`:188-192`), also GEMINI.md, `.github/copilot-instructions.md`, `.cursor/rules/keryx-rules.mdc`, `.kiro/steering/keryx-rules.md`, windsurf; target is a literal `relativePath` per surface [V]. A second managed block in tracked files that the plan does not list.
- `keryx:instructions` pointer block: `src/integrations/markdown-block.ts` for gemini-cli/kiro/copilot (`surfaces-w5b.ts`); zed's is probe-only against AGENTS.md [V for zed, I for the rest].
- `keryx orient` / ctx hooks write JSON settings, not markdown (D).
- Readers that assume the block/rules live in the tracked files: `src/standard/validate.ts:186,365-381` (ERROR `entrypoint-missing-index-link` when an existing AGENTS.md/CLAUDE.md lacks `.metaproject/index.md`), `src/standard/profiles.ts:18,54-66,124-128` (`agent` profile requires a root entrypoint linking the index), `src/commands/review-jev-rules.ts:202-208`, `src/harness/external/acp-run.ts:123` (`CONTEXT_FILES = ["AGENTS.md", ".metaproject/index.md"]`), `src/security/audit-harness/surfaces.ts:73-82` (`INSTRUCTION_FILENAMES`), `src/harness/external/write-run.ts:122-123` (flagged basenames `claude.md`, `agents.md`), `scripts/benchmark/run-ablation-codex.ts:202` (context-off strips AGENTS.md/CLAUDE.md) [V except the last, I].

### C. `.gitignore` block

- Writer: `src/lib/metaproject-gitignore.ts:16-47` `syncMetaprojectGitignore(projectRoot)`; markers `:18-19`; entries `:88-143` `renderMetaprojectGitignoreBlock` (re-exported `templates.ts:1733`). Always rewrites `<root>/.gitignore` via `writeContained`; creates the file when absent [V].
- Blanket-ignore logic already present: `:30-42` keeps a `.metaproject/` line when nothing under `.metaproject` is tracked (`metaprojectIsTracked` `:50-58`, `git ls-files`) — but it STILL appends the managed block. "Write nothing" is new behaviour [V].
- Callers: `init.ts:587`, `update.ts:244` (unconditional, before `refreshServiceFiles`) [V].
- Removal path: none. Only the in-place regex replace at `:25-29` [V].
- `git check-ignore`: not used in any production code; tests only (`init.test.ts:207-222,435`, `update.test.ts:285-295`, `learning/gitignore-guard.test.ts:15`, `trigger-agent-task.test.ts:198`). `.git/info/exclude`: no writer anywhere (one comment, `src/security/path-scan.ts:245`) [V].
- Common-dir resolvers (three copies): `src/lib/git-worktrees.ts:24-35` `resolveGitCommonDir` (absolute, `undefined` outside git), `src/lib/clone-scope.ts:15-30` `gitCommonDir` (`null`), `src/lib/git-hooks.ts:4-24` `resolveGitHooksRoot` (falls back to `stat(.git).isDirectory()` without git, so a `.git` FILE with no git binary yields null). All shell out to `git rev-parse --git-common-dir`; none parses the `.git` file by hand [V].
- Writing outside the project root: `writeContained` is bounded by `projectRoot`, and in a linked worktree `info/exclude` is outside it. The precedent is `src/lib/managed-git-hook.ts:114-150` `resolveContainedHookPath` (raw `writeFile`, containment checked against the realpath'd common dir + project root) and its single ALLOWLIST entry in `src/lib/contained-write.ratchet.test.ts:109+` [V].
- `info/exclude` lives in the common dir, so one write covers every worktree of the clone [V: git behaviour; consistent with `git-worktrees.ts:9-18`].
- This repo's own `.gitignore:10-16` says `.claude/settings.json` "stays tracked on purpose"; hand-added lines at `:53-92` sit outside the managed block because `keryx update` regenerates it [V].

### D. `.claude/settings.json` hooks

Shared write path: every JSON surface goes through `SettingsFileOwner` — `src/integrations/settings-file.ts:36-93` `createSettingsFileOwner`, `:104-121` `installSurfaces`, `:133-152` `uninstallSurfaces` (never deletes a non-`ownsWholeFile` file; leaves `{}`), `settings-json.ts:16` `MANAGED_KEY`, read/write helpers there. Owners are keyed by `relativePath`: `src/integrations/registry.ts:314-329` `SETTINGS_FILE_OWNERS` / `settingsFileOwnerFor` [V].

The path is NOT a shared constant — the literal is repeated per surface:
- `src/integrations/surfaces.ts:143` (CTX_GUARD_CLAUDE), `:396-397,412` (ORIENT_CLAUDE), `:515-516` (SECURITY_CHECK_INPUT_CLAUDE), `:545-546` (SECURITY_CHECK_OUTPUT_CLAUDE) [V]
- `src/integrations/surfaces-learning.ts:130-131,157` (LEARNING_OBSERVER_CLAUDE, opt-in) [V]
- `src/integrations/jev-edit-guard-surface.ts:21` `EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH` — standalone, NOT in `HARNESS_ADAPTERS`; own CLI `src/commands/review-jev-edit-guard.ts` install/uninstall/status [V]
- `src/security/agent-hooks.ts:33` `AGENT_SETTINGS_RELATIVE_PATH` (exported constant); `agentSettingsPath` `:35-37` derives from `CLAUDE_RUNTIME` (`src/security/agent-hooks/runtimes.ts:81-94`, a view over the registry) [V]
- `AGENTS_CLAUDE` (`src/integrations/surfaces-agents.ts`) writes `.claude/agents/` — not opened [I].

Installers / callers
- Security: `installSecurityAgentHooks` / `uninstallSecurityAgentHooks` (`agent-hooks.ts:122-136`) ← `init.ts:669,693`, `update.ts:707,719`; sentinel probe `agentSettingsHasSecuritySentinel` duplicated at `init.ts:1633-1641` and `update.ts:1677-1685`; prompt text `init.ts:514`, help `init.ts:1337` [V].
- The manifest records the path: `modules.security.hooks.agent = ".claude/settings.json"` (`.metaproject/metaproject.json:221`; asserted `security-hooks-init.test.ts:92,116`) — a tracked file naming a per-developer target [V].
- ctx guard / orient: `src/ctx/runtimes.ts`, `src/ctx/orient-runtimes.ts`, `src/ctx/hook-install*` are views over the same registry surfaces [I from headers + tests].
- Generic: `keryx integrations install|uninstall|doctor` → `src/integrations/installer.ts` (`installIntegration`, `uninstallIntegration`, `doctorIntegration`, `wasSurfaceInstalled`) [I].
- `src/commands/hooks.ts` manages `.metaproject/hooks.json` / `~/.keryx/hooks.json` (keryx-shell runtime; `_keryxManaged` is an object there) — unrelated to Claude settings [V].
- `src/mcp/client-config.ts` writes `.mcp.json` etc. with its own sentinel — unrelated file, already gitignored in this repo [V].

Install-state records the path in a TRACKED file: `src/integrations/install-state.ts:51-58` → `.metaproject/data/integrations/install-state/<runtime>.json` with `writtenPaths` + `sha256`; the gitignore block comment says "Install-state under data/integrations/ stays tracked" (`metaproject-gitignore.ts:112-114`) [V].

Knowledge of `settings.local.json` today: only `src/security/audit-harness/surfaces.ts:90-95` `EXTRA_SETTINGS_PATHS` (scan-only). No installer, validator or status path reads it [V].

Generated artifact: `docs/integrations/harness-capability-matrix.json:15-30` lists `.claude/settings.json` four times; `src/integrations/harness-capability-matrix.test.ts:126` fails when it is stale relative to `HARNESS_ADAPTERS` (regenerate via `keryx integrations matrix`, `src/integrations/matrix.ts:64`) [V].

Non-Claude runtimes from the same registry (`registry.ts:60-257`) — must not move: codex `.codex/hooks.json` (ctx-guard, orient) + AGENTS.md rules-export; cursor `.cursor/hooks.json`; windsurf `.windsurf/hooks.json`; antigravity `.agents/hooks.json`; opencode `.opencode/plugin/keryx-ctx-guard.js`; generic-mcp `.mcp/security-hooks.json`; gemini-cli `.gemini/settings.json`; kiro `.kiro/hooks/…`; copilot; zed (no file); keryx-shell (no file). Scoping to Claude = changing the five Claude surfaces' `relativePath`/`settingsFile` plus the jev-edit-guard constant and `AGENT_SETTINGS_RELATIVE_PATH`; `assertRegistryCoherent` (`registry.ts:360-421`) keys on `relativePath`, so all Claude surfaces must move together [V].

### E. `keryx doctor` / `keryx health`

- `src/commands/doctor.ts`: shape `DoctorCheck {id, status: "ok"|"warn"|"fail", detail, fix?}` `:42-48`; registration = the `projectChecks` array in `buildDoctorReport` `:455-481`; render `:488-498`; only `fail` sets exit 1 `:484-486`; help text `:506-512` enumerates the checks [V].
- Closest check to copy: `checkWorktrees` `:91-125` (git + fs, returns `warn` with a `fix` string, resolves the main checkout). `checkIntegrations` `:259-282` is the delegate-and-summarise pattern. Header `:10-20`: every check must stay fast (under 3 s total) [V].
- `keryx standard doctor` (`src/standard/validate.ts`): `Issue {code, message, fix?}` via `issue()` `:197-199`; surfaces in doctor through `checkStandard` `:284-303` [V].
- `keryx health`: `src/health/` has quality sources (`sources/eslint|typescript|tests|dependency-audit|sonarqube`) and metrics; no workspace-hygiene check registry was found. A "managed block in a tracked file" check has no natural home there — not confirmed by reading `run.ts` [I].

### F. Tests that pin current behaviour

Index block / entrypoints
- `src/commands/rules.test.ts`: "rules sync imports AGENTS and CLAUDE as high-priority rules" `:55` (manifest root `["AGENTS.md","CLAUDE.md"]` `:109`, block order in AGENTS.md `:108`); "creates default AGENTS and CLAUDE entrypoints when none exist" `:115`; "upgrades an existing keryx entrypoint block to the hard gate" `:154`; "creates CLAUDE when only AGENTS exists" `:205` (`:236`); "rules distill splits large CLAUDE…" `:242`.
- `src/rules/agent-entrypoints.test.ts` (16 tests: replace/insert/unterminated/symlink/model-choice), `src/rules/distill.test.ts` (6), `src/lib/agent-entrypoint-blocks.test.ts`, `src/lib/templates.test.ts:125-134,261,400-483`.
- `src/commands/routing-entrypoint-lifecycle.test.ts:32,67,127` (exactly one block in AGENTS.md `:60`; manifest `:149`).
- `src/commands/update.test.ts` — 12 fixtures with `agentEntrypoints: { root: ["AGENTS.md"] }` (`:105…:804`), `:684` empty root; `src/commands/init.test.ts:174` reads AGENTS.md after init.
- `src/commands/review-jev-rules-discovery.test.ts:34-61`, `src/integrations/installer.test.ts:65,300`, `src/integrations/w5b-adapters.test.ts:555-560` (zed probe), `src/commands/integrations.test.ts:32`, `src/integrations/rules-export.test.ts:111-114`.
- `src/commands/skills-route.test.ts:96-106`, `src/commands/routing-corpus.ts:1306-1377` (+ `.test.ts`): routing prompts "refresh the managed block in AGENTS.md" → agent-entrypoint-manager.

.gitignore
- `src/lib/metaproject-gitignore.test.ts`: `:78` replaces old block; `:124` symlink refusal; `:154` blanket ignore survives (asserts the block IS still written, `:161`); `:167` blanket ignore dropped when tracked.
- `src/learning/gitignore-guard.test.ts:19,33` (second test asserts THIS repo's root `.gitignore` ignores two paths), `src/commands/init.test.ts:181-226`, `src/commands/update.test.ts:285-295`, `src/commands/trigger-agent-task.test.ts:198-199`.

settings.json (all assert the literal path)
- `src/commands/security-hooks-init.test.ts` (8 tests, `:92-334`), `src/security/agent-hooks.test.ts`, `src/security/agent-hooks.coexistence.test.ts`, `src/ctx/hook-install.test.ts`, `src/ctx/hook-native-search.test.ts`, `src/ctx/hook-siblings.test.ts`, `src/ctx/orient-runtimes.test.ts`, `src/commands/orient.dry-run.test.ts:20`, `src/integrations/{coexistence,installer,install-state,owner,registry,settings-file,surfaces-learning}.test.ts` (`registry.test.ts:189,251,334`), `src/commands/integrations.test.ts:95-132,440-454`, `src/commands/review-jev-edit-guard.test.ts:358`, `src/commands/update.test.ts:620-669`, `src/security/audit-harness/audit-harness.test.ts` (27 hits), `src/commands/security-audit-harness.test.ts:98,210`, `src/integrations/harness-capability-matrix.test.ts`.

Fixture helpers: there is no shared temp-git-repo helper. Pattern = `mkdtemp(path.join(tmpdir(), "keryx-…"))` or `uniqueTestRoot` (`src/lib/test-tmp.ts`), `Bun.spawnSync(["git","init","-q"], {cwd})`, local `withCwd`, `rm` in `finally` (`init.test.ts:181-226`). Reusable local helpers with `user.email`/`user.name` config: `initRepo` in `src/lib/managed-git-hook.test.ts:8-20` and `src/lib/managed-hook.test.ts:15`. Linked-worktree fixtures: `src/lib/git-worktrees.test.ts`, `src/bus/paths.test.ts:62` [V for the first two, I for the rest].

### G. Docs / skills / templates

Skills — source vs generated
- `agent-entrypoint-manager`: NO bundled file. Source of truth is the `renderedSkill(...)` literal at `src/gdskills/catalog.ts:523-528` (`renderedSkill` defined `:620-630`; install renders SKILL.md from it). Generated copy: `.metaproject/skills/gdskills/platform/agent-entrypoint-manager/SKILL.md` [V].
- `agent-entrypoint-distiller`: source `src/gdskills/bundled/skills/platform/agent-entrypoint-distiller/SKILL.md` (lines 3,19,35,57,66 name the files; 35 and 66 assert "AGENTS.md and CLAUDE.md both still reference `.metaproject/index.md`") plus catalog entry `catalog.ts:529-533`; generated copy under `.metaproject/skills/gdskills/platform/…`. Length ceiling 78 lines: `src/gdskills/skill-length-ceilings.ts:133`; `src/gdskills/bundled-eval.ts:1462` cites it [V].
- Also generated from the catalog: `.metaproject/skills/catalog.md:61-62`, `.metaproject/modules/gdskills.md:59-60`, `.metaproject/keryx-dashboard.html`.
- Regeneration: edit under `src/` by hand; `installGdskills` (`init.ts:626`, `update.ts:623`) rewrites `.metaproject/skills/gdskills/**` on `keryx init`/`keryx update`. Project memory says never to run `bun run keryx` mutations against this repo's real `.metaproject/` — the generated copies are refreshed by the installed `keryx update`, so they may lag until a release [V for the mechanism; the memory entry is cited, not re-verified].
- Related bundled text: `src/gdskills/bundled/skills/platform/claude-md-management/SKILL.md:41-51,98`, `src/gdskills/bundled/rules/core/rule-management-workflow.mdc:20-58`, `src/gdskills/catalog.ts:299,550`.

Source strings naming the entrypoints
- `src/lib/agent-entrypoint-blocks.ts:57` (block text), `src/commands/rules.ts:249-250`, `src/standard/help-groups.ts:686`, `src/cli-registry.ts:445`, `src/commands/init.ts:514,1163,1299,1337`, `src/commands/update.ts:1892`, `src/lib/templates.ts:1745,1799`, `src/security/templates.ts:67-70`, `src/standard/validate.ts:376-377`, `src/integrations/surfaces-w5b.ts:389,396`, `src/standard/command-registry.coverage.test.ts:82,85`.
- Frozen fixture: `fixtures/cli-help-pre-flow-303/flat-help.txt:152` (historic snapshot — check before editing).

User docs
- `docs/docs/workspace-and-lifecycle.md:91-97,155,164,198-227,253,272-273,363-368`; `docs/docs/modules.md:1061,1250-1294,1311`; `docs/docs/cli-reference.md:98,1227,1246,2706,3808-3844,5539-5547`; `docs/docs/architecture.md:30,59,103,113,498,614`; `docs/docs/integrations.md:200-206,243-270,343`; `docs/docs/onboarding.md:337,396`; `docs/docs/commands-by-task.md:179`; `docs/docs/learning.md:149,180`; `docs/docs/README.md:20`; `docs/docs/guides/give-an-agent-context.md:19`; `docs/docs/guides/portability.md:49,358-368`; `README.md:77,226,725-730,919`.
- This repo's own `AGENTS.md:8` and `CLAUDE.md:8` carry the block (dogfood migration).

### H. Risks and gaps in the plan

External behaviour (fetched 2026-09-30)
1. Claude Code, `code.claude.com/docs/en/memory`: CLAUDE.local.md is loaded alongside CLAUDE.md and appended after it [V]. But a CLAUDE.local.md COUNTS as a CLAUDE.md for the AGENTS.md fallback: in a repo that has only AGENTS.md, creating CLAUDE.local.md makes Claude stop reading AGENTS.md unless the user sets `instructionFiles: claude-md-and-agents-md` in USER settings (the key is ignored in project/local settings). Creating CLAUDE.local.md "if missing" therefore silently drops the team's AGENTS.md for Claude in AGENTS-only repos. Mitigation to decide: write `@AGENTS.md` as the first line of a generated CLAUDE.local.md when no CLAUDE.md exists.
2. Same page: "a gitignored CLAUDE.local.md only exists in the worktree where you created it". Linked worktrees (`.claude/worktrees/*`, used for every flow here) get neither CLAUDE.local.md nor `.claude/settings.local.json`: no index block, no security/ctx hooks. Today the tracked files carry both into every worktree. The plan has no worktree story.
3. Same: block-level HTML comments are stripped before injection, so the markers cost nothing; Claude does not read `AGENTS.override.md`.
4. Codex, `learn.chatgpt.com/docs/agent-configuration/agents-md`: per directory it takes AGENTS.override.md, else AGENTS.md, "at most one file per directory" — confirms override REPLACES. Combined size cap `project_doc_max_bytes` = 32 KiB default: AGENTS.md content + block can exceed it and be cut. "Regenerated when AGENTS.md changes" has no trigger in keryx except the next `keryx update`/`rules sync`; between them the override is a stale copy that shadows the team file. A doctor staleness check (hash of AGENTS.md recorded in the override) is the missing piece.
5. Claude settings, `code.claude.com/docs/en/settings`: `.claude/settings.local.json` is a supported scope above shared project; lists merge across scopes. The page says Claude Code adds the file to the user's global git excludes when IT creates the file; a keryx-created file is "by hand", so keryx must ensure the ignore itself. Cloud/remote sessions do not read the local file. Whether `hooks` arrays merge across the two files was not read explicitly [I].

Code-level
6. `keryx standard doctor` turns the migrated state into an ERROR: `validate.ts:365-381` fails every existing root AGENTS.md/CLAUDE.md that lacks `.metaproject/index.md`, and `profiles.ts:124-128` drops the `agent`/`full` profiles (then `profile-not-satisfied`). Both must learn the local targets, or every migrated repo fails `keryx doctor` via `checkStandard`.
7. `ensureDefaultAgentEntrypoints` creates tracked AGENTS.md + CLAUDE.md in repos that have neither; pinned by `rules.test.ts:115,205`. "Never CLAUDE.md" needs a decision for the greenfield case.
8. Source list = import list (A). If the manifest `root` becomes the list of block targets, `.metaproject/rules/claude-local-md.md` would mirror a per-developer file into tracked rules, and AGENTS.override.md would be imported as a duplicate of AGENTS.md. Imports must keep reading the shared files.
9. Tracked files that record per-developer targets: `metaproject.json` (`agentEntrypoints`, `modules.security.hooks.agent`) and `.metaproject/data/integrations/install-state/claude.json` (`writtenPaths`, `sha256`, `installedAt`). With `scope: "local"` entries in a tracked manifest the Codex choice becomes a TEAM setting; install-state will churn per developer unless it moves or is ignored.
10. Migration strip cannot always be byte-identical: `replaceManagedBlock` collapses `\n{3,}` → `\n\n` across the whole file (`agent-entrypoints.ts:310`), `insertMetaprojectBlockNearTop` adds blank lines, and keryx may have CREATED the file (nothing at HEAD to compare). `git diff --quiet` also needs the file to be tracked; an untracked or never-committed entrypoint needs its own branch. After a `distill` the file body itself is keryx-rewritten.
11. After stripping, a keryx-created file is left as a bare `# AGENTS Instructions` heading; `isHeadingOnlyBody` (`templates.ts:1815`) handles the mirror, but the tracked stub remains.
12. Second managed block in tracked files: opt-in `rules-export` (`keryx:rules`) in CLAUDE.md/AGENTS.md and others — same problem, not in the plan. Also `keryx trigger`/git hooks are already per-clone (fine).
13. Hook migration must go through the owner: moving a surface changes `SETTINGS_FILE_OWNERS` keys, so the OLD file has no owner any more — uninstalling from `.claude/settings.json` needs a retained legacy owner (or direct strip with each surface's `strip`). `uninstallSurfaces` leaves `{}` in a file keryx created; reaching byte-identity with HEAD for a file that did not exist at HEAD means deleting it. JSON re-serialisation (2-space, key order) will not reproduce a hand-formatted tracked file byte-for-byte.
14. Six sentinels can be present in settings.json: `security-agent-hooks`, `ctx-agent-hooks`, `ctx-orient-hooks`, the learning observer's, `jev-edit-guard-hooks`, plus the legacy `unmigratedHooks` slot. Only security is reconciled by `init`/`update`; ctx/orient/learning/jev are installed by their own commands and `update` never touches them — the migration must enumerate all, not only what `update` refreshes.
15. Duplicate execution during a partial migration: Claude merges both settings files, so hooks present in both run twice (security check-output twice per Write). "Never in both places" is a correctness property, not cosmetics.
16. `.git/info/exclude` write is outside `projectRoot` in a linked worktree → `writeContained` refuses. Needs the `managed-git-hook.ts` pattern and a new ALLOWLIST entry in `contained-write.ratchet.test.ts` (both `src/lib/metaproject-gitignore.ts` and `src/commands/{init,update,rules}.ts` are in `COVERED_FILES`, `:45-65`).
17. `git check-ignore` does not report a path that is already tracked (tests use `--no-index` for that reason). Fine for new local targets, wrong for "is `.claude/settings.json` ignored".
18. Stale-worktree prune: `hasUncommittedChanges` (`git-worktrees.ts:100-130`) treats any ignored file outside `ALWAYS_IGNORED_CARRY_OVER` (`:76`) as a reason NOT to prune. CLAUDE.local.md / AGENTS.override.md / `.claude/settings.local.json` in a worktree would block `keryx update`'s prune offer unless added there.
19. Security coverage regressions unless extended: `audit-harness/surfaces.ts:73-82` does not scan CLAUDE.local.md / AGENTS.override.md; `write-run.ts:122-123` does not flag them by basename (`.claude/` is flagged as a directory). `review-jev-rules.ts:202` and `acp-run.ts:123` read only the shared files — correct for team rules, but the external-agent context loses the index pointer only if it relied on the block (it also lists `.metaproject/index.md` directly).
20. CI / inventory guards that will fire: `harness-capability-matrix.test.ts` (regenerate the JSON), `registry.test.ts:189,251,334`, `learning/gitignore-guard.test.ts:33` (this repo's `.gitignore`), `command-registry.coverage.test.ts`, `skill-length-ceilings.ts:133`, `contained-write.ratchet.test.ts`, the gdskills bundled/installed parity tests (`bundled-eval.test.ts`, `review-orchestrator-skill-parity.test.ts`) [I for the last group], the wiki link gate (memory: a link to an untracked path breaks main on the next PR).
21. No ADR or wiki decision records "entrypoints are tracked": `docs/decisions/` holds only `keryx-harness/`, `.metaproject/wiki/decisions/` one SAC proposal. The intent is recorded only in comments (`model-choice.ts:27-34`, `.gitignore:14`, `surfaces-rules.ts:171-176`) and in `.metaproject/wiki/components/src-rules.md` / `src-standard.md` / `src-security.md` (listed by search, not opened) [I].
22. Release convention (last feature commits on origin/main, e.g. 838e5263 0.3.40, 8f674bba 0.3.39): bump `package.json` version (now 0.3.40), add a `## [x.y.z] — date` section with `### Added` / `### Notes` to `CHANGELOG.md`, update `README.md`, `docs/docs/{architecture,cli-reference,commands-by-task,modules,index}.md`, add a guide under `docs/docs/guides/` + `mkdocs.yml` when there is one, and `src/standard/{command-registry,help-groups}.ts` (+ coverage test) for any new command/flag. Commit subject `feat(scope): … (x.y.z) (#PR)`. This is a behaviour change for existing installs, so `### Changed` plus a migration note is warranted [V from `git log --name-only` and `CHANGELOG.md:1-30`].
23. `keryx update --preview` (`update.ts:423-461`) and `init --preview` promise "writes nothing"; the migration and the exclude write need a preview line, and `previewServiceFiles` currently says hooks "are not digest-planned".
24. Non-git projects: `keryx init` works before `git init` (`init.ts:1158-1163`). With no git there is no `info/exclude`, no HEAD and no check-ignore; the local-target path needs a defined fallback.

Not examined: `src/integrations/installer.ts` internals, `src/integrations/surfaces-agents.ts`, `src/ctx/hook-install*.ts`, `src/lib/routing-entrypoint.ts`, `src/health/run.ts`, `normalizeManifest` body in `update.ts`, the wiki component pages.

Routing audit: graph_used: no (not-relevant — text/marker enumeration, no graph query would list string literals); wiki_used: no (searched for decisions, none found; pages not opened); ctx_used: yes (`keryx ctx rg`, `keryx ctx run`); raw_rg_used: no.
