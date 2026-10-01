# Review round 2: publication-grade documentation (dispatch 367-T18-r2)

- Target: branch `docs/publication-grade-docs`, head `98e7cf6e`. Fix commit under review: `ffdb26e1` (T21, 23 files, +177/-74).
- Mode: in-process review, report only. Two parallel claim-sampling reviewers (pages from part 3 of the dispatch); the orchestrator reviewed the round-1 fixes, the T21 diff, `scripts/check-docs-nav.ts` and cross-page consistency itself, and re-checked every finding below at source.
- Isolation: every state-writing run used throwaway `HOME`/`XDG_*` dirs and scratch repos under the session scratchpad (`r2-prepush`, `r2-a-*`, `r2-b-*`); `echo $HOME` was confirmed to be a temp dir before `init`. `git fetch --refmap= origin main` was run once to check mergeability against the live main (writes only `FETCH_HEAD` and objects). See "Process note" for one reviewer's cwd slip.

## Verdict

**Changes required.** Findings: 0 blocker, 1 major, 6 minor, 9 info.

The fix round is mostly sound. M1 and M3 are fixed at every site, and M3's new instructions were verified end to end. All 19 round-1 minors are fixed. But M2 was fixed only at the site round 1 named: the same false sentence remains on `docs/docs/harness.md`, which round 1's sweep missed because the sentence wraps across two lines. The new negation logic in the nav check closes round 1's false pass but adds another one through the `\!` escape it introduced.

## Round-1 findings at HEAD

| id | state | evidence |
|---|---|---|
| M1 | fixed | `security-model.md:58`, `permission-modes.md:25,104-111` and `shell.md:62` now say `/mode auto` asks, while `--auto`, `--permission-mode auto` and a saved default do not. This matches `shell.ts:2836-2849` and `tui-shell.ts:6995-7033`. The only writers of `permission-mode.json` are those two `/mode` handlers, so "`/mode auto save` itself asked once" holds. The new floor sentence (SAC review, publish lease) matches `permission-mode.ts:155-157`. A sweep for auto+confirm claims over docs, READMEs, SECURITY and ARCHITECTURE found no remaining site. |
| M2 | **partly fixed** (see N1) | `harness-and-safety.md:50` now gives per-profile defaults, which match `profiles.ts:53-100` and `engine.ts:66-67`. `serve`'s default `remote-restricted` is `unattended-untrusted` (`profiles.ts:283-295`). The same false sentence survives on `docs/docs/harness.md:118-119`. |
| M3 | fixed, **executed** | In a scratch repo, `init --yes` installed the guard. A pushed commit with a GitHub token gave `gate: FAIL` and the push went through (advisory). I then set `"mode": "enforced"` in `.metaproject/security.config.json`, and `keryx security status` showed `mode: enforced`, `configChecksum: ok`. The next push exited 1: "security gate failed; push blocked". `architecture.md:467` and `workspace-and-lifecycle.md:581-583` are fixed too. |
| m1 | fixed | `git merge-tree` against the live `main` (`1aec6f7d`, 0.3.51) is clean. |
| m2 | fixed | Pinned versions were replaced by neutral wording. The remaining `0.3.46` mentions are labelled examples (`install.md:77,107,170`, `troubleshooting.md:43`). There are 198 tags; `v0.3.0` is dated 2026-09-25. |
| m3 | fixed | No `ACn`/`flow NNN`/`pre-flow-` text left in `cli-reference.md` outside the `flow ac` feature's own syntax (lines 3617-3650). |
| m4 | fixed | journal.md "AC10 search record (after T21)" records the command and the result. |
| m5 | fixed | The link was removed from `goal.md`. |
| m6 | fixed for the reported case; new false pass (N2) | `!keep-me.md` alone no longer exempts anything (test added, passes). |
| m7 | fixed | `keryx --help:209` shows "List, fork (branch), export or locate…"; pinned in `cli.test.ts:254-257`. |
| m8 | fixed | The new FAQ text matches `tui-shell.ts:3990` and `provider-catalog.ts:176-227` (connected providers, balance, 5-min TTL, stored keys). |
| m9 | fixed | The quickstart now names `CLAUDE.local.md` and the AGENTS.md condition. One imprecision remains (see i3). |
| m10 | fixed | `quickstart.md:251`. |
| m11 | fixed | `configuration.md:145` names `harness exec`. |
| m12 | fixed | `configuration.md:149`: `auto` is the default; precedence env > project > `sandbox.json` (`mask-resolve.ts:7-10,350-361`). |
| m13 | fixed | `security-model.md:121-124` matches `redaction.ts:76-108`. |
| m14 | fixed | `managed-work.md:57` matches `service.ts:722-733` and the legacy skip. |
| m15 | fixed | `security-model.md:186-191`. `mcp-credentials.json` is keyed by name and URL (`credentials.ts:3-17`). `mcp logout` exists. |
| m16 | fixed | The file rows were added and checked against code: `permission-mode.json` (`permission-mode-config.ts:28`), `hooks-trust.json` (`hooks/trust.ts:41`), `mcp-servers-trust.json`, `mcp-credentials.json`, `search-providers.json` and `search-credentials.json` (`search-config.ts:26,30`), and `external-providers.json` (`external-providers.ts:114`). `KERYX_SHELL_IDLE_MS` (default 120000, falls back to `KERYX_SHELL_TIMEOUT_MS`) matches `background-job-registry.ts:308-361`. The intro sentence no longer says "every". |
| m17 | fixed | `ARCHITECTURE.md:172-180`. `KERYX_HOME` → `$KERYX_HOME/.keryx` (`keryx-home.ts:15-29`). `KERYX_ASSET_CACHE` is in `resolver.ts:27-34`. |
| m18 | fixed | `governance.md:70`. |
| m19 | fixed | `skills-and-learning.md:86`, `project-knowledge.md:90`. `modules list` gives the nine. |

