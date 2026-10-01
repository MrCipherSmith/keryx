# Flow Journal

- 2026-10-01T05:03:43.749Z - flow created
- 2026-10-01T07:22:42.466Z - task-done: T2: Implement per plan
- 2026-10-01T07:22:42.770Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-01T07:22:43.079Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-01T07:22:51.467Z - task-added: T5: Consolidate research into audit-report.md with target IA
- 2026-10-01T07:22:51.767Z - task-added: T6: Owner approves the target IA (gate before public files change)
- 2026-10-01T07:22:52.069Z - task-added: T7: Fix keryx --help and cli-reference drift; subcommand-level coverage test
- 2026-10-01T07:22:52.372Z - task-added: T8: Site restructure: Diataxis nav, landing page, llms.txt, pinned deps, Zensical trial job
- 2026-10-01T07:22:52.674Z - task-added: T9: Area pages batch 1 (areas 1-5)
- 2026-10-01T07:22:52.974Z - task-added: T10: Area pages batch 2 (areas 6-10)
- 2026-10-01T07:22:53.275Z - task-added: T11: Area pages batch 3 (areas 11-15)
- 2026-10-01T07:22:53.576Z - task-added: T12: Getting started tutorial and concept pages (architecture, security model, Metaproject)
- 2026-10-01T07:22:53.874Z - task-added: T13: Built with Keryx and Project status pages
- 2026-10-01T07:22:54.174Z - task-added: T14: Showcase README, README.ru.md, hero/OG assets
- 2026-10-01T07:22:54.475Z - task-added: T15: Meta-files: ARCHITECTURE, SUPPORT, ROADMAP, docs issue template, package.json fields, docs/README map
- 2026-10-01T07:22:54.775Z - task-added: T16: Run README quickstart and tutorial verbatim in a fresh dir; save transcript
- 2026-10-01T07:22:55.076Z - task-added: T17: Strict build, link check, retired spellings, internal-id and external-name scan
- 2026-10-01T07:22:55.380Z - task-added: T18: review-orchestrator round over the final diff
- 2026-10-01T07:22:55.680Z - task-done: T1: Collect remaining context
- 2026-10-01T07:33:07.403Z - frozen: 11 criteria; checksum recorded
- 2026-10-01T07:33:07.700Z - started
- 2026-10-01T07:33:07.993Z - task-attempt: T5: started (attempt 1) — 363-T5 audit report
- 2026-10-01T07:41:06.962Z - task-done: T5: Consolidate research into audit-report.md with target IA

## 2026-10-01 — T6: owner approved the target IA

The owner approved `research/audit-report.md` section 4 (README outline, nav
tree, page list, redirects, assets) in chat ("Ок"), then answered the five
open questions interactively, choosing the recommended option each time:

1. External product names: only in factual compatibility/provider tables and
   install commands; never in comparisons, inspiration credits or evaluative prose.
2. Stability: stable = the nine default modules, `keryx shell`, providers,
   flows, review packages; experimental = Shared Agent Context, review-service
   checks, per-runtime ctx hooks, the one editor adapter flagged experimental;
   opt-in features labelled separately.
3. Logo: simplified SVG mark (brace tile) + dark variant for site logo and
   favicon; the full artwork stays as the README hero.
4. Demo: VHS recording, tape committed (VHS installed via Homebrew).
5. CHANGELOG: not split; a docs page shows 0.3.x highlights and links the file.

