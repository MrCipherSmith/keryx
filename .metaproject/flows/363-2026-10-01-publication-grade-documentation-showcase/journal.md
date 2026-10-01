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
