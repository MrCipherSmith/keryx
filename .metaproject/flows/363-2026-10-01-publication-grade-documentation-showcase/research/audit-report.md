# Audit report and target information architecture

Flow 363, task T5. Written 2026-10-01 on branch `docs/publication-grade-docs`
(package 0.3.46). Consolidates `inventory.md`, `code-truth.md`,
`best-practices.md` and `metaproject-state.md`, plus a fresh drift audit of the
README, entry docs, concept pages and guides (section 2.3). This is the document
the owner approves at T6 before any public file changes. Nothing marked
UNCONFIRMED was verified.

---

## 1. Executive summary

- **README is a manual, not a landing page.** 1076 lines, about 8,600 words of
  prose against a 1,000-word target; the first-run story is buried under
  harness, review-service, remote-entry and CI detail.
- **The site is organised by source tree, not by task.** 37 pages, a flat
  21-item Guides list, then 12 flat top-level pages; no tutorial, no landing
  page, one orphan (`jev-in-review.md`).
- **The help text and the docs disagree with the code where newcomers look
  first.** `keryx <group> --help` shows a fraction of the real subcommands
  (`gdgraph --help` 3 of 11, `ctx --help` 1 of 9), and the docs tell readers to
  trust it. `keryx auth login` is documented as taking an API key and does not.
- **About 80 itemised drift items** (17 wrong, 40 stale, 20 missing) plus about
  40 flag-level items; the worst are concentrated in `cli-reference.md`,
  `modules.md`, `architecture.md` and the install pages.
- **Internal identifiers leak into user docs**: 85 "flow NNN" and 34 ACn in
  `cli-reference.md`, 30 more across 8 other pages, and in `review --help`.
- **Launch basics are missing**: no demo, no OG image, a 1.36 MB raster logo, no
  ARCHITECTURE/SUPPORT/ROADMAP, no `llms.txt`, unpinned docs tooling.
- **What works**: 0 broken links across 1,757, 0 undeclared retired spellings,
  a generated commands-by-task page with a drift test, and a committed
  engineering record (341 flows, 2,867 tasks) worth showing.
- **Ask of the owner**: approve section 4 (README outline, nav, page list,
  redirects, assets) and answer the five questions in section 5.

---

## 2. Inventory and drift

### 2.1 Inventory summary

| Area | Files | Lines | Audience | State |
|---|---|---|---|---|
| `README.md` | 1 | 1,076 | newcomer | too long; good screenshots and real-repo example |
| Root meta-files | CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, LICENSE, CHANGELOG (7,501 lines) | — | all | ARCHITECTURE, SUPPORT, ROADMAP, README.ru missing |
| Published site `docs/docs/` | 37 (16 pages + 21 guides) | ~18.7k | user / integrator | flat nav; 1 orphan; `README.md` excluded duplicate of `index.md` |
| — largest pages | `cli-reference.md` 6,646; `modules.md` 1,621; `complete-setup…` 1,140; `hooks.md` 798 | | | hand-written; drift below verb level |
| Generated docs | `commands-by-task.md` | 186 | user | generated + drift test (good) |
| Internal records under `docs/` | ~663 (requirements 603, decisions 28, analysis 9, plans 6, report 7, reviews 3, verification 6, skills 1) | ~83k | contributor / history | not published; no map tells a visitor they are internal |
| Assets | 5 PNGs (3.9 MB), 1 SVG (VS Code icon, different mark) | | | no demo, no OG image, no favicon |
| Site tooling | Material for MkDocs, no plugins, `--strict` in CI, Pages deploy | | | `pip install mkdocs-material` unpinned |
| `package.json` | | | npm page | no `homepage`, `bugs`; description differs from README and site tagline |

Duplicated topics (each told in 3-6 places): install/first run, CLI command
lists, the harness, review-service (Jev) material, remote entry, CI/PR bot,
limitations, integrations, external agents, permission modes, Shared Agent
Context. The target IA gives each one home (section 4c).

### 2.2 Consolidated drift list (from research, de-duplicated)

Severity: **W** wrong (a reader acting on it fails), **S** stale, **M** missing.
Priority: **P0** newcomer acts on it (install, first run, commands, providers);
**P1** reference/help; **P2** concept pages. Owning Stage-B task in brackets.

#### P0 — install, first run, provider setup

