# Review round 3: publication-grade documentation (dispatch 367-T18-r3)

- Target: branch `docs/publication-grade-docs`, head `2709073d`. Fix commits under review: `97ed073f` (T22, 13 files, +86/-28) and `10fcfd0b` (README.ru sync).
- Mode: single reviewer, report only, no subagents. Every command ran from `~/goodea/keryx-docs` (`pwd` confirmed at start).
- Isolation: the only state-writing runs (`keryx mcp list`/`doctor`) used throwaway `HOME`/`XDG_*` dirs and a scratch repo under `scratchpad/r3-mcp`. `HOME` was echoed first to confirm. No fetch, stash, add or commit.

## Verdict

**Changes required.** Findings: 0 blocker, 0 major, 1 minor, 3 info.

All seven round-2 findings are fixed at their named sites, and N1, N2, N4 and N7 were checked by execution. The single minor is the N3 class again. The fix changed the four sites round 2 listed. Three other sites that this branch wrote or rewrote still describe `keryx serve` as unconditionally loopback-bound. This is the same pattern as round 2's N1: the named sites were fixed, but not the whole class.

## Round-2 findings at HEAD

| id | state | evidence |
|---|---|---|
| N1 | fixed | `harness.md:118-122` now gives per-profile defaults: `harness run` denies write, shell and network; `harness exec` allows shell and asks for write and network; `serve` asks for write and shell and denies network. These match the code. `harness run` uses `read-only-review` (`commands/harness.ts:295`), and `harness exec` uses `monitored-trusted-local` (`:240`, `profiles.ts:78`). `serve` defaults to `REMOTE_DEFAULT_PROFILE = unattended-untrusted` (`profiles.ts:272,94`). Credential and destructive actions take the write value raised from `allow` to `ask` (`engine.ts:66-67`), which matches "never allowed outright". A multiline sweep (`rg -U -i 'denied\s+by\s+default\|deny\s+by\s+default\|denies\s+(write\|shell)\|allows\s+shell'`) over `docs/docs`, the READMEs, `ARCHITECTURE.md` and `SECURITY.md` finds only `harness.md:118-122` and `harness-and-safety.md:50`, and the two agree. |
| N2 | fixed, **executed** | An escaped `\!literal.md` is now matched as a literal (`check-docs-nav.ts:77-81`). A folded `>` block fails closed (`:33-35`). The new tests assert non-matches. Further false-pass attempts all gave the correct orphans (probe `scratchpad/r3-probe/probe.ts`): CRLF line endings, including CRLF nav comments and CRLF `>`; quoted patterns (`"orphan.md"`, `'guides/x.md'`, which are literal in a `\|` block for mkdocs too); a `- !orphan.md` list item inside the block; `"!orphan.md"` as a nav item; `!!keep.md`; a `!` in the middle of a pattern (`a/!b.md`, `{!x,y}.md`, `guides/!(y).md`); a bare `!`; `[!o]*.md`; and `!(index).md`. Every probe that differs from mkdocs is stricter, never looser. No false pass was found. |
| N3 | fixed at the named sites; **class residual** (see R1) | `security-model.md:26`, `automation.md:3,60`, `README.md:115` and `README.ru.md:125` now say "loopback by default". `bun ./src/cli.ts serve --help` shows `[--bind <addr>] … [--acknowledge-non-loopback]`, and `serve-server.ts:240-251` refuses an unacknowledged non-loopback bind and says there is no TLS. |
| N4 | fixed, **executed** | `mcp-servers.md:47` matches `compat.ts:93-104`. The source list is right, the precedence is Claude > Cursor > `.mcp.json` > Grok, and the trust gate keys on `projectLocal` (`trust.ts:160`). In a scratch repo with a throwaway HOME, `./.mcp.json` alone printed `probe (mcp.json) (needs approval) stdio — echo hi`. `doctor` printed "needs-approval … run `keryx mcp trust probe`". With a `~/.cursor/mcp.json` added, `homecur (cursor) stdio` printed without needing approval, and the home Cursor `probe` beat the project `.mcp.json` `probe`, as the stated order says it should. |
| N5 | fixed | `providers.md:75` says "built-in hosted providers" and names `ollama`/`rapid-mlx` as loopback. |
| N6 | fixed | `src/rules/` moved to the "Adapter zone and shared" table (`ARCHITECTURE.md:76`), which matches `import-zones.ts:123`. |
| N7 | fixed, **recomputed** | `status.md` and `built-with-keryx.md` now cite one measurement, `1aec6f7d` (= `origin/main`, `package.json` 0.3.51). I recomputed these on that commit: commits `git rev-list --count` = 1,722; merged PRs 275; `v*` tags merged into main 195; first commit 2026-07-10; flows with a `reviews/` dir 124; review-round dirs 284 (from `git ls-tree -r 1aec6f7d .metaproject/flows`); non-test `src/*.ts` 1,117; test files 1,367. All of them match the docs. |

## Round-1 major re-check (M1)

Still holds. `shell.ts:3358-3359` sets `permissionModeFlag` from `--auto`, and `shell.ts:2154` applies it as the initial mode with no confirmation. Only the `/mode auto` handler (`shell.ts:2835-2849`) prompts. Every page that describes `auto` either says that the flags and a saved default skip the prompt, or makes no claim that it asks: `permission-modes.md:25,104-109`, `security-model.md:58`, `shell.md:62` and `harness.md:143-145` (see i1). `quickstart.md:250-252` says only "unless a launch flag or a saved project default says otherwise", which is accurate. No page claims that `--auto` asks.

## Minor