Check at approval time: no commit on this branch had changed README.md,
mkdocs.yml or docs/docs/ (`git log origin/main..HEAD -- README.md mkdocs.yml docs/docs` empty).
Local docs toolchain for verification: mkdocs 1.6.1, mkdocs-material 9.7.7,
mkdocs-redirects 1.2.3, mkdocs-llmstxt 0.5.0.
- 2026-10-01T09:23:02.996Z - task-done: T6: Owner approves the target IA (gate before public files change)
- 2026-10-01T09:23:27.492Z - task-attempt: T7: started (attempt 1) — 363-T7 wave 1
- 2026-10-01T09:23:27.784Z - task-attempt: T8: started (attempt 1) — 363-T8 wave 1
- 2026-10-01T09:23:28.074Z - task-attempt: T15: started (attempt 1) — 363-T15 wave 1
- 2026-10-01T09:31:15.515Z - task-attempt: T9: started (attempt 1) — 363-T9 wave 2
- 2026-10-01T09:31:15.822Z - task-attempt: T10: started (attempt 1) — 363-T10 wave 2
- 2026-10-01T09:31:16.131Z - task-attempt: T11: started (attempt 1) — 363-T11 wave 2
- 2026-10-01T09:31:16.444Z - task-attempt: T12: started (attempt 1) — 363-T12 wave 2
- 2026-10-01T09:31:16.761Z - task-attempt: T13: started (attempt 1) — 363-T13 wave 2
- 2026-10-01T09:31:29.708Z - task-done: T15: Meta-files: ARCHITECTURE, SUPPORT, ROADMAP, docs issue template, package.json fields, docs/README map
- 2026-10-01T09:33:03.189Z - task-done: T8: Site restructure: Diataxis nav, landing page, llms.txt, pinned deps, Zensical trial job
- 2026-10-01T09:41:02.047Z - task-done: T10: Area pages batch 2 (areas 6-10)
- 2026-10-01T09:41:40.802Z - task-done: T9: Area pages batch 1 (areas 1-5)
- 2026-10-01T09:45:17.650Z - task-done: T13: Built with Keryx and Project status pages
- 2026-10-01T09:48:09.955Z - task-done: T7: Fix keryx --help and cli-reference drift; subcommand-level coverage test
- 2026-10-01T09:49:58.710Z - task-done: T11: Area pages batch 3 (areas 11-15)

## 2026-10-01 — wave 2 results and follow-ups

Project numbers on `project/status.md` (AC8), measured by T13 against origin/main
at 0b6f4384 on 2026-10-01; each command is also shown on the page:

| number | command | output |
|---|---|---|
| version | `git show origin/main:package.json` (`.version`) | 0.3.49 |
| release tags | `git tag -l 'v*' \| wc -l` | 195 |
| 0.3.x tags / v0.3.0 date | `git tag -l 'v0.3.*' \| wc -l`; `git log -1 --format=%ad --date=short v0.3.0` | 48 / 2026-09-25 |
| first release | `git log -1 --format=%ad --date=short v0.1.0` | 2026-07-10 |
| commits | `git rev-list --count origin/main` | 1696 |
| merged PRs | `git log origin/main --merges --grep '^Merge pull request' --oneline \| wc -l` | 270 |
| flows / done | `keryx flow list`, counted by status | 341 / 305 |
| tasks | sum of `tasks n/N` in `keryx flow list` | 2871 |
| flows with reviews / review rounds | `find .metaproject/flows -mindepth 2 -maxdepth 2 -type d -name reviews`; `-mindepth 3 -maxdepth 3 -path '*/reviews/*'` | 122 / 279 |
| src non-test .ts files / lines | `git ls-tree -r --name-only origin/main -- src`, filtered; `wc -l` over the export | 1114 / 371926 |
| test files / src test lines | `git ls-tree` filtered on `.test.ts`; `wc -l` | 1363 / 380694 |
| wiki pages | `keryx wiki status` | 97 |
| bundled skills / stack skills / stack dirs | `find src/gdskills/bundled/skills -name SKILL.md`; same under stacks | 78 / 92 / 23 |
| rules / memory entries | `find .metaproject/rules -type f`; memory md excluding index/templates | 41 / 20 |
| CI jobs | jobs in `.github/workflows/ci.yml` | 10 |

T17 re-runs these after rebasing onto main and updates the page if they moved.

Built-with-Keryx links: the hygiene re-scan dropped flows 300, 313, 312, 256
(home paths / noreply id), 257 (external credit) and 361 (consumer repo name);
only flow 225 is linked, clean once PR #819 merges. PR #819 now also replaces
every absolute owner home path; a stacked names-neutralization PR follows
(owner decision 2026-10-01: neutralize all external and consumer names, keep
legally required MIT notices in THIRD_PARTY_NOTICES.md). After both merge, T17
re-scans flows 300/313/312/256/257/361 and may restore links.

Stability alignment: `src/integrations/registry.ts` marks 7 adapters
experimental; status.md follows the code; ROADMAP.md says "one editor adapter"
— fix in T17.

Follow-ups outside this flow (defects found while verifying docs):
- `keryx ctx install-hook --dry-run` ignores --dry-run (task chip filed).
- `keryx providers test ollama` answers "Unknown provider".
- `keryx shell` / `harness run` on the fake provider cannot run a turn from the CLI ("no transcript matches request hash").
- `agents external enable` right after `init` needs `keryx update` first (missing manifest entry).
- `bundle import --target-scope user` refuses a project-skills bundle (kind-path-mismatch).
- Stale comment in src/commands/agent-hooks.ts (~278): impact-evidence is on by default in advisory mode.