| ID | Doc path:line | Claim | Code evidence | Sev |
|---|---|---|---|---|
| D01 | onboarding.md:79 | `bunx keryx` runs the bundle | unscoped `keryx` on npm is another package; ours is scoped (`package.json:2`) | W [T12] |
| D02 | README.md:98; onboarding.md:431-432 | `keryx auth login <provider>` does "subscription login … or API key" | login accepts only subscription-OAuth providers and refuses the rest (`src/commands/auth.ts:13-14,79-80`); API keys go through the provider picker / env vars | W [T9] |
| D03 | onboarding.md:68-71 | `keryx auth` saves an API key to an owner-only file | `auth` has only `list login logout status` (`auth.ts:6-43`); no key-saving path. Where `/provider` stores keys: UNCONFIRMED | W [T9] |
| D04 | README.md:147,1062; onboarding.md:398 | "run `keryx <command> --help` for the live flag surface" | for `gdgraph`, `test`, `init`, `ctx`, `orient`, `security` the group help prints only its `USAGE_BODY` slice: `gdgraph --help` 3 of 11 subcommands, `test --help` 3 of 10, `ctx --help` 1 of 9, `init --help` omits `--no-tasks --no-security --mcp --sac --treesitter --testing-tia --external-agents` that `init.ts:1372-1390` accepts | W [T7] |
| D05 | README.md:89-92,353-356; onboarding.md:415-417; harness.md:27-30 | built-in providers = one native vendor, local runtime, gateways | native `openai`, `gemini`, `openai-codex` and compat `github-copilot`, `rapid-mlx` missing (`make-provider.ts`, `OPENAI_COMPAT_PROVIDERS`) | S [T9] |
| D06 | README.md:970 vs README.md:536-537 | external-CLI write mode needs ≥0.159.0 / "live-verified on 0.159.0" | `dispatch.ts:101` requires ≥0.159.2 and refuses ≥0.160.0; README contradicts itself | W [T14] |
| D07 | agent-installation-playbook.md:203,286 | `ctx install-hook --runtime zcode\|generic-mcp` | rejected; `src/ctx/runtimes.ts` lists 9 runtimes + `all` | W [T12] |
| D08 | onboarding.md:574; playbook:203,285 | `integrate all` = two editors; integrate supports two editors | `all` = three; five targets valid (`integrate --help`, `integrate.ts:157`) | S [T10] |
| D09 | onboarding.md:548 | `update` self-refreshes the runtime from origin/main | only managed/project clones; npm and binary installs skip it (`update.ts:1596-1604`) | S [T9] |
| D10 | onboarding.md:199-246; README Quick start | curl installers presented beside npm | they clone git `main`, not the release (`scripts/install.sh:5,126`); no "tracks main" note | S [T9] |
| D11 | complete-setup…:107-110 | `KERYX_REF="v0.1.0"` pin example | ancient tag; binary pin `KERYX_RELEASE_TAG` not mentioned | S [T9] |
| D12 | README, onboarding, playbook, complete-setup | (no mention) | `keryx doctor` and `keryx setup` exist (`cli-registry.ts:120-122`) and are the natural first-run checks | M [T9] |
| D13 | README.md:969 vs limitations.md:17,49 | "four of five" vs "five" model commands exit non-zero without a credential | the docs contradict each other; which is right UNCONFIRMED | S [T12] |
| D14 | docs/docs/README.md:14-15 | `bun install -g github:<repo>` works | `bin` points at built `dist/`; UNCONFIRMED | — [T8] |

#### P1 — help text and reference

