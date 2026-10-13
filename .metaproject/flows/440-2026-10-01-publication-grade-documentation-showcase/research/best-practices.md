# Documentation best practices for a launch-grade CLI / AI-agent tool

Research date: 2026-10-01. Sources are inline. Items I could not verify are marked UNCONFIRMED.
Projects studied (README and docs site, fetched live): Aider, Goose, opencode, uv, mise, OpenHands, Continue.
Frameworks: Diataxis, llms.txt, AGENTS.md, Keep a Changelog, matklad's ARCHITECTURE.md.
Note: fetch summaries are produced by a small model, so lengths and section lists are approximate.

| Project | README length | Shape |
|---|---|---|
| [Aider](https://github.com/Aider-AI/aider) | long (~2.5-3k words) | logo, tagline "AI Pair Programming in Your Terminal", stat badges, screencast, Features, Getting Started, More Info, user testimonials |
| [Goose](https://github.com/block/goose) | very short (~300-400 words) | tagline, 5 badges (license, Discord, CI, LF health score), Get Started, Quick Links, community; everything else on the docs site |
| [opencode](https://github.com/sst/opencode) | short (~400-500 words) | logo, tagline, 3 badges, 21-language switcher, Installation first, Agents, Docs, Contributing |
| [uv](https://github.com/astral-sh/uv) | long | title + badges, tagline, benchmark graphic, Highlights, Installation, Docs, Features with code, Contributing, FAQ, License |
| [mise](https://github.com/jdx/mise) | medium (~800 words) | logo, badges, tagline, nav links, What is mise, 4-step Quickstart, "Where to go next" intent table, demo GIF, sponsors |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | long (~2.5-3k words) | logo, badges, nav links, hero screenshot, overview, 6 feature blocks, Quickstart, Architecture, doc links |

## 1. Showcase README anatomy

README guides ([GitHub community discussion](https://github.com/orgs/community/discussions/160970), [pushpen.dev](https://pushpen.dev/blog/github-readme-best-practices-2026)) converge on: README is a landing page and router; 500-1500 words is the sweet spot; deep material moves to docs. The agent tools split two ways: Goose and opencode go minimal (under 500 words); Aider, uv and OpenHands go long but code-heavy. Recommendation for Keryx: the mise profile, about 700-1000 words of prose plus code blocks. Keryx has many modules, and a long README would bury them.

### Above the fold (first screen)

| Element | Guidance | Who does it |
|---|---|---|
| Logo (light/dark `<picture>`) and name | one centered image | Aider, mise, opencode, OpenHands |
| One-line value prop | concrete noun + differentiator, under 15 words | uv ("extremely fast ... written in Rust"), mise ("Dev tools, env vars, and tasks in one CLI"), Aider |
| Badges | at most 5-6; each answers an evaluator question: CI status, release/npm version, license, docs, community. No vanity badges | Goose (CI, license, Discord, LF health), opencode (Discord, npm, build) |
| Language switcher | one line `English / Русский` directly under badges | opencode (21 languages) |
| Nav link row | Docs, Quickstart, Modules, Changelog, Discord | mise, OpenHands |
| Demo | asciinema/GIF/MP4 or one hero screenshot, 20-40 s, the "aha" (an agent run in the TUI), not a feature tour | Aider (screencast), mise (GIF + transcript), OpenHands (hero image) |
| Install one-liner | one copy-paste block, other package managers collapsed | uv, opencode, Goose |

### Ordered sections with target length

1. Header block above (about 10 lines).
2. **What is Keryx**: 3-5 sentences plus 4-6 bullet differentiators (shell/TUI, multi-provider harness, Metaproject, flows, review orchestration, MCP, external agents). About 120 words. (mise "What is", uv "Highlights")
3. **Install**: one-liner plus link to other methods. About 40 words.
4. **30-second quickstart**: 3-5 commands with expected output, ending in a visible result. (mise four-step quickstart; guides stress time-to-hello-world)
5. **Feature tour**: table or 6 short blocks, one per module, 1-2 lines each plus a docs link. About 200 words. (OpenHands feature blocks, uv Features)
6. **Where to go next**: intent-to-link table, about 8 rows. (mise)
7. **How it works**: one diagram, 3 sentences, link to ARCHITECTURE.md. (OpenHands Architecture section)
8. **Comparison**: optional; either a 5-row honest table or just a link to the docs Compare page.
9. **Status and stability**: version, platforms, stable vs experimental. (uv FAQ "production ready?")
10. **Community / Contributing / Security / License**: four links.
11. Optional: sponsors and contributors (mise).

### Push to the docs site, not the README
Per-provider setup, full config reference, per-command CLI reference, every module's usage, troubleshooting, long FAQ, changelog, benchmark detail. Testimonials (Aider) only if real. Goose and opencode keep almost everything off the README; mise and uv link out to topic pages.

## 2. Docs-site information architecture

### Diataxis
[Diataxis](https://diataxis.fr/) has four types from two axes (action vs knowledge, study vs work): tutorials (learning), how-to guides (task), reference (lookup), explanation (understanding) ([start here](https://diataxis.fr/start-here/)). Rule: do not mix types on one page. Real sites relabel but keep the split:
- uv: Getting started / Guides / Concepts / Reference ([docs.astral.sh/uv](https://docs.astral.sh/uv/)).
- Continue: Getting Started / Features / Customize / Guides / Help ([docs.continue.dev](https://docs.continue.dev/)).
- Aider: task-oriented (Installation, Usage, Connecting to LLMs, Configuration, Troubleshooting, Example transcripts, FAQ) ([aider.chat/docs](https://aider.chat/docs/)).
- mise: feature pillars (Dev Tools, Environments, Tasks, Bootstrap) plus Getting Started ([mise.jdx.dev](https://mise.jdx.dev/)).

### Mapping for a CLI + agent tool

| Diataxis | Keryx content |
|---|---|
| Tutorial | first agent session in 10 minutes; set up a Metaproject in an existing repo; run a first flow end to end |
| How-to | connect a provider (Anthropic/OpenAI/Ollama); use a local model; add an MCP server; wire Claude Code or Codex as an external agent; run a code review; write a custom skill; use in CI; upgrade |
| Reference | CLI commands (generated); config schema; env vars; slash commands and TUI keys; MCP tools; provider matrix; `.metaproject/` file layout; flow state machine; exit codes |
| Explanation | Metaproject concept; why code graph + wiki + memory; harness design; flow model; security and permission model; design decisions |

### Recommended top-level nav for Keryx

1. **Home** (landing)
2. **Getting started**: Install, Quickstart (tutorial), Concepts in 5 minutes
3. **Guides** (how-to): Providers and models, Agent shell/TUI, Metaproject workflows, Flows, Code review, MCP, External agents, CI/automation
4. **Modules**: one page per module (gdgraph, gdwiki, gdctx, memory, flows, review, testing, harness, shell/TUI, MCP), each with what/why, a 5-line example, and a link to reference. This is the mise/Goose "feature pillar" idea with reference attached.
5. **Concepts** (explanation): architecture, Metaproject model, security model, design decisions
6. **Reference**: CLI, configuration, environment, protocols/schemas, skills catalog
7. **Compare and FAQ**: Keryx vs X, FAQ, troubleshooting
8. **Project**: Changelog, Roadmap, Contributing, Security, Governance

Keep depth to two levels; use section index pages.

### Landing-page pattern
mise: hero with install command, example config with output, video, four capability cards, tutorial steps, CTA footer ([mise.jdx.dev](https://mise.jdx.dev/)). Continue: one-sentence positioning, then five capability sections ([docs.continue.dev](https://docs.continue.dev/)). For Keryx: hero (tagline, install, "Get started" and "GitHub" buttons), 30 s demo, 6 module cards, "Pick your path" (new user / evaluator / contributor / agent integrator), link to llms.txt.

## 3. MkDocs tooling

### Status in 2026 (verified from fetched pages)
- Material for MkDocs entered **maintenance mode** on 2025-11-05. Maintainers commit to critical bug and security fixes for at least 12 months and no new features; they built **Zensical** as the successor ([announcement](https://squidfunk.github.io/mkdocs-material/blog/2025/11/05/zensical/)). A third-party issue cites 2026-11-05 as end of support ([portolan-cli #892](https://github.com/portolan-sdi/portolan-cli/issues/892)); the exact end date is UNCONFIRMED (the announcement says "at least 12 months").
- Upstream MkDocs has had no maintainer since Aug 2024. MkDocs 2.0 drops the plugin system, moves config to TOML, and is incompatible with Material ([Material blog, 2026-02-18](https://squidfunk.github.io/mkdocs-material/blog/2026/02/18/mkdocs-2.0/)). Do not plan on MkDocs 2.x.
- Zensical reads `mkdocs.yml` natively and emits the same HTML, so existing overrides and CSS keep working ([announcement](https://squidfunk.github.io/mkdocs-material/blog/2025/11/05/zensical/)). Latest release seen: v0.0.67 on 2026-09-30 ([release](https://github.com/zensical/zensical/releases/tag/v0.0.67)), so still pre-1.0 (search snippet; not read in full).
- Zensical has native replacements for 23 plugins: search, social cards, mike, redirects, llmstxt, mkdocstrings, minify, blog, tags, macros and others ([compat list](https://zensical.org/compatibility/plugins/)). Not supported: gen-files. Planned: git-revision-date. **i18n is not supported yet** (roadmap lists multilingual as planned: [roadmap](https://zensical.org/roadmap/)). Whether `--strict` behaves identically is UNCONFIRMED.

### Plugins worth having

| Need | Material / MkDocs 1.x | Zensical |
|---|---|---|
| Search | built-in | built-in (new engine) |
| Social cards | `social` plugin | native |
| Versioning | `mike` | native mike integration |
| Redirects | `redirects` | native |
| llms.txt | `mkdocs-llmstxt`, [mkdocs-llmstxt-md](https://github.com/noklam/mkdocs-llmstxt-md), [mkdocs-llms-source](https://github.com/TimChild/mkdocs-llms-source) | native llmstxt replacement |
| i18n | [mkdocs-static-i18n](https://ultrabug.github.io/mkdocs-static-i18n/) | not yet |
| Last-updated date | git-revision-date-localized | planned |

Versioning is probably overkill at launch (0.x, one live version); add mike when there is a stable 1.0 with a support window.

### Auto-generated CLI reference
- Python options (mkdocs-click, mkdocs-typer, [mkdocs-click repo](https://github.com/mkdocs/mkdocs-click)) do not apply: Keryx is TypeScript/Bun.
- Recommended: a script (for example `bun scripts/gen-cli-docs.ts`) that walks the command tree or `--help` output and writes `docs/reference/cli/*.md`. Commit the generated files and add a CI drift check (regenerate, then `git diff --exit-code`). One public project describes the same approach ([issue example](https://github.com/singhjatinsec/Source-Code-Review-Tool-TIT/issues/188)). Avoid gen-files because Zensical does not support it.

### Deployment to GitHub Pages
Standard route: GitHub Actions with `actions/configure-pages`, build, `actions/upload-pages-artifact`, `actions/deploy-pages` (Pages source set to "GitHub Actions"). With mike, `mike deploy --push --update-aliases X.Y latest` publishes to the `gh-pages` branch. A verified Zensical workflow snippet was not fetched (UNCONFIRMED; check zensical.org docs). Keep a PR-time strict build as the link and nav gate.

### Recommendation

| Option | Pros | Cons |
|---|---|---|
| A. Stay on Material 9.7.x, pin versions | stable, full plugin ecosystem, i18n works, no migration | maintenance-only; upstream MkDocs 1.x unmaintained; rot risk after about Nov 2026 |
| B. Move to Zensical now (same mkdocs.yml) | active development, faster, native social/mike/llmstxt/redirects | 0.0.x, plugin subset, no i18n, strict-mode parity unverified |
| C. Another SSG (Starlight, Docusaurus, Mintlify) | active ecosystems | rewrite cost; loses existing mkdocs.yml and CI |

**Recommendation: A for launch, with a ready path to B.** Use only plugins on Zensical's supported list (search, social, redirects, llmstxt, minify; mike later), pin versions, avoid gen-files, avoid a heavy i18n plugin (section 5), and add a non-blocking `zensical build` CI job now. Switch to B after a few clean trial builds and once i18n lands. If the owner prefers a one-step future-proof choice and accepts 0.0.x risk, B is viable because the config is shared; decide after the trial build.

## 4. Meta-files of a mature repo

| File | Convention |
|---|---|
| LICENSE | present, SPDX-correct, stated in README |
| CONTRIBUTING.md | dev setup in about 5 commands; test/lint commands; branch and commit conventions; how to add a module or skill; PR checklist; good-first-issue policy |
| SECURITY.md | supported versions; private reporting channel (GitHub private vulnerability reporting); response expectations; scope. For an agent tool, add a threat model (shell execution, secrets, network egress) |
| CODE_OF_CONDUCT.md | Contributor Covenant 2.1 with a real contact |
| GOVERNANCE.md / MAINTAINERS.md | short: who decides, how to become a maintainer. Goose links governance from its README Quick Links ([goose](https://github.com/block/goose)). A one-page solo-maintainer statement is fine |
| .github/ISSUE_TEMPLATE | YAML forms: bug (version, OS, provider, repro), feature, docs; `config.yml` routes questions to Discussions/Discord |
| PULL_REQUEST_TEMPLATE.md | what/why, tests, docs updated, changelog entry |
| CHANGELOG.md | [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): for humans, newest first, dated, Unreleased section, categories Added/Changed/Deprecated/Removed/Fixed/Security, yanked releases tagged `[YANKED]`, SemVer statement |
| ROADMAP.md | Now/Next/Later, no dates, stated as intent not promise |
| ARCHITECTURE.md | per [matklad](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html): short; bird's-eye overview; coarse codemap (name files and types, do not deep-link); invariants, especially absences; layer boundaries; cross-cutting concerns; revisit a couple of times a year |
| FAQ | docs site, short version in README |
| SUPPORT.md | where to ask (Discussions/Discord) versus Issues |

### Handling a ~7500-line changelog
- Keep the full file for history but do not make it the entry point. The docs Changelog page shows the current minor series and links to the archive.
- Split by era: current series in `CHANGELOG.md`, older series in `docs/changelog/archive/<minor>.md`, one page per minor so pages stay navigable and builds fast.
- Put a "Highlights" block (about 10 notable releases) and a version index at the top.
- Fold internal-only entries (flow bookkeeping, refactors) into an "Internal" group or drop them from the public view.
- Mirror each release into GitHub Releases using the same entry text.

### "Keryx vs X" comparison etiquette
- Put it under docs Compare, not in the README headline. Be factual, dated ("as of 2026-10"), link the other project's docs, and invite corrections.
- Compare on dimensions (architecture, providers, local models, privacy, extensibility). No "better/worse"; say where the other tool is stronger.
- Only include benchmarks you can reproduce, with method linked.
- Project constraint (from the owner's memory notes, not web research): Keryx docs must not name external inspiration projects. A comparison page would need an explicit owner decision on that rule. Flag it before writing.

## 5. Bilingual docs (EN primary, RU secondary)

- README: `README.md` is canonical EN, `README.ru.md` is RU. Put `English | [Русский](README.ru.md)` under the badges and mirror it in the RU file. opencode puts a language switcher near the top of its README ([opencode](https://github.com/sst/opencode)).
- Sync policy: EN is the source of truth. The RU file carries `<!-- synced-with: README.md @ <commit> -->` and CI warns (or fails) if README.md changed after that commit without a RU update. Add a "translation may lag" note on RU pages.
- Scope: translate README, Getting started and Concepts first. Keep generated Reference and the Changelog EN-only. Partial translation with fallback to EN is acceptable.
- Docs-site options:
  - (a) mkdocs-static-i18n with a `/ru/` path and fallback to EN ([plugin docs](https://ultrabug.github.io/mkdocs-static-i18n/)). Works on Material; Zensical does not list i18n support yet.
  - (b) a plain `docs/ru/` section in the nav with manual cross-links, no plugin. Portable to Zensical.
  - (c) EN-only docs plus RU README at launch.
  - Recommend (c), then (b) as RU pages appear.
- For Habr, a RU article links README.ru.md and the RU quickstart.

## 6. Agent-readable docs

| Mechanism | What it is | Convention |
|---|---|---|
| llms.txt | Markdown index at the site root: H1 title, blockquote summary, H2 sections of link lists; proposed by Jeremy Howard, 2024-09 ([llmstxt.org](https://llmstxt.org/)) | also serve clean `.md` versions of pages (`page.md` or `page.html.md`) and link them via `rel="alternate" type="text/markdown"` |
| llms-full.txt | one concatenated file of all docs | common tooling convention; the spec page I read does not mention it |
| AGENTS.md | "README for agents": build/test commands, code style, testing, security, commit/PR rules. Stewarded by the Agentic AI Foundation under the Linux Foundation; claims 60k+ projects ([agents.md](https://agents.md/)). Nested files allowed, closest wins | |
| Copy-page / "Use with AI" | Continue's docs show copy-page and AI features ([docs.continue.dev](https://docs.continue.dev/)); [mkdocs-ask-ai](https://github.com/mrkhachaturov/mkdocs-ask-ai) adds a menu, llms.txt and an MCP server for MkDocs | |
| Docs MCP server | lets agents search docs; post-launch optional | |

How much AI providers actually consume llms.txt is UNCONFIRMED; it is cheap, so ship it. For Keryx: AGENTS.md and CLAUDE.md already exist, so keep AGENTS.md accurate and short, add a `docs/for-agents.md` page on using Keryx and `.metaproject/` from external agents, and generate llms.txt in the docs build (native in Zensical; `mkdocs-llmstxt` on Material).

## 7. Launch-readiness checklist (docs)

- [ ] README above fold: logo, one-line value prop, at most 6 meaningful badges, language switcher, nav links
- [ ] Demo (asciinema/GIF/MP4) under 40 s, renders on GitHub and on the docs landing page
- [ ] Install one-liner tested on macOS and Linux; Windows status declared
- [ ] 30-second quickstart executed verbatim on a clean machine, real output pasted
- [ ] README under about 1000 words of prose; each module gets one line plus a link
- [ ] Docs landing page: hero, demo, module cards, "pick your path"
- [ ] Nav follows Getting started / Guides / Modules / Concepts / Reference / Compare / Project
- [ ] One page per module (what/why, example, reference link)
- [ ] All four Diataxis types present (1 tutorial, several how-tos, reference, 1 explanation)
- [ ] CLI reference generated from code with CI drift check
- [ ] Config and env var reference complete
- [ ] Provider matrix and a local-model (Ollama) how-to
- [ ] Security model page; SECURITY.md with private reporting enabled
- [ ] CONTRIBUTING, CODE_OF_CONDUCT, LICENSE, issue and PR templates present
- [ ] ARCHITECTURE.md with codemap and invariants, linked from README and docs
- [ ] CHANGELOG in Keep a Changelog format; docs page shows recent releases only
- [ ] ROADMAP (Now/Next/Later) and a stability statement
- [ ] FAQ and troubleshooting page
- [ ] Comparison page factual, dated, naming rule decided by owner
- [ ] README.ru.md synced and cross-linked
- [ ] llms.txt published (with `.md` page copies); AGENTS.md accurate
- [ ] Social card / Open Graph image so links preview well on X, Reddit, HN
- [ ] Strict docs build and link checker green in CI; no dead anchors
- [ ] Docs tool versions pinned; non-blocking Zensical trial build in CI
- [ ] Docs deployed to Pages and every README link points to the live site