## Major

### N1. "Shell and destructive actions are denied by default" survives on the harness concept page (residual M2)

- **Site:** `docs/docs/harness.md:118-119`, the section "The policy engine — three answers, not two". The page is in the nav (`mkdocs.yml:103`). The sentence was added on this branch (`f634439b`) and is absent from `origin/main`.
- **Evidence:**
  - The same code as M2: `harness exec` uses `monitored-trusted-local` with `shell: "allow"` (`src/harness/policy/profiles.ts:78`), and `serve` asks.
  - `destructive` resolves to `ask` or to write's value, never to a default deny (`src/harness/policy/engine.ts:66-67`).
  - The fixed `harness-and-safety.md:50` now contradicts this page.
- **Why it was missed:** round 1's enumeration (`rg -i 'denied by default'`) cannot match a sentence that wraps after "denied by". The T21 fix covered the named site, not the class.
- **Verified:** code read; `git show origin/main:docs/docs/harness.md` has no such sentence.
- **Fix:** replace it with the per-profile wording from `harness-and-safety.md:50`, or "decided by the run's policy profile; `harness run` denies shell". Re-sweep with a multiline search (`rg -U -i 'denied\s+by\s+default'`).

## Minor

| id | file:line | claim | evidence | executed |
|---|---|---|---|---|
| N2 | `scripts/check-docs-nav.ts:69-74` (and `:29`) | New false pass: an escaped `\!literal.md` pattern exempts every file | `matchesPattern` strips the gitignore escape and hands `!literal.md` to `new Glob(...)`. Bun reads that as "everything except", the same bug m6 fixed for the unescaped form. Probe: `exclude_docs: \| \n  \\!literal.md` → `orphans(["index.md","orphan.md","guides/x.md"])` = `[]`. The new test (`check-docs-nav.test.ts:76-78`) asserts only the positive match (`!odd.md`), never that other files are not matched. Second latent false pass: `blockScalar` accepts a folded `exclude_docs: >`, which YAML joins into one pattern, but the script splits it per line (probe: `orphan.md` listed under `>` → `[]`). The real config uses neither (`exclude_docs: \| README.md`). Fix: match the literal (`file === p`, or escape for Glob) and accept only `\|`, with tests asserting non-matches. | yes (probe script) |
| N3 | `docs/docs/concepts/security-model.md:26`; `docs/docs/modules/automation.md:3, 60`; `README.md:115` | `keryx serve` is described as "loopback-only" / "a loopback … listener" | `keryx serve --help`: `[--bind <addr>] … [--acknowledge-non-loopback]`; `src/lib/serve-server.ts:251` (non-loopback allowed once acknowledged, no TLS). The security page's own body states it correctly (`security-model.md:200-201`), so the threat-table row contradicts it. Fix: "loopback by default". | yes (help) |
| N4 | `docs/docs/modules/mcp-servers.md:75` | "Importing servers you already configured in another editor is not available" | `src/mcp-servers/compat.ts:93-104` reads `~/.claude.json`, `~/.cursor/mcp.json`, `./.cursor/mcp.json`, `./.mcp.json` and `~/.grok/config.toml` / `./.grok/config.toml`. `config.ts` merges them as a lower-precedence layer, project-local ones gated by `projectLocal`. Reviewer A put a `.cursor/mcp.json` in a temp HOME, and `keryx mcp list` printed `foo (cursor) stdio`. There is no import step, but the servers are read automatically, which is the opposite of what a reader takes from the sentence. | yes (reviewer A) |
| N5 | `docs/docs/modules/providers.md:75` | "A custom provider may use a loopback or private-LAN address; built-in providers never may" | Built-in `ollama` and `rapid-mlx` use loopback (`make-provider.ts:131-136`, `allowLoopback`; `src/commands/providers.ts:423-428`), and the same page lists them. `use-a-local-model.md:19-20` gets it right ("built-in hosted"). Fix: "built-in hosted providers". | no (code read) |
| N6 | `ARCHITECTURE.md:53` | `src/rules/` is listed under "Core zone: the `.metaproject/` owners" | `src/lib/import-zones.ts:123` `{ segment: "rules", zone: "shared" }`. The others in that row (`gdskills`, `agents`) are core (`:136`, `:215`). | no (code read) |
| N7 | `docs/docs/project/built-with-keryx.md:18-19, 108-109` vs `docs/docs/project/status.md:82-89` | Two "as of 1 October 2026, reproduced by the commands on Project status" figure sets disagree | built-with: 341 flows, 2,871 tasks, 1,696 commits, 122 flows with reviews, 279 rounds. status: 343, 2,900, 1,729, 123, 280. status's 1,729 commits on `main` also exceeds the live `main` (`git rev-list --count 1aec6f7d` = 1,722), so it was measured on something other than main. AC8 asks for reproducible figures. Fix: one measurement, with the ref it was taken on. | yes (`git rev-list`) |