Open for T17: two tests in src/cli-reference-coverage.test.ts compare the old
docs index with the nav; retired spellings at modules/integrations.md:63 and
modules/mcp-servers.md:73; SLATE-* ids in guides/goal.md and guides/slate.md;
flow-id collision (main has its own 363 — renumber at merge); rebase onto main (0.3.49).
- 2026-10-01T09:56:24.790Z - task-done: T12: Getting started tutorial and concept pages (architecture, security model, Metaproject)
- 2026-10-01T09:56:32.907Z - task-added: T19: Cross-lane fixups: redirects, inbound links to retired pages, retired spellings, leftover ids, stale comments, stability wording, index tests
- 2026-10-01T09:56:33.228Z - task-attempt: T14: started (attempt 1) — 363-T14
- 2026-10-01T09:56:33.527Z - task-attempt: T19: started (attempt 1) — 363-T19
- 2026-10-01T10:10:23.705Z - task-done: T14: Showcase README, README.ru.md, hero/OG assets
- 2026-10-01T10:10:56.819Z - task-done: T19: Cross-lane fixups: redirects, inbound links to retired pages, retired spellings, leftover ids, stale comments, stability wording, index tests
- 2026-10-01T10:14:38.603Z - renumbered: 363 -> 367: id 363 was taken on main by the rules-export flow while this branch was open; 367 is the first id free on every remote branch
- 2026-10-01T10:14:50.389Z - task-attempt: T16: started (attempt 1) — 367-T16 verification after rebase onto main
- 2026-10-01T10:14:50.696Z - task-attempt: T17: started (attempt 1) — 367-T17 verification after rebase onto main
- 2026-10-01T10:27:53.307Z - task-done: T16: Run README quickstart and tutorial verbatim in a fresh dir; save transcript
- 2026-10-01T10:27:53.610Z - task-added: T20: Verification fixes: flow check-complete in cli-reference, README structure test, leftover W/flow ids, getting-started reference links, install above the fold, doctor output trim mark
- 2026-10-01T10:28:11.518Z - task-depends-set: T17: dependsOn T16, T20 (was T14, T15) — verification re-runs after the T20 fixes
- 2026-10-01T10:28:11.826Z - task-attempt: T20: started (attempt 1) — 367-T20
- 2026-10-01T10:30:21.825Z - task-done: T20: Verification fixes: flow check-complete in cli-reference, README structure test, leftover W/flow ids, getting-started reference links, install above the fold, doctor output trim mark
- 2026-10-01T10:31:20.495Z - task-done: T17: Strict build, link check, retired spellings, internal-id and external-name scan
- 2026-10-01T10:31:24.690Z - task-attempt: T18: started (attempt 1) — 367-T18 review round 1
- 2026-10-01T10:45:38.325Z - task-attempt: T18: failed (attempt 2) — round 1: 0 blocker, 3 major, 19 minor, 8 info
- 2026-10-01T10:45:38.653Z - task-added: T21: Review round 1 fixes: overstated security claims, stale versions, leftover ids, nav-check negation, doc inaccuracies
- 2026-10-01T10:45:43.739Z - task-depends-set: T18: dependsOn T17, T21 (was T16, T17) — review round 2 runs after the round-1 fixes
- 2026-10-01T10:47:12.485Z - task-attempt: T21: started (attempt 1) — 367-T21 round-1 fixes
- 2026-10-01T10:54:53.836Z - task-done: T21: Review round 1 fixes: overstated security claims, stale versions, leftover ids, nav-check negation, doc inaccuracies

## 2026-10-01 — AC10 search record (after T21)