| id | file:line | claim | evidence | executed |
|---|---|---|---|---|
| R1 | `docs/docs/harness.md:19`; `docs/docs/architecture.md:27`; `ARCHITECTURE.md:138` | `keryx serve` is described as "loopback-bound" or as "an authenticated, loopback HTTP entry", with no default qualifier. The N3 fix covered only the four sites round 2 enumerated. | `keryx serve --help`: `[--bind <addr>] … [--acknowledge-non-loopback]`; `src/lib/serve-server.ts:240-251`. This branch wrote or rewrote all three lines (`git diff origin/main...HEAD`). `ARCHITECTURE.md` contradicts itself: its invariants section says "`serve` binds loopback unless the operator acknowledges otherwise". The same class exists, unchanged from `main`, at `guides/drive-keryx-remotely.md:4` (the dedicated serve guide never mentions the non-loopback opt-in), `limitations.md:157`, `commands-by-task.md:182`, `modules.md:1569` and `cli-reference.md:90,1876`. `cli-reference.md:1890` is itself correct. Fix: "loopback by default" at the three branch-written sites, ideally at the inherited ones too. Re-sweep with `rg -U -i 'loopback[- ]bound\|loopback\s+(HTTP\|listener\|entry)'`. | yes (help) |

## Info (not defects)

- **i1.** `harness.md:143-145` says how to set `auto` (`--auto`, or `/mode`) but not that the flag skips the prompt `/mode auto` shows. This is not false. It is the one page describing `auto` that stays silent on the difference.
- **i2.** In `scripts/check-docs-nav.ts:33`, a literal block with an explicit indentation indicator (`exclude_docs: |2`) is rejected with the message "not a folded one (`>`)". The check fails closed, so this is not a false pass, but the message is misleading. The real config does not use an indicator.
- **i3.** The round-2 info items i1, i2 and i4-i8 are unchanged. Round 2 accepted them as info. The fix resolved i3 (`quickstart.md:282` now says "and you run `keryx update`") and i9 (`connect-a-provider.md:18` names `$XDG_DATA_HOME`).

## Gates (run at `2709073d`)

| gate | result |
|---|---|
| `mkdocs build --strict -d …/site-r3` (scratch venv) | exit 0 |
| `bun scripts/check-docs-nav.ts` | exit 0: 66 files, 65 in nav, 0 orphans |
| `bun scripts/check-doc-links.ts` | exit 0: 2048 links across 573 files, 0 broken |
| `bun scripts/check-retired-cli-spellings.ts` | exit 0: 3552 files, 69 retired spellings, 0 undeclared |
| `bun run typecheck` | exit 0 |
| `bun test` (5 named files) | exit 0: 152 pass, 0 fail, 2954 expects |

## Stage counts

- Raised: 4 (R1, i1, i2, i3). Merged: none. Downgraded: none. Refuted: none.

```json keryx:findings
[
  {"id":"R1","reviewer":"orchestrator","severity":"minor","file":"docs/docs/harness.md","line":19,"problem":"keryx serve described as unconditionally loopback-bound at sites the N3 fix did not enumerate; branch-written at harness.md:19, architecture.md:27, ARCHITECTURE.md:138.","impact":"Readers are told serve cannot bind beyond loopback; it can with --acknowledge-non-loopback (no TLS). ARCHITECTURE.md contradicts its own invariants section.","suggested_fix":"'loopback by default' at each site; re-sweep the class with a multiline search over docs/docs, READMEs and ARCHITECTURE.md.","evidence":"keryx serve --help '[--bind <addr>] [--acknowledge-non-loopback]'; src/lib/serve-server.ts:240-251; git diff origin/main...HEAD shows the three lines written on this branch.","confidence":"high","class_scope":{"sites":["docs/docs/harness.md:19","docs/docs/architecture.md:27","ARCHITECTURE.md:138","docs/docs/guides/drive-keryx-remotely.md:4 (inherited)","docs/docs/limitations.md:157","docs/docs/commands-by-task.md:182 (inherited)","docs/docs/modules.md:1569 (inherited)","docs/docs/cli-reference.md:90,1876 (inherited)"],"enumeration_method":"keryx ctx rg -U -n -i --all 'loopback[- ]only|loopback[- ]bound|loopback\\s+(HTTP|listener|entry)|only\\s+on\\s+loopback|binds?\\s+(only\\s+)?to\\s+loopback' over docs/docs, README.md, README.ru.md, ARCHITECTURE.md, SECURITY.md; origin/main compared per file"}},
  {"id":"i1","reviewer":"orchestrator","severity":"info","file":"docs/docs/harness.md","line":143,"problem":"Says how to set auto (--auto or /mode) but not that the flag skips the /mode auto confirmation.","impact":"None false; completeness only.","suggested_fix":"Optional: one clause as on shell.md:62.","evidence":"src/commands/shell.ts:2154,3358-3359,2835-2849","confidence":"high"},
  {"id":"i2","reviewer":"orchestrator","severity":"info","file":"scripts/check-docs-nav.ts","line":33,"problem":"'exclude_docs: |2' (indentation indicator) is rejected with a 'folded' error message.","impact":"Fails closed; message misleading only.","suggested_fix":"Optional: accept \\|[1-9]?[+-]? or reword the error.","evidence":"probe scratchpad/r3-probe/probe.ts case indentInd","confidence":"high"},
  {"id":"i3","reviewer":"orchestrator","severity":"info","file":"docs/docs/project/status.md","line":40,"problem":"Round-2 info items i1, i2, i4-i8 unchanged (i3, i9 resolved).","impact":"None.","suggested_fix":"None.","evidence":"round-2.md","confidence":"high"}
]
```