## Info (not defects)

- **i1.** `permission-modes.md:27` ("One thing no mode ever changes") names only the credential-file floor. `security-model.md:62-64` now lists three (`permission-mode.ts:155-157`). This is pre-existing and understates protection, so it errs in the safe direction.
- **i2.** The README quickstart, `built-with-keryx` `flow init` output and the ARCHITECTURE module/serve/serve-mcp claims were re-run by reviewer B in isolation. Output is byte-identical to the docs (`gdgraph affected` "Dependencies: none / Dependents: src/cart.ts"; "9 of 11 modules enabled").
- **i3.** `quickstart.md:281-282`: Codex gets `AGENTS.override.md` "once the repository has an `AGENTS.md`". It only appears after a later `keryx update`/`init` (`entrypoint-writers.ts:211-240`), not automatically.
- **i4.** `providers.md:73`: `auth login openai` is an alias that starts the openai-codex device flow, not a refusal (`auth.ts:73,108,120`). Grok also offers an API key. `providers.md:67` omits `GITHUB_COPILOT_TOKEN` (`providers.ts:455`).
- **i5.** `delegation.md:60` ("Only `claude-cli` and `codex-cli` can write") is true for reviewed writes. `gemini-acp --write` takes the ACP write path, and the codex version window in `--help` is not mentioned (`agents-external.ts:541-574,632-640`).
- **i6.** The `governance.md:24-39` example output lacks the `summary:`/`effect:` lines a fresh `governance report` prints. `governance.md:51` does not say that the forgetting trail records only removals that `sync --apply` observed.
- **i7.** The `ARCHITECTURE.md:110` provider list still omits `openai-codex` (round-1 i8, unchanged).
- **i8.** `status.md` stability table: ACP is called "lightly tested" on `integrations.md` but is not in the experimental row. The github-copilot LLM provider (stable) and the github-copilot-agent integration adapter (experimental) are different things, but no page says so.
- **i9.** `connect-a-provider.md:18` gives `~/.local/share/keryx/` and omits that `$XDG_DATA_HOME` is honoured on macOS too (`config-dir.ts:75-77`). `providers.md:73` states it.