Command, run at the T21 commit over README.md, README.ru.md, docs/docs/**,
ARCHITECTURE.md, SUPPORT.md, ROADMAP.md, CONTRIBUTING.md, SECURITY.md:

`git grep -n -I -i -E 'flow [0-9]{2,3}\b|\bW[0-9]+\b|R[0-9]+-F|SLATE-[0-9]|\bD-[0-9]|/Users/|/home/[a-z]|tsaitler|altsay|@gmail|competitor|inspired by'`
excluding the `W3-self-learning` link target, the `--flow 12` example id and
the `/home/you` placeholder → 0 hits.

`git grep -c -E '\bAC[0-9]+\b'` over the same READMEs and docs/docs excluding
cli-reference.md and modules/managed-work.md (where `ACn` is the flow
feature's own vocabulary) → 0 files.

No comparison page exists (nav and file list checked by T17). External
product names remain only in compatibility/provider tables, install commands,
env-var and file names (owner decision 1).

Merge of origin/main 0.3.51 into the branch (5b578c81) instead of a second
rebase: replaying the branch onto main re-raised already-resolved conflicts.
- 2026-10-01T10:55:13.771Z - task-attempt: T18: started (attempt 3) — 367-T18 review round 2
- 2026-10-01T11:05:00.222Z - task-attempt: T18: failed (attempt 4) — round 2: 0 blocker, 1 major, 6 minor, 9 info (round 1 was 3/19)
- 2026-10-01T11:05:00.525Z - task-added: T22: Review round 2 fixes: harness.md default policy, nav-check escape and folded blocks, serve loopback wording, MCP import, provider loopback, rules zone, consistent figures
- 2026-10-01T11:05:22.871Z - task-depends-set: T18: dependsOn T17, T22 (was T17, T21) — review round 3 checks the round-2 fixes
- 2026-10-01T11:05:23.180Z - task-attempt: T22: started (attempt 1) — 367-T22
- 2026-10-01T11:09:12.308Z - task-done: T22: Review round 2 fixes: harness.md default policy, nav-check escape and folded blocks, serve loopback wording, MCP import, provider loopback, rules zone, consistent figures
- 2026-10-01T11:09:12.828Z - task-attempt: T18: started (attempt 5) — 367-T18 review round 3 (fix verification)
- 2026-10-01T11:14:49.502Z - task-attempt: T18: failed (attempt 6) — round 3: 0 blocker, 0 major, 1 minor (R1 serve loopback wording at 9 more sites), 3 info
- 2026-10-01T11:14:49.925Z - task-added: T23: Round 3 fix: serve described as loopback by default at every site, verified by a deterministic sweep

## 2026-10-01 — attempt budget reached on T18: strategy change

Three review rounds have run (round 1: 3 major / 19 minor; round 2: 1 major /
6 minor; round 3: 0 major / 1 minor). `attempts.count` on T18 reads 6 because
each round records a `started` and a `failed` entry; the rounds are three, and
the bound is reached. Findings converge and do not repeat across rounds
(`keryx review loop` cannot observe repetition: the packages are lightweight
markdown, not ingested). The single remaining minor (R1) is a wording class —
`keryx serve` described as loopback-bound without "by default" — so a fourth
full review round is not the right instrument. Changed strategy: T23 fixes every
site, and the acceptance evidence is a deterministic multiline sweep over all
user-facing docs for "loopback" sentences about `serve` that lack "by default",
recorded here with its command and result, plus the existing gates. No fourth
model review round.
- 2026-10-01T11:15:04.921Z - task-attempt: T23: started (attempt 1) — 367-T23
- 2026-10-01T11:17:37.276Z - task-done: T23: Round 3 fix: serve described as loopback by default at every site, verified by a deterministic sweep

## 2026-10-01 — R1 closed by deterministic sweep (commit cf7789d1)

`rg -U -i -n --pcre2 "serve[^.]{0,200}loopback[- ]\s*(bound|only)|loopback[- ]\s*(bound|only)[^.]{0,200}serve|loopback\s+HTTP|loopback\s+remote" README.md README.ru.md ARCHITECTURE.md SECURITY.md docs/docs src/standard/help-groups.ts`
→ 2 hits, ARCHITECTURE.md:72 and :129, both about `serve-mcp` (the MCP
publisher over stdio or loopback HTTP), not `keryx serve`. 11 sites rewritten to
"loopback by default" (incl. the `serve` help summary in src/cli-registry.ts and
help-groups.ts, regenerated commands-by-task.md, and its pinned help fixture).
Gates at cf7789d1: mkdocs --strict OK, check-doc-links 0/2048 broken, retired
spellings 0 undeclared, typecheck clean, help/reference/README tests 141/141.
Review loop result: round 3 left 0 blocker / 0 major / 1 minor (R1) → R1 fixed
and verified above; info items remain as recorded in reviews/round-3.md.
- 2026-10-01T11:17:50.206Z - task-done: T18: review-orchestrator round over the final diff
