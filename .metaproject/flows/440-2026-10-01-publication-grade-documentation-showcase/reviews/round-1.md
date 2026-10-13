# Review round 1: publication-grade documentation (dispatch 367-T18)

- Target: `origin/main...HEAD` on `docs/publication-grade-docs`, head `17b84499` (135 files, +11k/-5k).
- Mode: in-process review-orchestrator, lightweight (report only). Local only; no review-service (Jev/OpenRouter) checks were run.
- Reviewers (4, parallel):
  - `review-logic`: src help text, tests, `scripts/check-docs-nav.ts`.
  - `docs-accuracy-a`: README, README.ru, getting-started/*, project/status, project/faq, index.
  - `docs-accuracy-b`: concepts/security-model, reference/configuration, modules/*, concepts/metaproject, SECURITY, ARCHITECTURE.
  - `launch-quality`: cross-page consistency, AC audit, link/nav/strict build.
- CI: the orchestrator reviewed `.github/workflows/docs.yml` itself.
- Verification: the orchestrator re-checked every major finding and these minors against the source at head: m1, m3, m5, m7, m11/m12 (configuration.md lines).

## Verdict

**Changes required.** Findings: 0 blocker, 3 major, 19 minor, 8 info.

The src/scripts change is sound:
- Help-only edits changed no dispatch behaviour. Exit codes are identical across 26 invocations at merge-base vs head.
- The coverage tests fail under mutation.
- `mkdocs build --strict`, the link check, the retired-spelling check and the nav check all pass.
- Both quickstarts run verbatim, with output matching the docs.

The majors are all security or safety statements that overstate protection.

## Major

### M1. "Entering `auto` always needs a confirmation" is false

- **Sites:**
  - `docs/docs/concepts/security-model.md:58`
  - `docs/docs/modules/shell.md:62`
  - `docs/docs/guides/permission-modes.md:104-106` ("There is no flag or setting that skips that confirmation")
- **Evidence:**
  - `keryx shell --auto` and `--permission-mode auto` set the mode with no prompt: `src/commands/shell.ts:3355-3359` sets `permissionModeFlag`, and `:2153-2154` applies `initialPermissionMode ?? getProjectPermissionMode(cwd) ?? DEFAULT`. The TUI does the same at `src/tui/tui-shell.ts:5724-5725`.
  - A saved per-project default of `auto` also starts every later session in auto.
  - Only the in-session `/mode` switch asks (`shell.ts:2841-2852`, `tui-shell.ts:7004`).
- **Verified:**
  - Code read by the orchestrator at head.
  - Executed: `keryx shell --provider fake --no-tui --auto --print "say hi"` showed no confirmation.
- **Fix:** state that `/mode auto` asks, while `--auto`, `--permission-mode auto` and a saved project default do not. Alternatively, make the code match the docs.

### M2. "Shell and destructive actions are denied by default" overstates the policy engine

- **Site:** `docs/docs/modules/harness-and-safety.md:50`
- **Evidence:**
  - Defaults depend on the profile:
    - `harness exec` uses `monitored-trusted-local`, which has `shell: "allow"` (`src/harness/policy/profiles.ts:78`; selected at `src/commands/harness.ts:239-240`).
    - `serve` defaults to `unattended-untrusted`, which has `shell: "ask"`.
    - Only `read-only-review` (`harness run`) denies shell.
  - `destructive` resolves to `ask` when write is allow, and otherwise inherits write's value (`src/harness/policy/engine.ts:66-67`). It is never denied by default.
- **Verified:** code read by the orchestrator at head. Not executed.
- **Fix:** describe per-profile defaults, or say "decided by the run's policy profile; `harness run` denies shell".

### M3. The pre-push guard is presented as a leak control, but it only warns by default

- **Sites:**
  - `docs/docs/concepts/security-model.md:24`: the threat table lists "pre-push guard" as the mitigation for secrets leaking into commits.
  - `docs/docs/concepts/security-model.md:122-123`: "`keryx init` installs a pre-push guard".
- **Evidence:**
  - The default security mode is `advisory` (`src/security/config.ts:21`), and `isBlockingMode("advisory")` returns false (`src/security/guard.ts:243-244`).
  - The hook template itself says advisory "warns and allows the push" (`src/security/templates.ts:61-62`).
  - Other pages already say this correctly (`workspace-and-lifecycle.md:593`, `cli-reference.md:1344-1348`). The security page is the one that omits it.
- **Verified:**
  - Code read by the orchestrator at head.
  - Executed: init installed the hook, and `flow complete` reported "advisory does not block".
- **Fix:** say the guard warns in the default `advisory` mode and blocks only in `enforced`/`ci`/`gateway`. Name the setting that turns blocking on.

## Minor

| id | file:line | claim | evidence | executed |
|---|---|---|---|---|
| m1 | `package.json:3` | The branch does not merge cleanly with main | `git merge-tree --write-tree --name-only origin/main HEAD` → `CONFLICT (content): Merge conflict in package.json`. main is at 0.3.51 (4 commits ahead). Needs a rebase before merge. | yes |
| m2 | `docs/docs/project/status.md:12` vs `:77`; `docs/docs/getting-started/install.md:48-50`; `SECURITY.md:15` | Version numbers are stale and contradict each other | status.md:12 says "0.3.49 on 1 October", but :77 says "main at version 0.3.50". install.md shows `keryx --version` printing `0.3.46` as real output. SECURITY.md says "0.3.46 as of this writing". `bun ./src/cli.ts --version` → 0.3.50; main is already 0.3.51; no `v0.3.50` tag exists. | yes |
| m3 | `docs/docs/cli-reference.md:671, 1813, 3706, 3711, 3715` | Internal identifiers remain on a rewritten public page (AC10) | "one half of AC6", "pre-flow-346 behavior", "(AC2)/(AC3)/(AC4)". Pre-existing on main, but the file is rewritten in this diff and AC10 covers it. | yes |
| m4 | `.metaproject/flows/367-…/journal.md` | AC10 requires the verifying search to be recorded in journal.md; it is not | Only the owner's naming decision is there (line ~34). No search command or result is recorded. | yes |
| m5 | `docs/docs/guides/goal.md:104-105` | Links a "competitor survey" from a public guide | The target names other agent tools in evaluative prose. This contradicts the owner's naming decision in the journal (no external names in comparisons). | yes |
| m6 | `scripts/check-docs-nav.ts:58-62` | False pass: a `!negation` pattern excludes every file | Bun `Glob("!keep.md").match("guide.md")` → true. In a scratch worktree, adding an orphan plus `!keep-me.md` under `exclude_docs` gave "0 orphans", exit 0. In gitignore/mkdocs semantics, `!` re-includes. Latent: the real config does not use `!`. | yes |
| m7 | `src/cli-registry.ts:447` | `keryx --help` still shows the old `sessions` summary ("List or export per-project shell sessions") | `help-groups.ts` was updated to list fork/path, and the subcommand index shows `list fork export path`, so the two help surfaces disagree. | yes |
| m8 | `docs/docs/project/faq.md:43-48` | "The one request it makes on its own is a version check" | Starting the TUI shell refreshes every connected provider's model catalog with the stored keys (`src/tui/tui-shell.ts:3990`; `src/harness/provider-catalog.ts:181-222`; 5-min TTL). This is not telemetry, but "the one request" is false. | no (code read) |
| m9 | `docs/docs/getting-started/quickstart.md:277-279` | "Any agent that reads the repository is pointed at `.metaproject/index.md` first" | In the quickstart run, `init` wrote only `CLAUDE.local.md` (gitignored, per checkout) and printed "Codex: skipped — AGENTS.md does not exist". | yes |
| m10 | `docs/docs/getting-started/quickstart.md:251` | "Every session starts in `ask` mode" | `ask` is only the fallback after the CLI flag and the saved project default (`shell.ts:2153-2154`; `permission-mode.ts:27`). | no (code read) |
| m11 | `docs/docs/reference/configuration.md:138` | `KERYX_SANDBOX_ALLOW_UNSANDBOXED` is documented for `harness run` | Its only reader is `buildDefaultShellAdapter` (`src/commands/harness.ts:131`), called only from `harnessExec` (`:987`, `:1156`). | no (code read) |
| m12 | `docs/docs/reference/configuration.md:142` | `KERYX_SANDBOX_MASK_MODE`: "`manual` (default)" | The built-in default is `auto` (`src/harness/process/sandbox/mask-resolve.ts:7-8, 357-358`). `manual` is only the fallback for an invalid value. | no (code read) |
| m13 | `docs/docs/concepts/security-model.md:121` | "a result that fails the scan is not stored at all" | `src/harness/evidence/redaction.ts:80-108`: only a scan that cannot complete blocks storage. A detected secret is still stored, as a masked preview plus hash and category. | no (code read) |
| m14 | `docs/docs/modules/managed-work.md:57` | The tasks, owner and review gates are "opt-in per flow" | New flows are written with `gates: {tasks: true, review: true, owner: true}` (`src/flow/service.ts:722-733`). Only `confirmation` is opt-in. A fresh flow's `flow complete` failed on all three. | yes |
| m15 | `docs/docs/concepts/security-model.md:179-180` | "Remote server credentials come from environment variables" | OAuth tokens stored by `keryx mcp auth` in `mcp-credentials.json` (`src/mcp-servers/credentials.ts`) are another source. `modules/mcp-servers.md` gets this right. | yes (help) |
| m16 | `docs/docs/reference/configuration.md:3, 17-29` | Claims to list every file in the user config directory | Missing: `permission-mode.json`, `mcp-servers-trust.json`, `mcp-credentials.json`, `search-credentials.json` (holds keys), `external-providers.json`, `hooks-trust.json`. The env table also omits `KERYX_SHELL_IDLE_MS` (`background-job-registry.ts:308-360`). | partly |
| m17 | `ARCHITECTURE.md:172` | "State outside the project is limited to one user-global directory" | configuration.md documents a second store, `~/.keryx/`. The asset cache `~/.cache/keryx/assets` (`src/assets/resolver.ts:33`) is a third. | no (code read) |
| m18 | `docs/docs/modules/governance.md:70` | `dashboard` writes only under `.metaproject/data/` | It writes `.metaproject/keryx-dashboard.html` (`src/cli-registry.ts:460`; the same page's line 60 says so). | no (code read) |
| m19 | `docs/docs/modules/skills-and-learning.md:86` (also the project-knowledge.md Status section) | "Skills and rules are part of the nine default modules" | `keryx modules list` shows gdgraph, gdctx, gdwiki, gdskills, health, testing, memory, tasks and security. There is no rules, orient or sync module. | yes |

## Info (not defects)

- **i1.** `scripts/check-docs-nav.ts:46,57-62` fails loudly, never silently, on these valid mkdocs shapes:
  - an inline `# comment` after a nav path
  - URL nav entries ending in `.md`
  - non-root gitignore matches (`README.md`, `drafts/` and `*.md` match only at the root)

  This is a robustness limit, not a false pass.
- **i2.** `src/cli-reference-coverage.test.ts:262-305`: for non-rich groups, the "`--help` lists every subcommand" tests compare the derived help with the table it is derived from. They still bite for `RICH_GROUP_HELP` groups: a mutation on wiki help failed the test.
- **i3.** `src/cli-docs-structure.test.ts`: the old "every `keryx <verb>` in README is a real verb" test was removed without a replacement. A manual re-run of that check finds no unknown verbs today.
- **i4.** README word count is 937 outside fences with HTML stripped, which passes AC2. It is 1041 if raw `<img>`/`<a>` attribute tokens are counted.
- **i5.** The auto-mode floor wording (`security-model.md:58-63`) understates protection: SAC confirm-review, publish leases and `alwaysAsk` tools also always ask. `KERYX_DANGEROUSLY_DISABLE_SANDBOX` is not mentioned on the security page.
- **i6.** CI (`.github/workflows/docs.yml`):
  - The build installs pinned `requirements-docs.txt` (lines 28-29). The nav check (line 36) runs before `mkdocs build --strict` (line 42). The Zensical job has `continue-on-error: true` (line 49), so it cannot fail the workflow. All as required.
  - `zensical` and the Bun version are unpinned. This only affects the non-blocking job and the nav step.
- **i7.** `mkdocs build --strict` prints a long plugin "MkDocs 2.0" warning. It is cosmetic.
- **i8.** `ARCHITECTURE.md` provider list omits `openai-codex`. `scripts/check-doc-links.ts` does not cover `ARCHITECTURE.md`; its relative targets exist.

## Acceptance criteria

| AC | state | note |
|---|---|---|
| AC1 | met | Approval logged at 09:23Z. The first public-file commit, `7ce54c88`, is at 09:30Z. |
| AC2 | met | 5 badges, switcher, install one-liner and docs link on the first screen. Quickstart, linked feature table (9 rows) and "where to go next" present. 937 words (see i4). |
| AC3 | met | `synced-with: README.md @ 860e82e0`. README is unchanged since that commit. All 9 sections are mirrored. |
| AC4 | met | Nav has Getting started / Guides / Modules / Concepts / Reference / Project. 13 module pages each have what/why/example/reference. Nav check: 66 files, 65 in nav, 0 orphans. |
| AC5 | met | `mkdocs build --strict` exits 0 (scratch venv, pinned requirements). Link check: 0 broken (2047 links). Retired spellings: 0 undeclared. |
| AC6 | met | Coverage test fails when `wiki backlinks` is deleted from `cli-reference.md`, and passes at head. |
| AC7 | met (spot) | `artifacts/quickstart-transcript-T16.txt` present. Both quickstarts re-run verbatim this round: all exit 0. |
| AC8 | partly | Status-page counts reproduced (skills, rules, tests, tags). Version line is inconsistent (m2). Commit/PR/round counts not re-checked: local main is stale. |
| AC9 | met | ARCHITECTURE, SUPPORT, ROADMAP, docs issue form and generated `llms.txt` all exist. `package.json` homepage/bugs/description match the README. |
| AC10 | **not met** | m3 (ids on cli-reference.md), m4 (search not recorded in journal), m5 (competitor-survey link). |
| AC11 | **not met** | This round: 3 major, 19 minor. |

## Stage counts

- **Pre-filter:** not recorded. `keryx review scope` was not run; the scope was set by the dispatch.
- **Raised:** 30 (3 major, 19 minor, 8 info).
- **Downgraded on consolidation:**
  - The `package.json` merge conflict went from major to minor (m1). It is a rebase chore, not a content defect.
  - The nav-parser loud failures went from minor to info (i1). They cannot cause a false pass.
- **Merged:** the duplicated SECURITY.md version report (two reviewers) into m2.
- **Refuted by verifier:** none. Wave C `review-verifier` was not dispatched; the orchestrator re-checked the majors at source.
- **Retained:** 30.

```json keryx:findings
[
  {"id":"M1","reviewer":"docs-accuracy-b","severity":"major","file":"docs/docs/concepts/security-model.md","line":58,"problem":"Docs say entering auto mode always needs an explicit confirmation and no flag skips it; --auto, --permission-mode auto and a saved project default enter auto with no prompt.","impact":"Users rely on a confirmation step that does not exist on the CLI-flag and project-default paths; safety overstated.","suggested_fix":"State that /mode auto asks but --auto, --permission-mode auto and a saved project default do not (or add the confirmation in code).","evidence":"src/commands/shell.ts:3355-3359 and :2153-2154; src/tui/tui-shell.ts:5724-5725; only /mode asks (shell.ts:2841-2852, tui-shell.ts:7004). Executed keryx shell --provider fake --no-tui --auto --print: no prompt.","confidence":"high","class_scope":{"sites":["docs/docs/concepts/security-model.md:58","docs/docs/modules/shell.md:62","docs/docs/guides/permission-modes.md:104-106"],"enumeration_method":"keryx ctx rg -i 'auto.{0,60}confirm|skips that confirmation' over docs/docs, README.md, README.ru.md plus manual read of the security-model and shell tables"}},
  {"id":"M2","reviewer":"docs-accuracy-b","severity":"major","file":"docs/docs/modules/harness-and-safety.md","line":50,"problem":"'Shell and destructive actions are denied by default' — policy defaults are per profile: harness exec allows shell, serve asks, destructive resolves to ask; only harness run denies shell.","impact":"Overstates the policy engine's default protection.","suggested_fix":"Describe per-profile defaults or say the run's policy profile decides; harness run denies shell.","evidence":"src/harness/policy/profiles.ts:78 (monitored-trusted-local shell allow), selected at src/commands/harness.ts:239-240; src/harness/policy/engine.ts:66-67.","confidence":"high","class_scope":{"sites":["docs/docs/modules/harness-and-safety.md:50"],"enumeration_method":"keryx ctx rg -i 'denied by default' over docs/docs, README.md, ARCHITECTURE.md"}},
  {"id":"M3","reviewer":"docs-accuracy-b","severity":"major","file":"docs/docs/concepts/security-model.md","line":24,"problem":"The security model lists the pre-push guard as the mitigation for secrets leaking into commits without saying it only warns in the default advisory mode.","impact":"Readers believe pushes with secrets are blocked by default.","suggested_fix":"State that the guard warns in advisory (default) and blocks only in enforced/ci/gateway; name the setting.","evidence":"src/security/config.ts:21 mode advisory; src/security/guard.ts:243-244 isBlockingMode(advisory)=false; src/security/templates.ts:61-62. Correctly stated in workspace-and-lifecycle.md:593 and cli-reference.md:1344-1348.","confidence":"high","class_scope":{"sites":["docs/docs/concepts/security-model.md:24","docs/docs/concepts/security-model.md:122-123","docs/docs/workspace-and-lifecycle.md:593 (correct)","docs/docs/cli-reference.md:1344-1348 (correct)","docs/docs/architecture.md:467"],"enumeration_method":"keryx ctx rg -i 'pre-push' over docs/docs, README*, SECURITY.md, ARCHITECTURE.md"}},
  {"id":"m1","reviewer":"launch-quality","severity":"minor","file":"package.json","line":3,"problem":"Branch conflicts with origin/main in package.json (main at 0.3.51).","impact":"PR cannot merge without a rebase.","suggested_fix":"Rebase onto origin/main and refresh version figures.","evidence":"git merge-tree --write-tree --name-only origin/main HEAD -> CONFLICT (content): Merge conflict in package.json","confidence":"high"},
  {"id":"m2","reviewer":"launch-quality","severity":"minor","file":"docs/docs/project/status.md","line":12,"problem":"Version numbers stale/contradictory: status.md:12 0.3.49 vs :77 0.3.50; install.md:48-50 shows --version 0.3.46 as output; SECURITY.md:15 0.3.46.","impact":"Visible inconsistency on the status and install pages.","suggested_fix":"Use one current version (after rebase) or neutral wording; mark example output as example.","evidence":"bun ./src/cli.ts --version -> 0.3.50; origin/main 0.3.51; no v0.3.50 tag.","confidence":"high"},
  {"id":"m3","reviewer":"launch-quality","severity":"minor","file":"docs/docs/cli-reference.md","line":671,"problem":"Internal identifiers on a rewritten public page: 'one half of AC6' (671), 'pre-flow-346 behavior' (1813), '(AC2)/(AC3)/(AC4)' (3706, 3711, 3715).","impact":"AC10 not met; internal ids leak to readers.","suggested_fix":"Replace with plain descriptions.","evidence":"sed -n 671p / 1813p / 3706p docs/docs/cli-reference.md","confidence":"high"},
  {"id":"m4","reviewer":"launch-quality","severity":"minor","file":".metaproject/flows/367-2026-10-01-publication-grade-documentation-showcase/journal.md","line":null,"problem":"AC10 requires the verifying search to be recorded in journal.md; no search command/result is recorded.","impact":"AC10 cannot be confirmed.","suggested_fix":"Run and record the search (command + result) in the journal after fixing m3/m5.","evidence":"rg -i 'AC10|external project|comparison' journal.md finds only the naming decision.","confidence":"high"},
  {"id":"m5","reviewer":"launch-quality","severity":"minor","file":"docs/docs/guides/goal.md","line":104,"problem":"Public guide links a 'competitor survey' that names other agent tools in evaluative prose.","impact":"Contradicts the owner's no-external-names-in-comparisons decision.","suggested_fix":"Drop the link or point at the as-built design only, without the survey wording.","evidence":"goal.md:104-105 'the competitor survey this feature is drawn from'.","confidence":"high"},
  {"id":"m6","reviewer":"review-logic","severity":"minor","file":"scripts/check-docs-nav.ts","line":58,"problem":"A '!negation' exclude pattern matches every file via Bun Glob, silencing the orphan check (gitignore semantics re-include).","impact":"Latent false pass of the nav gate.","suggested_fix":"Treat '!' patterns as re-includes (or reject them) and add a test.","evidence":"Scratch worktree: orphan + '!keep-me.md' under exclude_docs -> '0 orphans', exit 0.","confidence":"high"},
  {"id":"m7","reviewer":"review-logic","severity":"minor","file":"src/cli-registry.ts","line":447,"problem":"keryx --help still says 'sessions  List or export per-project shell sessions' while help-groups.ts and the subcommand index list fork/path.","impact":"Two help surfaces disagree.","suggested_fix":"Update the cli-registry summary to match help-groups.ts.","evidence":"bun ./src/cli.ts --help shows the old line and 'sessions      list fork export path'.","confidence":"high"},
  {"id":"m8","reviewer":"docs-accuracy-a","severity":"minor","file":"docs/docs/project/faq.md","line":43,"problem":"'The one request it makes on its own is a version check' — the TUI shell also refreshes every connected provider's model catalog with stored keys.","impact":"Egress audit surprise.","suggested_fix":"Mention the provider catalog refresh.","evidence":"src/tui/tui-shell.ts:3990; src/harness/provider-catalog.ts:181-222.","confidence":"medium"},
  {"id":"m9","reviewer":"docs-accuracy-a","severity":"minor","file":"docs/docs/getting-started/quickstart.md","line":277,"problem":"'Any agent that reads the repository is pointed at .metaproject/index.md first' — init wrote only CLAUDE.local.md and skipped Codex.","impact":"Overstated reach of the routing block.","suggested_fix":"Say which entrypoints init wrote and that they are per checkout.","evidence":"Quickstart run: 'Codex: skipped — AGENTS.md does not exist'.","confidence":"high"},
  {"id":"m10","reviewer":"docs-accuracy-a","severity":"minor","file":"docs/docs/getting-started/quickstart.md","line":251,"problem":"'Every session starts in ask mode' — ask is only the fallback after flag and project default.","impact":"Inaccurate default statement.","suggested_fix":"'starts in ask unless a flag or project default says otherwise'.","evidence":"src/commands/shell.ts:2153-2154; src/commands/permission-mode.ts:27.","confidence":"high"},
  {"id":"m11","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/reference/configuration.md","line":138,"problem":"KERYX_SANDBOX_ALLOW_UNSANDBOXED documented for harness run; it applies to harness exec.","impact":"Wrong command named.","suggested_fix":"Name harness exec.","evidence":"src/commands/harness.ts:131 reader, called only from harnessExec (:987, :1156).","confidence":"medium"},
  {"id":"m12","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/reference/configuration.md","line":142,"problem":"KERYX_SANDBOX_MASK_MODE default documented as manual; built-in default is auto.","impact":"Wrong default.","suggested_fix":"Mark auto as default.","evidence":"src/harness/process/sandbox/mask-resolve.ts:7-8, 357-358.","confidence":"high"},
  {"id":"m13","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/concepts/security-model.md","line":121,"problem":"'a result that fails the scan is not stored at all' — detected secrets are stored masked; only an incomplete scan blocks storage.","impact":"Imprecise storage guarantee.","suggested_fix":"Distinguish scan-failure (blocked) from detection (masked preview + hash).","evidence":"src/harness/evidence/redaction.ts:80-108.","confidence":"medium"},
  {"id":"m14","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/modules/managed-work.md","line":57,"problem":"Tasks/owner/review gates called opt-in per flow; they are on for every new flow.","impact":"Users surprised by gate failures.","suggested_fix":"Say these gates are on by default; confirmation is opt-in.","evidence":"src/flow/service.ts:722-733; fresh flow complete failed on all three gates.","confidence":"high"},
  {"id":"m15","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/concepts/security-model.md","line":179,"problem":"'Remote server credentials come from environment variables' omits OAuth tokens stored by keryx mcp auth.","impact":"Incomplete credential storage picture on the security page.","suggested_fix":"Mention mcp-credentials.json.","evidence":"src/mcp-servers/credentials.ts; keryx mcp --help shows auth/logout.","confidence":"high"},
  {"id":"m16","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/reference/configuration.md","line":3,"problem":"Claims to list every config-dir file; omits permission-mode.json, mcp-servers-trust.json, mcp-credentials.json, search-credentials.json, external-providers.json, hooks-trust.json; env table omits KERYX_SHELL_IDLE_MS.","impact":"Incomplete reference, including key-holding files.","suggested_fix":"Add the files and env var or drop 'every'.","evidence":"src/lib/permission-mode-config.ts; src/mcp-servers/trust.ts:37; src/lib/search-config.ts:30; src/lib/external-providers.ts:114; background-job-registry.ts:308-360.","confidence":"medium"},
  {"id":"m17","reviewer":"docs-accuracy-b","severity":"minor","file":"ARCHITECTURE.md","line":172,"problem":"'State outside the project is limited to one user-global directory' — ~/.keryx/ and ~/.cache/keryx/assets also hold state.","impact":"Inaccurate statement.","suggested_fix":"List the user stores.","evidence":"configuration.md documents ~/.keryx/; src/assets/resolver.ts:33.","confidence":"medium"},
  {"id":"m18","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/modules/governance.md","line":70,"problem":"Says dashboard writes only under .metaproject/data/; it writes .metaproject/keryx-dashboard.html.","impact":"Self-contradiction (line 60).","suggested_fix":"Correct the path.","evidence":"src/cli-registry.ts:460.","confidence":"high"},
  {"id":"m19","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/modules/skills-and-learning.md","line":86,"problem":"'Skills and rules are part of the nine default modules' — no rules module (also orient/sync in project-knowledge.md Status).","impact":"Wrong module list.","suggested_fix":"Name gdskills as the module; describe rules/orient/sync as commands.","evidence":"keryx modules list: gdgraph, gdctx, gdwiki, gdskills, health, testing, memory, tasks, security.","confidence":"high"},
  {"id":"i1","reviewer":"review-logic","severity":"info","file":"scripts/check-docs-nav.ts","line":46,"problem":"Inline nav comments, URL entries ending .md, and non-root gitignore matches fail loudly (no false pass).","impact":"Possible spurious CI failure on future valid configs.","suggested_fix":"Optional: strip trailing comments, skip URLs, unanchored matching.","evidence":"Crafted parseMkdocs/matchesPattern inputs in scratch.","confidence":"high"},
  {"id":"i2","reviewer":"review-logic","severity":"info","file":"src/cli-reference-coverage.test.ts","line":262,"problem":"For non-rich groups the --help coverage tests compare derived help with its own source table.","impact":"Low marginal coverage for those groups.","suggested_fix":"None required.","evidence":"Mutation on wiki rich help failed the test; derived groups only fail if derivation breaks.","confidence":"high"},
  {"id":"i3","reviewer":"review-logic","severity":"info","file":"src/cli-docs-structure.test.ts","line":null,"problem":"README 'every keryx <verb> is real' test removed without replacement.","impact":"Coverage loss; no current error.","suggested_fix":"Optionally restore the verb check for README and README.ru.","evidence":"Manual re-run: no unknown verbs.","confidence":"high"},
  {"id":"i4","reviewer":"launch-quality","severity":"info","file":"README.md","line":null,"problem":"Word count 937 (HTML stripped) vs 1041 counting raw tag attributes.","impact":"None if counted as rendered prose.","suggested_fix":"None required.","evidence":"scratchpad/wc.py","confidence":"high"},
  {"id":"i5","reviewer":"docs-accuracy-b","severity":"info","file":"docs/docs/concepts/security-model.md","line":58,"problem":"Auto-mode floor understated; KERYX_DANGEROUSLY_DISABLE_SANDBOX not mentioned on the security page.","impact":"Minor incompleteness.","suggested_fix":"Optional additions.","evidence":"src/commands/permission-mode.ts:131-133; src/commands/harness.ts:125.","confidence":"medium"},
  {"id":"i6","reviewer":"review-orchestrator-ci","severity":"info","file":".github/workflows/docs.yml","line":58,"problem":"CI meets requirements (pinned requirements, nav check before strict build, zensical continue-on-error); zensical and Bun versions unpinned.","impact":"Non-blocking job only.","suggested_fix":"Optional pins.","evidence":"docs.yml:28-29, 36, 42, 49, 58.","confidence":"high"},
  {"id":"i7","reviewer":"launch-quality","severity":"info","file":"mkdocs.yml","line":null,"problem":"mkdocs build prints a long plugin MkDocs 2.0 warning.","impact":"Cosmetic.","suggested_fix":"Optional DISABLE_MKDOCS_2_WARNING=true.","evidence":"scratch build log","confidence":"high"},
  {"id":"i8","reviewer":"docs-accuracy-b","severity":"info","file":"ARCHITECTURE.md","line":null,"problem":"Provider list omits openai-codex; link checker does not cover ARCHITECTURE.md (targets exist).","impact":"Minor.","suggested_fix":"Optional.","evidence":"keryx harness --help provider list","confidence":"medium"}
]
```