## Cross-page consistency

- **Install methods:** consistent. README and `install.md` agree on npm, standalone binary, managed clone and project-local clone. Both give Bun ≥ 1.3.14 (`package.json:102-104`).
- **Provider lists:** `providers.md` matches the registry plus native adapters (17 names). `connect-a-provider.md` and `use-a-local-model.md` are consistent with it. Two gaps: `ARCHITECTURE.md` omits `openai-codex` (i7), and N5's "built-in" wording.
- **Permission-mode behaviour:** consistent after T21 across `security-model`, `permission-modes`, `shell.md`, `harness.md:138-142`, `quickstart.md:251` and the READMEs.
- **Policy defaults:** inconsistent between `harness-and-safety.md:50` and `harness.md:118` (N1).
- **Stability labels:** module pages agree with `status.md`: Stable for the nine modules, shell, providers and governance; experimental for SAC and experimental adapters; opt-in for serve, MCP server, external agents and SAC. See i8.
- **Figures:** `built-with-keryx` and `status` disagree (N7).

## Gates (run at `98e7cf6e`)

| gate | result |
|---|---|
| `mkdocs build --strict -d …/site-r2` (scratch venv) | exit 0 |
| `bun scripts/check-docs-nav.ts` | exit 0: 66 files, 65 in nav, 0 orphans |
| `bun scripts/check-doc-links.ts` | exit 0: 2047 links across 573 files, 0 broken |
| `bun scripts/check-retired-cli-spellings.ts` | exit 0: 3552 files, 69 retired spellings, 0 undeclared |
| `bun run typecheck` | exit 0 |
| `bun test` (5 named files) | exit 0: 148 pass, 0 fail, 2948 expects |

The gates passing does not clear N2: the nav gate's false pass is latent and the current config does not trigger it.

## Process note

Reviewer B reported that two of its commands ran with the shell cwd reset to the owner's checkout `/Users/Goodea/goodea/keryx`:

- `keryx shell --provider ollama --model x --base-url http://192.168.1.50:11434 --print hi`, which printed "bus: joined as @agent-1";
- a `find`/`git status`.

Afterwards, `git status` there shows the same four untracked paths as at session start, with no tracked changes. Two ignored data files there were touched in that window: `.metaproject/data/security/raw/state.json` and `.metaproject/data/learning/observations/2026-10-01.jsonl`. These could be hook side effects. Whether that shell run used the throwaway HOME is not established. The owner may want to check for a stale bus peer or registry entry.

## Stage counts

- Raised: 24. The orchestrator raised 4 (N1, N2, i1, i3). Reviewer A raised 8 (N4, N3, N5, i4×2, i5, i6×2). Reviewer B raised 6 (N6, N7, i2, i7, i9, plus a duplicate of i7).
- Merged:
  - N3: reviewer A's automation finding was merged with the orchestrator's security-model and README sites.
  - i4: two reviewer-A items.
  - i6: two reviewer-A items.
  - i7: reviewer B's D1, which duplicates round-1 i8.
- Downgraded:
  - Reviewer A's forgetting-trail item went from minor to info (i6). The page's text is accurate; only a caveat is missing.
  - Reviewer B's "outside `.metaproject/`" note was dropped. `init` writes `.keryx/sandbox-policy.json`, but that is covered by "files you ask it to install".
- Refuted: none.
- Claims sampled in part 3: 69. Reviewer A checked 36 on integrations, mcp-servers, delegation, automation, governance and providers. Reviewer B checked 33 on connect-a-provider, use-a-local-model, built-with-keryx, ARCHITECTURE and the README quickstart / "What you get".

