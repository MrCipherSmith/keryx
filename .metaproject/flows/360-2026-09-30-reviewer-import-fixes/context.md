# Context

Collected deterministically by `keryx flow init` at 2026-09-30T09:17:35.586Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.778] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.72] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
3. [1.704] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
4. [1.684] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.661] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`

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

Verified in source on 2026-09-30 (line numbers from the 0.3.39-era tree; re-locate by symbol):

- `src/gdskills/import-skills.ts` — `importProjectSkills`, `sourceFromDirectory` (the only
  filters are `namePrefix`, `--name`, bundled-name collision in `importOne`),
  `importReferencedRules` (existing target → `present` with no content compare; a bundled
  `core/` name absent in the project → `unresolved`), `runSkillsImportCommand`,
  `printSkillsImportHelp` (unreachable, see cli-registry).
- `src/review/import-reviewers.ts` — `OVERLAY_REVIEWER_PREFIX = "review-vantage-"`,
  `runImportReviewers`, `printImportHelp` (unreachable).
- `src/review/reviewers.ts` — `collectReviewers`, `metadataList` (already reads
  `metadata.paths`), `descriptionPathTriggers` (requires `*`), `descriptionFlags`,
  `renderReviewerInventoryMarkdown`.
- `src/gdskills/rule-references.ts` — `ruleReferences` matches only backticked
  `dir/name.mdc`; `unresolvedRuleReferences`.
- `src/gdskills/project-skills.ts` — `createProjectSkill`, registry and catalog-row writers
  (what `skills remove` must undo). `src/commands/skills.ts` — subcommand router (no
  `remove`; `uninstall` is install-state only).
- `src/standard/command-registry.ts` — command descriptor registry behind
  `keryx commands --json`; every new command/flag is declared here.
- `src/gdskills/manifest/manifest.ts` — `bundledManifestPath()`: first candidate
  `../bundled/install-manifest.json` relative to the module, fallback `../../src/gdskills/bundled/…`.
  From the published flat `dist/cli.js` both miss (`<pkg>/bundled/…` and one level above
  the package). The manifest itself ships: `package.json` `files` has `src/gdskills/bundled`.
  Reproduced on the installed 0.3.39: `keryx skills install --profile full --dry-run` → ENOENT.
  Compare with `bundledRulesSourcePath` in `src/gdskills/install.ts`, which resolves correctly.
- `src/cli-registry.ts` — `printCommandHelp` / `groupUsage` / `DEEP_HELP_GROUPS` /
  `RICH_GROUP_HELP`: `--help` is intercepted before the route for every group not listed,
  and prints a slice of `USAGE_BODY`. Observed: `keryx review --help` prints
  `attach|start|ingest|status|complete` only; `keryx skills import --help` prints the
  generic skills list.
- `src/commands/review.ts` — subcommand router (~30 subcommands), `IMPORT_FLAGS`.
- `src/gdskills/catalog.ts` — `review-pr-feedback` and `code-ai-review` are `["full"]` only.
- Bundled text: `src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md`
  ("Agent Runtime Compatibility", "A round never answers a pull request another skill is
  answering", legacy profile flag table) and `SKILL.detail.md` (`flags` row: "never
  path-gated"); `review/review-frontend/SKILL.md` (`onMount` in the MVVM checklist, the
  lifecycle checklist and its flag list, vs. the "correct lifecycle bridge — do not flag"
  line); `src/gdskills/bundled/rules/core/mobx-store-template.mdc` ("Lifecycle
  Initialization"); `core/reviewer-skill-creator/SKILL.md` ("Bulk import of overlay
  reviewers").

Corrections to the incoming report: `keryx review import` exists and is NOT an alias (it is
the filtered form); `metadata.paths` already exists; the install manifest IS published —
the resolver is wrong.

Not verified, worker must check: that `keryx update` / `keryx install` overwrite
`.metaproject/rules/core/` and leave other `rules/` subdirectories alone; that the
manifest installer's `--with` adds a single bundled skill once the path is fixed.

Operational constraints (project memory):

- The `keryx` on PATH is the published package, not this checkout. Exercise changed code
  with `bun run src/cli.ts …` (or the repo's own script) and only against a temp project
  directory — never run this checkout's mutating commands against this repository's
  `.metaproject/`.
- Full `bun test` flakes on 5s timeouts under load: run focused files, `--timeout 30000`.
- Code search goes through `keryx ctx rg`.
- No AI co-author / "Generated with" trailers in commits or the PR.