| ID | Doc path:line | Claim | Code evidence | Sev |
|---|---|---|---|---|
| D20 | `src/cli-registry.ts:253` (`keryx --help`) + cli-reference.md:1065-1068 | `harness run --provider <fake\|…\|…>` (3 values) | `harness.ts:83-91` also accepts openai, gemini, rapid-mlx, github-copilot | W [T7] |
| D21 | `cli-registry.ts:308-385` (flat help) | `ctx`, `wiki`, `skills`, `test`, `memory`, `flow`, `bus`, `routing`, `trigger`, `agents`, `review`, `security` list a subset | real vocabulary in `group-subcommands.ts:42-271` (e.g. `review` 31, `flow` 22, `wiki` 15) | M [T7] |
| D22 | `cli-registry.ts` USAGE_BODY | no line for consumer `keryx mcp list/add/trust/auth/doctor` | `mcp-servers.ts:62-73` | M [T7] |
| D23 | cli-reference.md:6192 | `integrate` writes `args: ["mcp","serve",…]` | `src/mcp/client-config.ts:33-34` writes `["serve-mcp"]` | W [T7] |
| D24 | cli-reference.md:115,1244,6461; :103; :6170-6193 | `mcp serve` / `mcp install` current; `mcp` = publisher | retired (`cli-registry.ts:156-160`); `mcp` is the consumer client | S [T7] |
| D25 | cli-reference.md:3386,3420; complete-setup…:669 | task kinds without `verify` | `flow --help` lists `verify` | W [T7] |
| D26 | cli-reference.md:66-105 | top-level table | 18 verbs absent (setup, providers, routing, external, auth, approvals, trigger, schedule, governance, hooks, bundle, learn, sandbox, serve-mcp, integrate, integrations, retention, forgetting) | M [T7] |
| D27 | cli-reference.md:247-265 | `shell` flags | `-p/--print --events-file --events-max-field --permission-mode --deny-tools --ask/--trust/--auto` missing | M [T7] |
| D28 | cli-reference.md (various) | flag lists | missing: `agents show --json` (:4150), `security scan --recursive/--exclude/--max-*` (:6010), `check-input/output --runtime` (:6018), `init --sac --external-agents` (:1242), `flow init --require-confirmation` (:3379), `providers remove --json` (:1422), `standard baseline` (:4003), `trigger run --schedule`, `resolve` (:1985) | S/M [T7] |
| D29 | cli-reference.md:100; modules.md:1317-1340; architecture.md:116 | `agents` = bootstrap only | also monitor, external, catalog | S [T7] |
| D30 | cli-reference.md (no literal) | `modules status/list/…`, `projects …`, `ctx hook`, `review stack`, `sessions fork/export/path`, `skills generate` | `group-subcommands.ts`; may be documented in bracketed form, UNCONFIRMED per item | M [T7] |
| D31 | commands-by-task.md:58,146 | `agents`, `sessions` one-liners | source table `src/standard/help-groups.ts` stale; `skill-verify-skill`, `session` absent (by design? UNCONFIRMED) | S [T7] |
| D32 | cli-reference.md:4184,4191 | `orient uninstall-hook` | no handler found | UNCONFIRMED [T7] |
| D33 | cli-reference.md:3119 | "65 SKILL.md files" | count not verified | UNCONFIRMED [T7] |
| D34 | `update --help` | `[--skip-runtime] [--hooks]` | handler also accepts `--no-tasks` (`update.ts`), documented in onboarding.md:552 | M [T7] |
| D35 | `keryx review --help` output | contains "Flow 326: …" | internal id in shipped help text | S [T7] |
| D36 | cli-reference.md (85 "flow NNN", 34 ACn); hooks.md (21 W#/R#); 30 more "flow NNN" in modules 5, integrations 3, onboarding 1 (:440), limitations 2 (:13,:109), guides/agent-catalog 5, write-a-rubric-scenario 10, review-with-a-record 2, jev-in-the-delivery-loop 2 | internal ids | violate AC10 | S [T7, T9-T12] |

#### P2 — concept pages and site meta (from code-truth §3.5, inventory §3-4)

| ID | Doc path:line | Claim | Code evidence | Sev |
|---|---|---|---|---|
| D40 | modules.md:58,1087-1099; architecture.md:134,212 | `mcp serve` / `mcp install` / verb `mcp` are the MCP publisher surface | `serve-mcp` and `integrate` (`cli-registry.ts:156-160`) | W [T11] |
| D41 | architecture.md:78,96; modules.md:44 | `CLI_ROUTES` at `src/cli.ts:51`, about 31 (or 16) verbs | `src/cli-registry.ts:109-182`, about 62 verbs | W [T12] |
| D42 | architecture.md:666 | "no `src/ctx/` dir" | exists; same page cites it at :118, :129 | W [T12] |
| D43 | architecture.md:667 | external runtime "verified offline only" | harness.md:430-436 records live runs; transcripts in `fixtures/external/live/` | W [T12] |
| D44 | integrations.md:228-232 | the shell adapter is a placeholder, all surfaces unsupported | `integrations matrix` shows it verified with 8 surfaces | W [T11] |
| D45 | architecture.md:3 | reviewed for 0.2.157 | 0.3.46 | S [T12] |
| D46 | integrations.md:12-15,50-61,158-226 | `integrate` = "MCP client configuration"; `--runtime` single id; per-harness notes | `integrate` registers keryx as a server; `--runtime` takes lists/`all`; per-surface notes stale (one adapter experimental) | S [T11] |
| D47 | architecture.md:132,139 | `assets` is a top-level verb; slash inspectors are two | `assets` is a subcommand of `gdgraph`/`memory`; about 60 slash commands | S [T12] |
| D48 | modules.md:44-61,1475 | top-level table of about 16 verbs; shell flags | 40+ verbs and 12 flags missing | S [T11] |
| D49 | all 7 concept pages | — | no coverage of bus, retention/forgetting, auth/providers/routing/external, ACP server, MCP consumer, rewind, metrics, sandbox, bundle, stack, doctor, setup, version | M [T9-T12] |
| D50 | mkdocs.yml:70-110; index.md:10-24 | nav/contents | omit `jev-in-review.md` (orphan, published, unreachable) | S [T8] |
| D51 | mkdocs.yml:11-15 | "the eight pages a reader needs"; "a page missing from the nav fails strict" | nav has 34 pages; the orphan proves strict does not fail | S [T8] |
| D52 | README.md:742 | "Nine modules on after init; `mcp` is opt-in" | `sac` is opt-in too (`modules.ts:57,64`) | S [T14] |
| D53 | README.md:805-806 | MCP OAuth is "next" | `keryx mcp auth`/`logout` ship (`mcp.ts:149-150`) | S [T14] |
| D54 | README.md:1028; docs/examples/review-bot.yml:25; review-as-a-pr-bot.md:49 | action pinned to `@main` | the same guide (:67) says pin a release tag; examples should show a tag | S [T10] |
| D55 | README.md:56-58; onboarding.md:158-160 | link to the unrelated npm package's repository | names an external project (AC10); keep the warning, drop the link | S [T14] |
| D56 | onboarding.md:271 | `bun run check` = typecheck + test | `package.json:54`: lint + typecheck + typecheck:scripts + test | S [T15] |
| D57 | docs/README.md:49 | "Repository documentation is English-only" | contradicts the `README.ru.md` decision | S [T15] |
| D58 | package.json | description / homepage / bugs | description differs from README and `site_description`; `homepage`, `bugs` absent | M [T15] |
| D59 | provider labels | compat providers report `providerId: "ollama"` in `describe()` | `make-provider.ts` header; where surfaced UNCONFIRMED | S [T9] |

### 2.3 New audit: concept pages and guides (this task)

This task audited the newcomer-facing pages in full: README, onboarding,
limitations, the install playbook and complete-setup. Those findings are in 2.2
(D02-D04, D34-D36, D52-D57, all new). The concept pages (architecture,
harness, integrations, hooks, modules, learning, workspace-and-lifecycle) and
the 21 guides are covered by the code-truth §3.5 items (D40-D49). A
flag-by-flag pass over the code blocks in those pages had not finished when
this report was written. It is UNCONFIRMED, and it is carried into T9-T12: each
rewrite runs its commands against `--help` before T17 verification.

Verified correct during this audit (no action): `keryx --version` prints
0.3.46; nine modules default on (`modules.ts:44-52`); `init --mcp`,
`--treesitter`, `--testing-tia` accepted; `test run --strict`,
`health run --strict`, `test coverage-map build`, `gdgraph symbols enable`
handlers exist; `orient install-hook --runtime` accepts `claude, codex, cursor,
all`, as complete-setup says; doc links 0 broken; retired spellings 0
undeclared.

### 2.4 Drift totals and owners

| Category | Count |
|---|---|
| Wrong | about 19 |
| Stale | about 45 |
| Missing | about 22 |
| Not itemised (flag-level, mostly cli-reference/modules/guides) | about 40 |
| Internal-id occurrences in user docs | about 150 + CHANGELOG 66 |

All P0 items are fixed in the pages that replace them (T9, T12, T14); P1 by T7
(help text regenerated from `group-subcommands.ts`, reference fixed, coverage
test raised to subcommand level); P2 by T11/T12 rewrites. Anything left is
recorded in `journal.md` with a reason (AC6).

---

## 3. Best-practice gap table (launch checklist, best-practices.md §7)

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | README above fold: logo, value prop, ≤6 badges, language switcher, nav links | partial | logo (1.36 MB), tagline, 3 badges; no switcher, no nav row |
| 2 | Demo under 40 s on GitHub and docs landing | missing | 4 static screenshots only |
| 3 | Install one-liner tested on macOS/Linux; Windows declared | partial | one-liner exists; Windows "not verified"; no recorded run |
| 4 | Quickstart executed verbatim, real output | missing | no transcript (AC7 adds it) |
| 5 | README ≤ ~1000 words; one line per module + link | missing | ~8,600 prose words |
| 6 | Docs landing: hero, demo, module cards, pick your path | missing | `index.md` is a link list |
| 7 | Nav Getting started / Guides / Modules / Concepts / Reference / Project | missing | flat nav (`mkdocs.yml:70-110`) |
| 8 | One page per module | partial | single 1,621-line `modules.md` |
| 9 | All four Diátaxis types | partial | how-to, reference, explanation exist; no tutorial |
| 10 | CLI reference generated, CI drift check | partial | hand-written; verb-level coverage test only (decision: keep hand-written, raise test to subcommand level) |
| 11 | Config and env var reference | missing | no page; about 90 `KERYX_*` names in `src/` (not all env vars, UNCONFIRMED) |
| 12 | Provider matrix and local-model how-to | partial | provider lists incomplete (D05); no local-model page |
| 13 | Security model page; SECURITY.md private reporting | partial | SECURITY.md uses private advisories; model spread over 4 pages |
| 14 | CONTRIBUTING, CoC, LICENSE, issue/PR templates | have | docs issue template missing (AC9) |
| 15 | ARCHITECTURE.md with codemap, linked from README | missing | `architecture.md` on site only, with wrong codemap (D41) |
| 16 | CHANGELOG in Keep a Changelog; docs shows recent only | partial | format followed; 7,501 lines; 66 internal ids; not on site |
| 17 | ROADMAP and stability statement | partial | "pre-1.0" + "Format stability" in limitations; no roadmap |
| 18 | FAQ and troubleshooting | partial | troubleshooting in complete-setup §14; no FAQ |
| 19 | Comparison page | n/a | owner decision: none |
| 20 | README.ru.md synced and linked | missing | — |
| 21 | llms.txt with `.md` copies; AGENTS.md accurate | partial | `.metaproject/llms.txt` exists, not on site; AGENTS.md is agent routing (accuracy UNCONFIRMED) |
| 22 | Social card / OG image | missing | — |
| 23 | Strict build and link checker green | partial | 0 broken links; strict build passes in CI per workflow (not run locally, UNCONFIRMED) but lets the orphan through |
| 24 | Docs tool versions pinned; Zensical trial job | missing | `pip install mkdocs-material` unpinned (`docs.yml:28,56`) |
| 25 | Docs on Pages; README links to live site | partial | site live; README links are repo-relative GitHub paths |

Score: have 1, partial 13, missing 10, n/a 1.

---

## 4. Target information architecture

Principle: **existing pages keep their paths** (inbound links, the coverage test
on `cli-reference.md`, and the generated `commands-by-task.md` depend on them);
the nav regroups them. New pages go in new directories. Only two pages are
split, so only two redirects are needed.

### 4a. README outline (target ≤1,000 prose words)

| # | Section | Words | Content |
|---|---|---|---|
| 1 | Header | 30 | `<picture>` logo (light/dark), name, one-line value prop (one tagline shared with `package.json` and `site_description`), 5 badges (CI, npm, license, docs, Bun ≥1.3.14), `English \| Русский`, nav row: Docs · Quickstart · Modules · Changelog |
| 2 | Demo | 10 | recording or hero screenshot (4f) |
| 3 | What is Keryx | 120 | 3 sentences + 5 bullets: Metaproject context in the repo; the shell/harness; managed flows with frozen criteria; review with a record; works with your existing agents |
| 4 | Install | 50 | npm one-liner; one line each for binary and other paths → `getting-started/install.md`; Bun note |
| 5 | Quickstart | 90 | `keryx init --yes` → `keryx doctor` → `keryx gdgraph build` → `keryx gdgraph affected <file>` → `keryx shell`; real output excerpt (the public-repo example) |
| 6 | What you get | 200 | 8-row table (need → capability → docs page), one row per Modules page |
| 7 | How it works | 80 | one small diagram (repo → `.metaproject/` → agents/shell), link ARCHITECTURE.md |
| 8 | Where to go next | 100 | 8-row intent table → site pages |
| 9 | Status | 60 | version, macOS/Linux, Windows unverified, pre-1.0, link Project status and Limitations |
| 10 | Built with Keryx | 50 | one paragraph + link to the page |
| 11 | Community, contributing, security, license | 40 | four links |
| | Total | ~830 | leaves ~170 words headroom |

Where existing README content goes:

| README lines | Content | Destination |
|---|---|---|
| 1-39 | hero, three intro paragraphs | README §1, §3 (condensed); full text → `index.md` hero and `concepts/metaproject.md` |
| 41-85 | install, scoped-package note, init explanation | README §4-5; detail → `getting-started/install.md`, `getting-started/quickstart.md` |
| 86-120 | connect a provider, codex discovery, routing | `guides/connect-a-provider.md`; routing → `modules/providers.md` |
| 121-153 | first session, where to go next | `getting-started/quickstart.md`; README §8 |
| 154-184 | Why keryx, What you get | README §3, §6; full → `index.md` |
| 185-256 | typical workflow, real-repo output, what lands in the repo, dashboard | README §5 (short); full → `modules/project-knowledge.md`, `concepts/metaproject.md` |
| 257-276 | harness intro + launch commands | `modules/shell.md` |
| 277-301 | Finding a command | `reference/index.md` |
| 302-335 | Turn budgets, Version advisory | `harness.md` (budgets); `getting-started/install.md` (upgrade/advisory) |
| 337-559 | screenshots + 17 harness bullets | screenshots → `modules/shell.md`; bullets split to `modules/shell.md`, `modules/providers.md`, `modules/harness-and-safety.md`, `modules/delegation.md`, `harness.md` |
| 564-742 | Core capabilities (graph … slate, harness, sandbox, remote) | one row each in README §6; detail → matching Modules page |
| 744-807 | Agent integrations; other MCP servers | `modules/integrations.md`; `modules/mcp-servers.md` |
| 808-820 | Requirements and compatibility | README §9 (3 lines); table → `getting-started/install.md` |
| 821-859 | Optional AI features, model tiers | `modules/providers.md` (tiers); command list → `limitations.md` |
| 860-916 | /external | `guides/keep-private-work-in-house.md` |
| 917-960 | edit guard | `guides/jev-in-the-delivery-loop.md` (merge) |
| 961-980 | Current limitations | README §9 link; table → `limitations.md` (de-duplicated) |
| 981-1002 | Remote entry | `guides/drive-keryx-remotely.md` (already covers it) |
| 1003-1044 | CI, review bot | `guides/run-in-ci.md`, `guides/review-as-a-pr-bot.md` |
| 1045-1063 | Documentation list | README §8 |
| 1064-1076 | Local development, license | CONTRIBUTING.md; README §11 |

`README.ru.md` mirrors sections 1-11 with `<!-- synced-with: README.md @ <sha> -->`.

### 4b. mkdocs nav tree

Status key: **NEW**, **KEPT** (path and content, small fixes), **REWRITTEN**
(same path, content redone), **MERGED** (new page built from the listed
sources), **RETIRED** (file removed, redirect added). Paths are under
`docs/docs/`.

```
Home                                   index.md                                REWRITTEN (landing, 4d)
Getting started
  Install                              getting-started/install.md              MERGED (onboarding §Requirements/Bun/Install, complete-setup §1-3, README 41-85, 808-820)
  Quickstart (tutorial)                getting-started/quickstart.md           MERGED (onboarding §First-run walkthrough, README 121-153)
  Keryx in five minutes                getting-started/concepts.md             NEW
  Troubleshooting                      getting-started/troubleshooting.md      MERGED (complete-setup §14, onboarding env-isolation errors)
Guides
  Set up
    Set up a project end to end        guides/set-up-a-project.md              MERGED (complete-setup §4-10, §12)
    Connect a model provider           guides/connect-a-provider.md            NEW (README 86-120, onboarding §Connect a provider)
    Use a local model                  guides/use-a-local-model.md             NEW
    Give an agent context              guides/give-an-agent-context.md         KEPT
    Agent installation playbook        agent-installation-playbook.md          REWRITTEN (D07, D08; runtime matrix)
    Copy-ready agent prompts           guides/agent-prompts.md                 MERGED (complete-setup §13)
  Work in the shell
    Choose an approval mode            guides/permission-modes.md              KEPT
    Undo a turn with /rewind           guides/rewind.md                        KEPT
    /goal                              guides/goal.md                          KEPT
    Agent web search                   guides/web-search.md                    KEPT
    Use local SearXNG                  guides/use-local-searxng.md             KEPT
    Keep private work in-house         guides/keep-private-work-in-house.md    NEW (README 860-916)
  Agents and delegation
    Run an agent without your machine  guides/contain-an-agent.md              KEPT
    Name a subagent                    guides/agent-catalog.md                 KEPT (strip ids)
    Drive a foreign ACP agent          guides/acp-client.md                    KEPT
    Let an external agent write        guides/external-agent-write.md          KEPT (retitle: both write-capable CLIs)
    Slate for external agents          guides/slate.md                         KEPT
    Shared Agent Context (experimental) guides/shared-agent-context.md         KEPT
  Review and quality
    Review with a durable record       guides/review-with-a-record.md          KEPT (strip ids)
    Review as a pull request bot       guides/review-as-a-pr-bot.md            KEPT (D54 tag pin)
    Review service in the delivery loop guides/jev-in-the-delivery-loop.md     REWRITTEN (absorbs README 917-960; strip ids)
    Write a rubric eval scenario       guides/write-a-rubric-scenario.md       KEPT (strip 10 ids)
    Keep the wiki current              guides/keep-the-wiki-current.md         KEPT
  Automation and remote
    Run keryx in CI                    guides/run-in-ci.md                     KEPT
    Drive keryx from a bot             guides/drive-keryx-remotely.md          KEPT
    Answer a remote approval           guides/answer-remote-approvals.md       KEPT
    Move skills, rules, memory         guides/portability.md                   KEPT
Modules (areas 2-14; each: what, why, runnable example, reference link)
  Project knowledge                    modules/project-knowledge.md            NEW
  The keryx shell                      modules/shell.md                        NEW
  Models and providers                 modules/providers.md                    NEW
  Harness and safety                   modules/harness-and-safety.md           NEW
  Connect your agents                  modules/integrations.md                 NEW
  MCP servers in the shell             modules/mcp-servers.md                  NEW
  Delegation                           modules/delegation.md                   NEW
  Managed work: flows, jobs, review    modules/managed-work.md                 NEW
  Quality: health and testing          modules/quality.md                      NEW
  Skills, rules and learning           modules/skills-and-learning.md          NEW
  Automation and remote control        modules/automation.md                   NEW
  Governance and data lifecycle        modules/governance.md                   NEW
  Shared Agent Context                 modules/shared-agent-context.md         NEW
Concepts
  The Metaproject                      concepts/metaproject.md                 NEW
  Architecture                         architecture.md                         REWRITTEN (D41-D47; Mermaid kept)
  The agent harness                    harness.md                              REWRITTEN (D05, providers, turn budgets)
  Security model                       concepts/security-model.md              NEW (onboarding §Environment isolation, harness policy/sandbox, limitations sandbox, SECURITY threat scope)
  Self-learning loop                   learning.md                             KEPT
  Review service: what was measured    jev-in-review.md                        KEPT (added to nav; fixes orphan)
Reference
  Overview                             reference/index.md                      NEW (area 15; finding a command)
  CLI reference                        cli-reference.md                        REWRITTEN (T7 drift, ids stripped)
  Commands by task                     commands-by-task.md                     KEPT (regenerated)
  Module reference                     modules.md                              REWRITTEN (D40, D48)
  Configuration and environment        reference/configuration.md              NEW
  Workspace and lifecycle              workspace-and-lifecycle.md              KEPT (sub-audit fixes)
  Integrations and adapters            integrations.md                         REWRITTEN (D44, D46)
  Lifecycle hooks                      hooks.md                                REWRITTEN (strip 21 W#/R#)
Project
  Project status                       project/status.md                       NEW
  Built with Keryx                     project/built-with-keryx.md             NEW
  Limitations                          limitations.md                          REWRITTEN (D13, ids)
  Changelog                            project/changelog.md                    NEW (recent releases + link to CHANGELOG.md)
  FAQ                                  project/faq.md                          NEW
  Contributing and support             project/contributing.md                 NEW (links CONTRIBUTING, SUPPORT, SECURITY, CoC, ROADMAP)

Not in nav:   README.md (GitHub-browsing stub)                             REWRITTEN (10 lines → site + index.md); stays in exclude_docs
              llms.txt (site root)                                          NEW (generated by the llmstxt plugin, or static file)
Retired:      onboarding.md                                                 RETIRED → split as above
              complete-setup-and-agent-workflows.md                         RETIRED → split as above; §11 command list dropped (duplicates cli-reference / commands-by-task)
```

Counts: 65 nav pages (was 35 in nav + 1 orphan + the excluded `README.md`): 26 NEW, 5 MERGED (new
paths), 24 KEPT, 10 REWRITTEN at the same path; 2 RETIRED; the `README.md`
stub is rewritten outside the nav. Each Modules page is about 80-150 lines; depth stays
in the Reference pages.

Redirect map (`mkdocs-redirects`, on Zensical's supported list; adding a
`plugins:` block requires listing `search` explicitly):

| Old path | New path |
|---|---|
| `onboarding.md` | `getting-started/quickstart.md` |
| `complete-setup-and-agent-workflows.md` | `guides/set-up-a-project.md` |

Anchor-level forwarding (`onboarding.md#bun-version` → `install.md#bun-version`)
by the plugin is UNCONFIRMED; T8 rewrites every inbound repo link (README,
CHANGELOG, guides) to the new anchor so `check-doc-links` stays at 0.

Site config changes (T8): pin `mkdocs-material` and plugins in a
`requirements-docs.txt`; plugins `search`, `redirects`, `llmstxt`; theme
`logo`, `favicon`, `navigation.indexes`, `navigation.tabs`; `extra.social`;
`overrides/main.html` for OG meta tags; non-blocking `zensical build` job. Fix
the two stale `mkdocs.yml` comments (D51). Add a CI check that every Markdown
file under `docs/docs` is in the nav or `not_in_nav` (AC4), since `--strict`
does not catch it.

### 4c. The 15 documentation areas → pages

| # | Area | Page(s) | Scope (one line) |
|---|---|---|---|
| 1 | Get started | `getting-started/install.md`, `getting-started/quickstart.md` | four install paths, Bun floor, `init`, `doctor`, `setup`, `status`, `update`, `version check`; first session |
| 2 | Project knowledge | `modules/project-knowledge.md` | graph, compact context, wiki, memory, orient, sync, stack: ask the repo instead of re-reading it |
| 3 | The keryx shell | `modules/shell.md` | launch flags, slash commands, sessions, rewind, permission modes, `/settings`, themes, `/goal`, `/plan` |
| 4 | Models and providers | `modules/providers.md` | native and compatible providers, subscription login, custom endpoints, routing, model tiers, `/external`, web search |
| 5 | Harness and safety | `modules/harness-and-safety.md` | policy engine, sandbox (`sandbox status`), `harness run/exec/replay`, lifecycle hooks, security scanning |
| 6 | Connect your agents | `modules/integrations.md` | `integrations install/doctor/matrix`, `integrate`, `agents bootstrap`, `serve-mcp`, ACP server |
| 7 | MCP servers in the shell | `modules/mcp-servers.md` | `mcp add/list/doctor/trust/auth`, project scope, credential rules |
| 8 | Delegation | `modules/delegation.md` | subagent catalog, external CLI agents and reviewed writes, ACP client, agent bus, slate |
| 9 | Managed work | `modules/managed-work.md` | flow lifecycle and frozen criteria, signatures, job packages, review packages, PR bot |
| 10 | Quality | `modules/quality.md` | health gate, related tests, coverage map, metrics |
| 11 | Skills, rules and learning | `modules/skills-and-learning.md` | bundled skills, `rules sync`, learning loop, bundle portability |
| 12 | Automation and remote control | `modules/automation.md` | triggers, schedules, `serve` and approvals, CI usage |
| 13 | Governance and data lifecycle | `modules/governance.md` | governance report, product intents, retention, forgetting, dashboard |
| 14 | Shared Agent Context | `modules/shared-agent-context.md` | opt-in `workspace` module, FWK overview, proposals, review gate (experimental) |
| 15 | Reference | `reference/index.md` → `cli-reference.md`, `commands-by-task.md`, `modules.md`, `reference/configuration.md`, `workspace-and-lifecycle.md`, `integrations.md`, `hooks.md` | how to find a command; every verb, subcommand, flag, config file and env var |

### 4d. Landing, "Built with Keryx", "Project status" outlines

**`index.md` (landing)**

| Block | Content |
|---|---|
| Hero | logo mark, tagline, install command, buttons: Get started · GitHub |
| Demo | the recording or hero screenshot (4f) |
| Six cards | Project knowledge · The shell · Managed work · Review · Safety · Connect your agents → Modules pages |
| Pick your path | New user → Quickstart; Evaluator → Keryx in five minutes + Project status; Agent integrator → Connect your agents + `llms.txt`; Contributor → Built with Keryx + CONTRIBUTING |
| Footer | status line (version, platforms, pre-1.0), changelog link |

**`project/built-with-keryx.md`** (from metaproject-state.md §7A)

| # | Section | Content / links |
|---|---|---|
| 1 | The claim | the repo's own `.metaproject/` is committed; scale numbers, each reproduced by a command in `journal.md` |
| 2 | Map of the workspace | structure table, tagged hand-curated / generated / ignored |
| 3 | Anatomy of a flow | description, frozen criteria, tasks, plan, journal, reviews, evidence, signatures, PR; status lifecycle. Example: flow 300 (compact, criteria pinned to file:line at a commit) |
| 4 | Worked example | flow 313 (portability bundles, 9 review rounds) end to end |
| 5 | Review loops | flow 257 (21 review dirs); memory lesson "a fix round needs its own review" |
| 6 | Memory and rules | 3-4 quoted lessons (fix rounds, allowlist is not a boundary, regex guards lose to spellings); how lessons become rules |
| 7 | Wiki and graph | architecture wiki pages, freshness pins, graph before search; flow 225 |
| 8 | Recent and small | flow 361 (most recent, readable) |
| 9 | Honest limits | generated vs curated, stale wiki, Russian working notes, open flows are normal, history rewritten once, flows 256 and 312 as further reading |
| 10 | Reproduce it | `keryx init`, `keryx flow init`, how to read a flow directory |

Linked flows: 300, 313, 257, 225, 361, 256, 312. **Excluded**: 319 (names an
external project), 233 (home paths, fixture credentials, large Russian
journal). Each linked flow is re-scanned for the §6 hygiene findings by T13
before linking (AC8); if one fails, it is dropped, not cleaned in place.

**`project/status.md`**

| Block | Content |
|---|---|
| Version and cadence | 0.3.46; 193 release tags since 2026-07-10; npm with provenance |
| Platforms | macOS full; Linux full core, sandbox without domain allowlist; Windows unverified; no Alpine/musl binary |
| Stable vs experimental | per module, from code markers and owner input (Q2): experimental = Shared Agent Context, per-runtime ctx hooks, some review-service checks, one editor adapter; opt-in = MCP publisher, SAC, external agents, remote entry |
| Numbers | commits, merged PRs, flows done/total, tasks, review rounds, source and test lines, test files, wiki pages, skills, rules; each with its command in `journal.md` |
| Quality gates | frozen criteria, review rounds, CI matrix, own security scanner |
| Known gaps | pre-1.0, single primary maintainer, link to Limitations |
| Roadmap | Now / Next / Later summary, link to ROADMAP.md |

### 4e. `docs/README.md` map design

```
# Documentation
User documentation (published site)
  - Site URL, then: docs/docs/ — every page in the site nav (pointer to index.md)
  - Examples: docs/examples/  ·  Assets: docs/assets/  ·  Capability matrix: docs/integrations/
Project records (not user docs; history and evidence, kept where they are)
  | Directory | What it holds | Status |
  | docs/requirements/ | per-feature requirement packages, roadmap, backlog | historical intent; may differ from shipped behaviour |
  | docs/decisions/ | harness decision records | accepted decisions |
  | docs/analysis/ | audits and analyses | point-in-time |
  | docs/plans/ | implementation and announcement plans | point-in-time, may be stale |
  | docs/report/ | release-readiness and benchmark reports | point-in-time |
  | docs/reviews/ | review fix plans | point-in-time |
  | docs/verification/ | verification evidence and runbooks | point-in-time |
  | docs/skills/ | rejected skill-change log | log |
Documentation policy
  - English canonical; README.ru.md is a maintained translation (replaces "English-only", D57)
  - docs/docs describes shipped behaviour, verified against code and help; records describe intent or evidence at a date
```

Drop the release-readiness-2026-07-10 "current" framing (inventory §4).

### 4f. Assets

| Asset | How it is produced | Owner action |
|---|---|---|
| Hero logo (README) | resize the existing artwork to 880 px wide with `sips` (≤150 KB target); it carries its own dark card so it reads on light and dark GitHub themes; `<picture>` uses it for both | none |
| Logo mark SVG + dark variant | hand-written SVG of the artwork's brace tile (rounded square, braces, three dots) in `docs/assets/keryx-mark.svg` and `keryx-mark-dark.svg` (dark: lighter tile outline); used as site `logo` and `favicon` | approve the mark (Q3) |
| OG / social image | 1280×640 HTML/SVG card (mark, name, tagline, install line) committed as source, exported to PNG by a browser screenshot; wired via `overrides/main.html` meta tags | upload the PNG as the repository social preview (repo settings; not scriptable here) |
| Demo | VHS tape (`docs/assets/demo.tape`) recording init → graph affected → shell turn on the `fake` provider for determinism, if VHS can be installed locally (it is not installed now); otherwise a static hero screenshot and the recording becomes an owner follow-up in `journal.md` | allow installing VHS (Q4) |
| Diagram for README "How it works" | Mermaid does not render in all README viewers (npm); a small hand-written SVG in `docs/assets/how-it-works.svg` | none |
| Existing screenshots | keep the four PNGs; move from README to `modules/shell.md`; switch image URLs from `main` raw links to repo-relative paths where GitHub and the site both resolve them | none |

---

## 5. Open questions for the owner

1. **Does the no-external-names rule cover factual compatibility lists?** The
   README, provider and integration pages need the names of supported
   providers, editors and agent CLIs to be useful; the review service is also a
   third-party name. Recommended: allow names only in factual
   compatibility/provider tables and install commands; forbid them in
   comparisons, inspiration credits and prose claims; AC10's scan whitelists
   those tables.
2. **Which features are "stable" on the Project status page?** Recommended:
   stable = the nine default modules, `keryx shell`, providers, flows, review
   packages; experimental = Shared Agent Context, review-service checks,
   per-runtime ctx hooks, the editor adapter flagged experimental; opt-in
   labelled separately.
3. **Is a simplified SVG mark (the brace tile from the current artwork)
   acceptable as the site logo and favicon?** Recommended: yes; keep the full
   artwork as the README hero.
4. **May the build install VHS locally (Homebrew) to record the demo?**
   Recommended: yes; the tape is committed so the demo is reproducible, and
   the fallback is a static screenshot.
5. **Should the CHANGELOG be split before launch?** Recommended: no; add a
   docs-site page with the current 0.3.x highlights and leave `CHANGELOG.md`
   whole, stripping internal ids only from entries the new page quotes.