```json keryx:findings
[
  {"id":"N1","reviewer":"orchestrator","severity":"major","file":"docs/docs/harness.md","line":118,"problem":"'Shell and destructive actions are denied by default' survives on the harness concept page (residual of round-1 M2; round-1 sweep missed it because the sentence wraps).","impact":"Overstates the policy engine's default protection; contradicts the fixed harness-and-safety.md:50.","suggested_fix":"Use the per-profile wording from harness-and-safety.md:50; re-sweep with a multiline search.","evidence":"src/harness/policy/profiles.ts:78 (monitored-trusted-local shell allow); src/harness/policy/engine.ts:66-67; absent on origin/main, added in f634439b.","confidence":"high","class_scope":{"sites":["docs/docs/harness.md:118-119","docs/docs/modules/harness-and-safety.md:50 (fixed)"],"enumeration_method":"keryx ctx rg -i 'denied by default|deny by default|denies shell' over docs/docs, README.md, ARCHITECTURE.md, SECURITY.md plus reading the line-wrapped harness.md hit"}},
  {"id":"N2","reviewer":"orchestrator","severity":"minor","file":"scripts/check-docs-nav.ts","line":69,"problem":"Escaped '\\!literal.md' pattern is unescaped to '!literal.md' and passed to Bun Glob, which treats it as negation and exempts every file; folded 'exclude_docs: >' is split per line though YAML joins it.","impact":"Latent false pass of the nav gate (current config unaffected).","suggested_fix":"Match the unescaped literal directly (file === p) or escape it for Glob; accept only '|' block scalars; add tests asserting non-matches.","evidence":"Probe: exclude_docs '\\!literal.md' -> orphans([index.md, orphan.md, guides/x.md]) = []; folded '>' with orphan.md -> []. Test check-docs-nav.test.ts:76-78 only asserts the positive match.","confidence":"high"},
  {"id":"N3","reviewer":"docs-accuracy-a+orchestrator","severity":"minor","file":"docs/docs/concepts/security-model.md","line":26,"problem":"keryx serve described as loopback-only / a loopback listener; it can bind non-loopback with --acknowledge-non-loopback (no TLS).","impact":"Threat table contradicts the page body (200-201); automation page omits the opt-in.","suggested_fix":"'loopback by default' at each site.","evidence":"keryx serve --help '[--bind <addr>] [--acknowledge-non-loopback]'; src/lib/serve-server.ts:251.","confidence":"high","class_scope":{"sites":["docs/docs/concepts/security-model.md:26","docs/docs/modules/automation.md:3","docs/docs/modules/automation.md:60","README.md:115"],"enumeration_method":"keryx ctx rg -i loopback over security-model, automation, drive-keryx-remotely, README.md"}},
  {"id":"N4","reviewer":"docs-accuracy-a","severity":"minor","file":"docs/docs/modules/mcp-servers.md","line":75,"problem":"Says importing servers configured in another editor is not available; keryx reads Claude/Cursor/Grok/.mcp.json configs automatically as a lower-precedence layer.","impact":"Readers do not know other editors' MCP servers appear in keryx shell.","suggested_fix":"Describe the compat layer and its project-local gating.","evidence":"src/mcp-servers/compat.ts:93-104; executed: .cursor/mcp.json in temp HOME -> keryx mcp list shows 'foo (cursor) stdio'.","confidence":"high"},
  {"id":"N5","reviewer":"docs-accuracy-a","severity":"minor","file":"docs/docs/modules/providers.md","line":75,"problem":"'built-in providers never may' use loopback/private LAN; built-in ollama and rapid-mlx use loopback.","impact":"Contradicts the same page's local providers.","suggested_fix":"'built-in hosted providers'.","evidence":"src/harness/provider/make-provider.ts:131-136; src/commands/providers.ts:423-428; use-a-local-model.md:19-20 states it correctly.","confidence":"high"},
  {"id":"N6","reviewer":"docs-accuracy-b","severity":"minor","file":"ARCHITECTURE.md","line":53,"problem":"src/rules/ listed under the core zone; the zone table classifies rules as shared.","impact":"Wrong architecture statement for contributors.","suggested_fix":"Move src/rules/ to the shared-zone table.","evidence":"src/lib/import-zones.ts:123 { segment: 'rules', zone: 'shared' }.","confidence":"high"},
  {"id":"N7","reviewer":"docs-accuracy-b","severity":"minor","file":"docs/docs/project/built-with-keryx.md","line":18,"problem":"Same-date figures disagree with status.md#numbers (341 vs 343 flows, 2,871 vs 2,900 tasks, 1,696 vs 1,729 commits, 122 vs 123, 279 vs 280); status's 1,729 commits exceeds the live main's 1,722.","impact":"AC8 reproducibility; visible inconsistency.","suggested_fix":"One measurement, stating the ref it was taken on, used by both pages.","evidence":"status.md:82-89; built-with-keryx.md:18-19,108-109; git rev-list --count 1aec6f7d = 1722.","confidence":"high"},
  {"id":"i1","reviewer":"orchestrator","severity":"info","file":"docs/docs/guides/permission-modes.md","line":27,"problem":"Names one hard floor; security-model now lists three.","impact":"Understates protection (safe direction).","suggested_fix":"Optional.","evidence":"src/commands/permission-mode.ts:155-157","confidence":"high"},
  {"id":"i2","reviewer":"docs-accuracy-b","severity":"info","file":"README.md","line":77,"problem":"Quickstart and built-with outputs reproduced byte-identical in isolation.","impact":"None.","suggested_fix":"None.","evidence":"scratchpad r2-b-qs","confidence":"high"},
  {"id":"i3","reviewer":"orchestrator","severity":"info","file":"docs/docs/getting-started/quickstart.md","line":281,"problem":"AGENTS.override.md appears only after a later keryx update/init once AGENTS.md exists, not automatically.","impact":"Minor imprecision.","suggested_fix":"Add 'and run keryx update'.","evidence":"src/rules/entrypoint-writers.ts:211-240","confidence":"medium"},
  {"id":"i4","reviewer":"docs-accuracy-a","severity":"info","file":"docs/docs/modules/providers.md","line":73,"problem":"auth login openai aliases to openai-codex (not a refusal); grok also offers api-key; GITHUB_COPILOT_TOKEN env path omitted.","impact":"Minor.","suggested_fix":"Optional.","evidence":"src/commands/auth.ts:73,108,120; src/commands/providers.ts:455","confidence":"high"},
  {"id":"i5","reviewer":"docs-accuracy-a","severity":"info","file":"docs/docs/modules/delegation.md","line":60,"problem":"Write statement true for reviewed writes only; gemini-acp --write and codex version window not mentioned.","impact":"Minor.","suggested_fix":"Optional.","evidence":"src/commands/agents-external.ts:541-574,632-640","confidence":"medium"},
  {"id":"i6","reviewer":"docs-accuracy-a","severity":"info","file":"docs/docs/modules/governance.md","line":24,"problem":"Example output lacks summary:/effect: lines; forgetting trail caveat (only reconciled removals) omitted at :51.","impact":"Minor.","suggested_fix":"Refresh example; add caveat.","evidence":"executed governance report; forgetting trail output","confidence":"high"},
  {"id":"i7","reviewer":"docs-accuracy-b","severity":"info","file":"ARCHITECTURE.md","line":110,"problem":"Provider list omits openai-codex (round-1 i8 unchanged).","impact":"Minor.","suggested_fix":"Optional.","evidence":"src/harness/provider/make-provider.ts:84-97","confidence":"high"},
  {"id":"i8","reviewer":"orchestrator","severity":"info","file":"docs/docs/project/status.md","line":40,"problem":"ACP 'lightly tested' (integrations.md) not reflected in the stability table; copilot provider vs copilot-agent adapter not disambiguated.","impact":"Minor.","suggested_fix":"Optional.","evidence":"integrations.md; status.md:36-41","confidence":"medium"},
  {"id":"i9","reviewer":"docs-accuracy-b","severity":"info","file":"docs/docs/guides/connect-a-provider.md","line":18,"problem":"Omits that $XDG_DATA_HOME is honoured on macOS too.","impact":"Minor.","suggested_fix":"Optional.","evidence":"src/lib/config-dir.ts:75-77","confidence":"high"}
]
```
