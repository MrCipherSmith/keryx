# W1 — Stack-aware skills & rules catalog
Version: 0.2.1

## Summary

Keryx ships 72 bundled skills and 34 core rules, but their stack coverage is
essentially zero: only NestJS/Prisma (`review-backend`, `nestjs-dto.mdc`) and
React/MobX (`review-frontend`, `review-frontend-conventions`,
`code-mobx-store-review`, `mobx-store-template.mdc`) have any framework-aware
content, and even those are review-only — there is no implementation skill for
either stack. Nothing detects which stack a project uses at the catalog level;
the only existing signal, `metadata.stack_requires`, is a narrow, manually
authored tag consumed by exactly four review skills to gate dispatch, not to
discover missing coverage or drive installation. This workstream defines
(1) a deterministic stack-detection contract, (2) a
"stack pack" content shape (rules + skills + agent references) covering the
languages/frameworks Keryx has none for today, (3) an install
profile→module→component model with plan/state/doctor/uninstall commands, (4)
an authoring standard aligned to the public Agent Skills format, and (5)
governance gates (scout, eval, stocktake) so catalog growth is checked rather
than bulk-generated. Flow 309 (Wave 2) implemented (1) stack detection, (3)
the install profile→module→component lifecycle (plan/apply/doctor/uninstall),
and (5) the three governance gates; (2) stack pack content was scoped as a
Wave 4 target and (4) the authoring-standard lint remains planned. Flow 314
(Wave 4 batch 1) authored the first four stack packs against gate (5) — see
"Implementation notes (flow 309)" and "Implementation notes: Wave 4 batch 1
(flow 314)" below for what landed and what is still a target contract.

## Current state (with code paths)

Verified against the worktree at `/Users/Goodea/goodea/keryx-agent-platform`
(paths below exist; `keryx ctx rg` returns 0 hits where noted):

- **Skill/rule inventory.** `src/gdskills/bundled/skills/` holds 72
  `SKILL.md` files across `core` (1 shipped, rest are Metaproject-runtime
  skills materialized under `.metaproject/skills/gdskills/core/`),
  `orchestration` (9), `planning` (19), `platform` (4 shipped), `quality`
  (17), `review` (22), `shared` (helper assets, no `SKILL.md`).
  `src/gdskills/bundled/rules/core/` holds 34 `.mdc` rule files; only
  `nestjs-dto.mdc`, `mobx-store-template.mdc`, `storybook-guidelines.mdc`,
  `playwright-testing.mdc` are stack/tool-specific, the rest (e.g.
  `code-style-patterns.mdc`, `async-patterns.mdc`, `database-patterns.mdc`,
  `error-handling.mdc`) are language-agnostic. `.metaproject/skills/catalog.md`
  documents the resolution order (`index.md` → `routing.md` → `catalog.md` →
  `project-skills/**` → `gdskills/**` → allowed global fallback) and a
  **Project Skills** section auto-generated between
  `<!-- gdskills:project-skills:start/end -->` markers, currently 2 entries
  for this repo's own tooling — per-repo generated artifacts, not a stack
  catalog.
- **Skill frontmatter parsing.** `src/gdskills/skill-frontmatter.ts` defines
  `SkillFrontmatter` (`description`, `triggers`, `metadataCategory`,
  `metadataVersion`, `compatibleHarnesses`) as the single source of truth
  shared by the runtime catalog server and the shipped-tree validator; its own
  doc comment records that a narrower, drifted validator once missed 15
  skills whose description was an unrendered YAML block scalar.
- **Stack detection that exists today: `src/review/stack.ts`.** This is
  real, tested code (`src/review/stack.test.ts`), but it is deliberately
  narrow: `detectProjectStack(cwd)` reads `<cwd>/package.json` once and
  answers a boolean per tag in `STACK_TAGS = ["nestjs", "react", "mobx",
  "prisma", "playwright", "sql", "http-server"]`, matched against
  `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`
  names (`TAG_MARKERS`). It never walks the filesystem for marker files or
  extensions, never inspects `pyproject.toml`/`go.mod`/etc., and treats every
  ambiguous case (missing/unparseable manifest, no declared deps, a
  `workspaces` root) as `uncertain: true`, which forces every tag `true` — a
  deliberate fail-open rule documented in the module's own header ("uncertain
  always means included"). `parseStackRequires` /
  `extractStackRequiresField` parse a skill's `metadata.stack_requires`
  frontmatter field (comma-separated tags) and `scopeReviewerByStack` decides,
  per reviewer, whether it runs; `src/commands/review.ts` (lines ~1459, 1510,
  2596) wires that decision into `review-orchestrator`'s dispatch. This is a
  **review dispatch filter**, not a project-wide stack registry: it has no
  output file, is not invoked by `keryx init` or `keryx skills install`, and
  covers 7 tags total (no Python/Go/Rust/Java/etc.). `keryx ctx rg
  "detectStack|stackDetect|StackDetection" src` returns 0 matches — no general
  `detectStack` entry point exists anywhere in `src/`.
- **Install/routing commands today.** `keryx skills --help`
  (`src/commands/skills.ts`, `src/commands/routing-corpus.ts`) exposes
  `status | list | inspect | route | catalog [--profile recommended] | install
  [--profile recommended] | create | verify | learn | learn apply | export
  --runtime codex|claude|plugin | sync --runtime codex|claude --target <dir> |
  contracts validate`. `install --profile recommended` installs a fixed
  curated subset — profile-gated, not stack-gated; there is no `--with`/
  `--without` component flag, no dry-run/JSON plan output, no install-state
  file, no `doctor`, no `uninstall`. `export`/`sync` are format translators
  (project-skill → Codex/Claude/plugin file), not stack expansion.
- **Skill lifecycle governance today.** `src/gdskills/bundled/rules/core/
  skill-lifecycle.mdc` governs *freshness* verification
  (`keryx skills verify <m>/<s>` → `fresh | stale | needs-review | blocked`)
  and drift-triggered `learn` proposals — it has no mechanism that flags
  "no skill exists for stack X," and explicitly does not compare skill prose
  against current code (a manual step). Existing guard tests —
  `src/gdskills/bundled-eval.test.ts` (frontmatter shape, `compatible_harnesses`
  must include `claude`, status-contract lines), `src/gdskills/
  agent-catalogue-xref.test.ts` (dispatch-position cross-reference lint over
  `agent:`/`subagent_type:`/`Agent(...)`/`Task(...)` strings, scanning both
  `src/gdskills/bundled/skills/` and `.metaproject/skills/gdskills/`), and
  `src/gdskills/enforcement-claims.test.ts` (string guard against a skill
  claiming an enforcement that doesn't exist in code) — all check *internal
  consistency of the existing 72 skills*. None checks catalog breadth or
  dedupes a proposed new skill against the existing set before it is added.

## Goals & non-goals

**Goals**
1. Deterministic, offline stack detection that extends `src/review/stack.ts`'s
   proven fail-open discipline to a general-purpose `keryx stack detect`
   command covering the full target-stack table below.
2. A "stack pack" content shape — rules with `paths:` glob scoping, an
   implement/test/review/build-fix/migrate skill set, and agent references
   (W2) — so a stack goes from "review-only or absent" to a coherent authored
   unit, for the stacks listed in the table.
3. An install model (profiles → modules → components) with a plan/apply/
   state/doctor/uninstall lifecycle, replacing today's single fixed
   `--profile recommended` subset.
4. An authoring standard for new skills/rules aligned to the public Agent
   Skills open standard (name ≤64 chars, description ≤1024 chars with "Use
   when…", body ≤500 lines, references one level deep, progressive
   disclosure).
5. Governance gates — pre-creation dedupe (`scout`), behavioral compliance
   evals (`eval`), periodic health check (`stocktake`) — so catalog growth
   (D-7: "content scale-out only through governance gates, not bulk
   generation") is checked before every batch, not audited after the fact.
6. Provenance (`metadata.origin`) on every catalog entry so a generated,
   imported, or learned skill/rule is distinguishable from a hand-authored
   one.

**Non-goals**
- Writing the 23-stack-pack content itself in this requirements package — this
  document specifies the pack *shape*, detection contract, install model, and
  governance gates; actual per-stack rule/skill authoring is Wave 4 batch
  work (implementation-plan.md), gated by the eval harness this workstream
  defines.
- Per-stack agent personas — that catalog (`.metaproject/agents/<name>.md`,
  exporters, compiler) is W2; W1 only supplies the stack packs W2's per-stack
  agents are generated from.
- Changing `review-orchestrator`'s existing `stack_requires`-based dispatch
  gating — W1 generalizes stack detection and extends `stack_requires`
  semantics to non-review modules, but does not redesign the review dispatch
  path itself.
- Any model-backed stack detection — detection stays marker/manifest-based,
  deterministic, and network-free, matching `src/review/stack.ts`'s existing
  design.

## Design

### Stack detection — output contract

`keryx stack detect [--cwd <dir>] [--json]` generalizes `detectProjectStack`
from a 7-tag, `package.json`-only check to a marker-file + extension +
manifest scan across every target stack, writing (or printing with `--json`)
a document at `.metaproject/data/stack/stack.json`:

```json
{
  "schemaVersion": "1.0.0",
  "detectedAt": "<ISO-8601>",
  "tags": { "python": true, "django": false, "go": false, "...": "..." },
  "uncertain": false,
  "reason": "detected from package.json (12 declared dependencies), pyproject.toml (poetry)",
  "matched": ["react", "django", "..."],
  "perSignal": [
    { "signal": "manifest:package.json", "tags": ["react", "typescript"], "uncertain": false },
    { "signal": "manifest:pyproject.toml", "tags": ["python", "django"], "uncertain": false },
    { "signal": "marker:go.mod", "tags": ["go"], "uncertain": false }
  ]
}
```

Rules carried over unchanged from `src/review/stack.ts` (extended to every
signal source, not just `package.json`):
- **Uncertain always means included.** Any signal source that cannot be read
  or parsed, or a monorepo/workspace root that declares no leaf dependency,
  sets `uncertain: true` for the tags it would have covered; a tag's overall
  value is `true` if *any* signal marks it uncertain-or-present. No signal
  source may turn a tag `false` on its own — only a clean parse that plainly
  does not name the stack does that.
  - This is a deliberate change from a single global `uncertain` boolean
    (adequate for one manifest) to a **per-signal uncertain contribution**:
    with multiple signal sources, a `pyproject.toml` parse failure must not
    force `react: true` and every JS tag `uncertain`, only the Python-family
    tags.
- Deterministic, no network, no model call. Signal sources for v1: manifest
  files (`package.json`, `pyproject.toml`/`setup.cfg`/`requirements.txt`,
  `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle(.kts)`, `*.csproj`/`*.sln`,
  `Package.swift`, `pubspec.yaml`, `composer.json`, `Gemfile`), and marker
  files/extensions for stacks with no single manifest convention
  (`Dockerfile`, `docker-compose.yml`, `*.tf`, `.github/workflows/*.yml`,
  `.gitlab-ci.yml`, `*.sql` presence for generic SQL, engine-specific
  connection-string patterns are explicitly **not** sniffed — SQL engine
  detection stays manual via a declared component).
- `reason` is always populated, mirroring
  `renderStackScopingMarkdown`'s existing "reason on every line" discipline.
- `keryx stack detect` never mutates skills, rules, or install state by
  itself — it only produces `stack.json`, which `keryx skills install
  --profile <stack-aware-profile>` reads.

### Stack pack layout

A stack pack is a directory under
`src/gdskills/bundled/stacks/<stack-id>/` with a fixed shape:

```
stacks/<stack-id>/
  pack.json                # id, family, detectionMarkers, module ids (mirrors component shape)
  rules/
    coding-style.mdc
    patterns.mdc
    security.mdc
    testing.mdc
  skills/
    implement/SKILL.md
    test/SKILL.md
    review/SKILL.md
    build-fix/SKILL.md
    migrate/SKILL.md
  agent-refs.json          # names of W2 per-stack agents this pack feeds (reviewer + build-error-resolver)
```

Every rule file under `rules/` carries a `paths:` glob in its frontmatter
(e.g. `paths: ["**/*.py"]` for Python, `paths: ["**/*.tsx", "**/*.jsx"]` for
React) and an `extends: common` marker so stack rules layer on top of the
existing 30 stack-agnostic core rules rather than duplicating them. A stack
pack's five skills are optional per stack — a pack may ship fewer than five
when a category genuinely does not apply (e.g. no separate `migrate` skill
for a stack with no schema/version-migration concept) — but the manifest must
say so explicitly (an empty list, not a missing file that looks unauthored).

Full target-stack table (gap confirmed against `src/gdskills/bundled/skills/`
and `src/gdskills/bundled/rules/core/` — see Current state above):

| Stack id | Family | Pack contents planned | Today |
|---|---|---|---|
| `ts-js-node` | language | coding-style, patterns, security, testing rules; implement/test/build-fix skills | generic-only rules (`code-style-patterns.mdc`, `async-patterns.mdc`) |
| `react` | framework | full pack; extends `ts-js-node` | review-only (`review-frontend`, `stack_requires: react`) |
| `vue` | framework | full pack; extends `ts-js-node` | none |
| `angular` | framework | full pack; extends `ts-js-node` | none |
| `nextjs-nuxt` | framework | full pack; extends `react`/`vue` respectively | none |
| `nestjs` | framework | full pack; extends `ts-js-node` | review-only (`review-backend`, `stack_requires: nestjs,prisma`), `nestjs-dto.mdc` |
| `mobx` | capability | implement + review + template; extends `react` | review-only (`code-mobx-store-review`), `mobx-store-template.mdc` |
| `python` | language | full pack | none |
| `django` | framework | full pack; extends `python` | none |
| `fastapi` | framework | full pack; extends `python` | none |
| `go` | language | full pack | none |
| `rust` | language | full pack | none |
| `java-kotlin-spring` | framework | full pack; extends `lang:java-kotlin` | none |
| `csharp-dotnet` | language | full pack | none |
| `swift-ios` | framework | full pack; extends `lang:swift` | none |
| `kotlin-android` | framework | full pack; extends `lang:kotlin` | none |
| `flutter-dart` | framework | full pack; extends `lang:dart` | none |
| `php-laravel` | framework | full pack; extends `lang:php` | none |
| `ruby-rails` | framework | full pack; extends `lang:ruby` | none |
| `c-cpp` | language | full pack | none |
| `sql-db` | capability | per-engine (Postgres/MySQL/Mongo) coding-style + security rules; extends generic `database-patterns.mdc` | generic engine-agnostic rule only |
| `docker-k8s-terraform` | tool | coding-style + security rules, no implement skill (config authoring lives in the `deploy` quality skill) | none |
| `ci-github-gitlab` | tool | patterns + security rules for workflow YAML | none |

`storybook-guidelines.mdc` and `playwright-testing.mdc` are treated as
existing tool packs (JS/TS tooling), left as-is; they are cross-referenced
from the `ts-js-node` and `react` packs, not duplicated.

### Rule scoping via `paths:` globs extending `common`

Today's 30 stack-agnostic rules become the implicit `common` base: every
stack rule's frontmatter declares `extends: common` and a `paths:` glob so
Keryx's rule loader only injects a stack rule into context for files that
glob matches, instead of loading every rule for every file regardless of
stack (the cost problem a catalog scaling past two stacks implies for
context loaded per file — unverified — requires first-party docs check
before implementation). `common` rules keep no `paths:` restriction (always loaded, as
today). A stack pack's `security.mdc` may further narrow `paths:` beyond the
pack's general glob (e.g. `nestjs`'s security rule scoped to
`**/*.controller.ts` and `**/*.guard.ts` only) — narrowing is allowed,
widening past the pack's own file types is not (enforced by the authoring
standard's lint, not a runtime check).

### Install: profiles → modules → components

Full shape is `schemas/install-manifest.schema.json` (JSON Schema 2020-12,
`$id: keryx://schemas/agent-platform/install-manifest.schema.json`). Summary:

- **Module** — one physically installable unit (`kind`: `rule` | `skill` |
  `agent-ref` | `hook-runtime` | `schema` | `doc`), with `paths` (source
  files/globs), `targets` (harness ids it's written for — cross-checked
  against the W5 capability matrix at plan time), `dependencies`,
  `defaultInstall`, `cost` (`light`|`medium`|`heavy`), `stability`
  (`experimental`|`stable`|`deprecated`).
- **Component** — a named grouping of modules with a `family`
  (`baseline`|`language`|`framework`|`capability`|`agent`|`skill`|`tool`), e.g.
  `lang:python`, `framework:react`; carries `detectionMarkers` so
  `keryx stack detect` can recommend it, and a `provenance` block
  (`origin: authored|generated|imported|learned`).
- **Profile** — `modules` (installed unconditionally) plus `components`
  (installed when detected, or via `--with`); a `stackDetectionAware` flag
  turns on the detect-then-intersect behavior described above.

Example profiles:
- `minimal` — `modules: [core-common-rules, skill-lifecycle]`, no components.
- `core` — `modules` covers orchestration/quality/review skill modules plus
  every `common` rule module; `components: []` (no stack-specific content —
  matches today's "curated subset" behavior, made explicit and inspectable).
- `<stack>` (e.g. `python`, `react`) — `modules: [core-common-rules]`,
  `components: ["lang:python"]` or `["framework:react", "lang:ts-js-node"]`,
  `stackDetectionAware: true`.
- `full` — every registered module and component, `stability: deprecated`
  modules excluded unless `--include-deprecated`.

Lifecycle:
- `keryx skills install --profile <p> [--with <component>]* [--without
  <component>]* [--dry-run] [--json]` — dry-run/JSON emits a **plan**: the
  resolved module/component set, per-target file list, and any target the W5
  capability matrix marks `unsupported` (which fails the plan rather than
  silently skipping).
- Apply writes files and records an **install-state** document (schema's
  `installState` def) at `.metaproject/data/skills/install-state/<target>.json`:
  per module, the paths written, their sha256 (for drift detection), and
  whether each carries a `_keryxManaged` sentinel.
- `keryx skills doctor [--target <id>]` reads install-state, re-hashes the
  files on disk, and reports per-target: `ok` (hash matches), `drifted` (user
  edited a Keryx-written file — reported, never overwritten silently),
  `missing` (recorded but absent), `orphaned` (present but unrecorded).
- `keryx skills uninstall --target <id> [--module <id>]` removes only the
  paths recorded in install-state for that module/target — never a glob
  re-scan, never a file without a matching sha256 in the current state (a
  drifted file requires `--force` and prints the diff first).

### Authoring standard

New skills and rules follow the public Agent Skills open standard, adapted to
Keryx's existing frontmatter parser (`src/gdskills/skill-frontmatter.ts`)
rather than replacing it:
- `name` ≤ 64 chars, lowercase/numbers/hyphens, no vendor/harness reserved
  names, gerund or clear action-noun form.
- `description` ≤ 1024 chars, third person, states both what the skill does
  and when to use it ("Use when…"), includes concrete trigger nouns.
- Body ≤ 500 lines; anything longer moves into `references/` linked directly
  from `SKILL.md` (one hop only — no `SKILL.md → a.md → b.md` chains).
- Bundled `scripts/` are stated as run-exactly or read-as-reference,
  explicitly, per file; scripts handle their own errors rather than
  deferring to the calling agent.
- Every new/changed skill's frontmatter carries `metadata.origin`
  (provenance — see below) in addition to the existing
  `metadata.category`/`metadata.version`/`metadata.compatible_harnesses`/
  `metadata.stack_requires` fields already parsed by
  `skill-frontmatter.ts`.
- `compatible_harnesses` must include `claude` (existing
  `bundled-eval.test.ts` rule, unchanged) plus honest entries for any other
  harness this skill's prose assumes exists — cross-checked against the W5
  matrix, not self-declared.

### Governance gates: scout, eval, stocktake

Three gates, each with a CLI surface and a data contract, enforcing D-7
("content scale-out only through governance gates, not bulk generation"):

1. **`keryx skills scout <name-or-description>`** — pre-creation dedupe gate.
   Searches the local catalog (bundled + `.metaproject/skills/gdskills/`),
   plus, when `--include-imports` is set, previously imported bundles (W4),
   for an existing skill covering the same trigger/description space.
   Output: `{ decision: "use" | "fork" | "create", matches: [{skillId,
   overlapScore, reason}] }`. A `create` decision is required before
   `keryx skills create` proceeds for any stack-pack skill (enforced by a
   guard test reading the scout log, not by the `create` command refusing to
   run without it — Keryx does not hard-block local authoring, it makes
   skipping the gate visible).
2. **`keryx skills eval <skill-id> [--strictness low|medium|high] [--trials
   N]`** — behavioral compliance eval. Generates scenario prompts at the
   requested strictness (including negative/should-not-trigger cases),
   dispatches a bounded headless agent run per scenario (reusing the
   existing `spawn_subagent` execution substrate, capped by the existing
   `DEFAULT_MAX_TREE_DEPTH`/`DEFAULT_MAX_CHILDREN` limits in
   `src/harness/child/orchestrate.ts`), and grades each trial against an
   `expected_behavior` list with a deterministic or model grader. Output:
   `{ skillId, scenarios: [{ prompt, strictness, trials, passRate, grader
   }], triggerAccuracy: { truePositive, falsePositive }, verdict: "pass" |
   "fail" }`. Multiple trials per scenario (3–5) report a pass-rate
   distribution, not a single boolean — a W1 design choice, to be validated
   by the first governance eval batch.
3. **`keryx skills stocktake [--scope bundled|all] [--quick]`** — periodic
   health check across the existing catalog (72 skills today, growing with
   each stack pack). `--quick` does a diff-based staleness scan (frontmatter
   vs. last-verified code paths, reusing `skill-lifecycle.mdc`'s existing
   fresh/stale classification); a full stocktake re-runs `eval` on a sample
   and reports a verdict per skill: `keep | improve | update | retire |
   merge`, each with a specific reason (never a bare verdict with no
   justification). Output feeds `.metaproject/data/skills/stocktake/
   <date>.json`.

These three gates extend, rather than replace, the existing guard tests:
`bundled-eval.test.ts` keeps checking frontmatter shape and status-contract
lines; `agent-catalogue-xref.test.ts` keeps checking dispatch-position
references are real; `enforcement-claims.test.ts` keeps checking no skill
claims an enforcement code doesn't implement. New guard tests this
workstream adds: a scout-log-presence check for every skill under
`stacks/*/skills/`, and an eval-verdict-presence check before a stack pack's
`stability` can be set to `stable`.

### Provenance

Every module, component, and skill/rule frontmatter carries
`metadata.origin` (schema field `provenance.origin`:
`authored | generated | imported | learned`) plus an optional `sourceRef`
pointing at the source stack-pack id (W2 compiler output), import bundle id
(W4), or learned-pattern id (W3). This is the field W2's per-stack agent compiler, W3's
graduation path, and W4's import-vetting all write into, so a stack pack's
history is inspectable without guessing from a git blame.

## CLI surface table

| Command | Status | Purpose |
|---|---|---|
| `keryx stack detect [--cwd <dir>] [--json] [--no-write]` | implemented (flow 309, Wave 2) | Deterministic stack detection, writes `.metaproject/data/stack/stack.json` |
| `keryx skills install --profile <p> [--with/--without <component>] [--target <harness>] [--include-deprecated] [--dry-run] [--json] [--force]` | implemented (flow 309, Wave 2) | Resolve profile→modules→components into an install plan/apply |
| `keryx skills doctor [--target <id>] [--json]` | implemented (flow 309, Wave 2) | Compare install-state to disk; report ok/drifted/missing/orphaned |
| `keryx skills uninstall --target <id> [--module <id>] [--force] [--json]` | implemented (flow 309, Wave 2) | Remove only Keryx-managed, recorded files |
| `keryx skills scout <name-or-description> [--include-imports] [--record <pack-dir>] [--candidate <dir>] [--scope bundled\|all] [--json]` | implemented (flow 309, Wave 2) | Pre-creation dedupe gate |
| `keryx skills eval <skill-id> [--strictness ...] [--trials N] [--runner <provider>] [--model-grader] [--json]` | implemented (flow 309, Wave 2) | Behavioral compliance eval, trigger-accuracy + pass-rate |
| `keryx skills stocktake [--scope bundled\|all] [--quick] [--json]` | implemented (flow 309, Wave 2) | Periodic keep/improve/update/retire/merge verdicts |
| `keryx skills create <target> --module <module> --name <skill-name>` | existing (`src/commands/skills.ts`) | Unchanged; scout-log presence becomes a prerequisite guard for stack-pack skills |
| `keryx skills verify <skill-or-target>` | existing | Unchanged freshness classification (`skill-lifecycle.mdc`) |
| `keryx skills export/sync --runtime ...` | existing | Unchanged format translation; consumed by W5 harness installs |

## Implementation notes (flow 309)

- **Module locations.** Stack detection lives under `src/stack/` (CLI surface
  `src/commands/stack.ts`). The install profile→module→component lifecycle
  lives under `src/gdskills/manifest/` (plan, apply, state, doctor,
  uninstall), fed by the bundled manifest data file
  `src/gdskills/bundled/install-manifest.json`. The three governance gates
  (scout, eval, stocktake) live under `src/gdskills/governance/`, dispatched
  from `src/commands/skills-governance.ts`.
- **`stack.json` determinism.** Re-running `keryx stack detect` on an
  unchanged tree writes a byte-identical file: the persisted `detectedAt`
  field is kept as-is whenever the content fingerprint (`inputsSha256`) is
  unchanged, so a plan built from `stack.json` is reproducible across runs
  that make no repository changes.
- **Manifest-path trigger rule.** `keryx skills install --profile <p>` still
  runs the pre-309 legacy copy (unchanged) when `<p>` is one of the four
  legacy ids (`minimal|recommended|full|custom`) and no manifest-only flag is
  present. Any manifest-only flag (`--with`, `--without`, `--target`,
  `--include-deprecated`, `--dry-run`, `--json`, `--force`) or a non-legacy
  profile id (e.g. `core`, `python`) instead routes to
  `planInstall`/`applyInstall`.
  - **`--dry-run`/`--json` on a legacy profile id (review round 1, F18).**
    `--dry-run` or `--json` alone (no `--with`/`--without`/`--target`/
    `--include-deprecated`) is itself a manifest-only flag, so
    `keryx skills install --profile minimal --dry-run` routes to the
    manifest path and previews the MANIFEST's own `minimal` profile — a
    different, independently-maintained module set than what
    `keryx skills install --profile minimal` (no `--dry-run`) actually
    installs via the legacy curated-subset installer. Rather than build a
    true legacy dry-run (no preview capability exists for that path) or
    silently let the two diverge, `installSkillsCommand`
    (`src/commands/skills.ts`) prints a note naming exactly this whenever a
    legacy profile id combines with `--dry-run`/`--json` and nothing else
    manifest-only; `--with`/`--without`/`--target`/`--include-deprecated`
    need no note since the legacy installer has no equivalent for them to
    diverge FROM.
- **v1 install destinations.** The module→file destination table in
  `src/gdskills/manifest/plan.ts` (`destinationFor`, and the roots
  `destinationRootsForTarget` shares with `doctor.ts`'s orphan scan) resolves
  only for `--target claude` and `--target keryx-shell`
  (`plan.ts`'s `SUPPORTED_TARGETS`); every other `HarnessId` the type permits
  fails `planInstall` (and, at the CLI layer, `install`/`doctor`/`uninstall`)
  with a named error before any module-level work runs, rather than
  resolving to an empty `ok` plan — and every module `kind` other than
  `rule`/`skill` (`agent-ref`, `hook-runtime`, `schema`, `doc`) still fails
  the plan with a named error per module, exactly as before.
- **Install-state path safety (review round 1 F2/F3, hardened round 2
  R2-1/R2-2).** `state.ts`'s `resolveContainedPath` is the one guard every
  place that turns a path RECORDED in install-state into a filesystem
  operation goes through (`uninstall.ts`'s removal, `doctor.ts`'s
  re-hash/orphan-exclusion, `apply.ts`'s prior-state read AND its own file
  writes). It rejects, in order: an absolute path; a raw path containing a
  literal `..` segment or a backslash at all (state is Keryx-written, so
  either means tampering, even when the path would textually normalize to
  somewhere inside the root — round 1's guard compared the raw, un-normalized
  path against the destination roots by string prefix, which let
  `.claude/skills/../../<file>` pass because it textually starts with
  `.claude/skills/`); a path whose `path.resolve`+`path.relative` normalized
  form is empty, escapes the root, or is itself absolute; a normalized path
  not under any of the target's own destination roots, compared by whole
  path segments rather than a string prefix (so `.claude/skillsX` is never
  confused with the root `.claude/skills`); and a path where ANY existing
  segment from the project root down to and including the leaf itself is a
  symlink (round 1's guard only checked the nearest existing ANCESTOR
  directory, so a destination FILE that was itself a symlink — e.g. shipped
  as `.claude/rules/<rule>.md -> ~/.bashrc` — was not caught, and `apply
  --force` would write through it to whatever it pointed at). A record
  failing this check makes the WHOLE install-state document untrustworthy
  for that call (`doctor` reports `invalidState`, `uninstall`/`apply` refuse
  the whole operation and mutate nothing). `state.ts`'s
  `readSkillsInstallState` validates a parsed document against
  install-manifest.schema.json's own `$defs/installState` (not a hand-rolled
  shape check), and `skillsInstallStatePath` rejects any target id that is
  not a bare `^[a-z][a-z0-9-]*$` component before it can reach a `path.join`
  at all.
- **`doctor`'s `orphaned` status is a warning, not a failure (R2-7).** The
  orphan scan is bounded to this target's own destination roots (never the
  whole project tree), but those roots can legitimately hold files Keryx
  never wrote — an operator's own `.claude/rules/my-own.md`, for example.
  `DoctorReport.ok` (and `keryx skills doctor`'s exit code) reflects only the
  RECORDED paths: `drifted`/`missing` (or an unreadable/unsafe
  `invalidState`) fail the command; an `orphaned` entry is reported but never
  does.
- **`install`/`doctor`/`uninstall` flag parsing (R2-8).** `--profile`,
  `--target`, `--module`, `--with`, and `--without` are hard CLI errors when
  given with no usable value — a bare trailing flag, one immediately
  followed by another flag (e.g. `--target --json`), or an empty `--flag=`
  — rather than silently falling back to a default target/profile.
- **`eval` runner requirement.** `keryx skills eval` scenarios that need a
  headless agent run report `status: "not-run"` with a reason when no runner
  capability is configured (`--runner`), rather than failing or being
  skipped silently — the eval's `verdict` reflects only scenarios that
  actually ran.
- **Stack-pack content was deferred to Wave 4** at flow 309 time, per this
  document's original scope, with one exception: `src/gdskills/bundled/
  install-manifest.json` registered a `python` profile and a
  `python-pack-module` component marked `stability: experimental` that
  resolved to zero files at the time (the Python pack itself was not yet
  authored) — installing the `python` profile succeeded and installed the
  common modules only; `full` excluded `python-pack-module` from its file
  count for the same reason. The Python pack (and three further packs) were
  authored in flow 314, Wave 4 batch 1 — see "Implementation notes: Wave 4
  batch 1 (flow 314)" below for what landed.

## Implementation notes: Wave 4 batch 1 (flow 314)

- **Packs authored.** Four stack packs now exist under
  `src/gdskills/bundled/stacks/<id>/`: `ts-js-node` and `go` (new, authored in
  flow 314), `python` (started in flow 309 as an empty-file placeholder,
  completed in flow 314), and `react` (new, `extends: ts-js-node`). Each pack
  carries `pack.json`, per-skill `SKILL.md` + `evals.json` under `skills/`,
  and a pack-level `governance/eval.json`. Skill names (from each pack's
  `pack.json` `skills` map), four rules apiece, and `migrate` coverage:
  - `ts-js-node`: `nodejs-implementation`, `nodejs-testing`,
    `nodejs-code-review`, `nodejs-build-fix`, `nodejs-esm-migration`
    (`migrate` is populated).
  - `react` (extends `ts-js-node`): `react-implementation`, `react-testing`,
    `react-code-review`, `react-build-fix`, `react-upgrade-migration`
    (`migrate` is populated).
  - `python`: `python-implementation`, `python-testing`,
    `python-code-review`, `python-build-fix`; `migrate: []` (no
    schema/version-migration concept for this pack).
  - `go`: `go-implementation`, `go-testing`, `go-code-review`,
    `go-build-fix`; `migrate: []`.
- **Per-skill behavioral evals.** Every skill under `skills/*/evals.json` is
  hand-authored with at least 10 trigger-accuracy prompts (positive and
  negative) plus at least 4 negative (should-not-trigger) cases, and at least
  one deterministic `behavior` scenario graded against `expected_behavior`.
  Presence and shape are guarded by `src/gdskills/stack-packs.test.ts`.
- **Model-backed eval runner.** `keryx skills eval --runner
  <provider>[:<model>]` is wired through `src/commands/model-eval-runner.ts`,
  which dispatches each scenario as a single-turn `runModelTurn` call (from
  `src/harness/provider/single-turn.ts`) with the skill's `SKILL.md` as the
  system prompt; a missing/unconfigured runner fails closed (`status:
  "not-run"` with a reason) rather than fabricating a result.
- **Pack-level governance eval.** Each pack's `governance/eval.json`
  (`{schemaVersion, reports[]}`) aggregates its skills' eval reports; a
  pack's `stability` may only be `"stable"` when every report's pass rate
  clears `PACK_BEHAVIOR_PASS_FLOOR = 0.8`
  (`src/gdskills/governance/eval.ts`).
- **Scout self-match exclusion.** `keryx skills scout --record
  --skill-name --candidate` now excludes the candidate's own catalog entry
  from its overlap scoring, so re-scouting an already-recorded skill surfaces
  a genuinely different neighbour instead of matching itself.
- **pack.json ↔ install-manifest stability guard.** A guard test
  (`src/gdskills/stack-packs.test.ts`) checks that a pack's `pack.json`
  `stability` and the corresponding install-manifest component's `stability`
  agree, so the two records cannot silently diverge.
- **Batch 1 results.** `ts-js-node`, `python`, and `go` are `stability:
  stable`, gate-cleared against `ollama` `llama3.1:latest` at `--strictness
  high` / `--trials 5` — every skill's report passes
  `PACK_BEHAVIOR_PASS_FLOOR`. `react` stays `stability: experimental`: its
  `react-code-review` pack's `flag-rules-of-hooks` behavior scenario scored a
  `passRate` of `0.6`, below the `0.8` floor. Stack coverage (packs with any
  authored content beyond review-only) went from 2 (NestJS/Prisma,
  React/MobX review-only) to 5 with this batch (`ts-js-node`, `python`, `go`
  full packs added; `react` gets a full pack but stays ungated pending a
  fix to the failing behavior scenario).

## Data contracts

- `schemas/install-manifest.schema.json` (this workstream) — profiles,
  modules, components, install-state. `$id:
  keryx://schemas/agent-platform/install-manifest.schema.json`.
- Stack detection output (`stack.json`) is documented inline above (§Design)
  rather than as a separate schema file in this pass; it is a small,
  stable-shape sibling of `DetectedStack` in `src/review/stack.ts` and is
  scheduled for its own schema only if W7's correctness work (gdgraph/gdctx
  fixture conventions) requires one for golden-fixture testing.
- Stack pack manifest (`pack.json`) reuses the `component` shape from
  `install-manifest.schema.json` (a pack *is* a component whose `modules`
  point at the pack's rule/skill files) — no separate schema.

## Integration points

- **W2 (agent definitions)** — per-stack reviewer and build-error-resolver
  agents are generated from a stack pack's `agent-refs.json` and rule
  content; W2's compiler reads the `provenance.origin` convention defined
  here and writes `origin.kind: generated` plus `origin.sourceRef` (the
  source stack-pack id) into the compiled definition's own `origin` field
  (`schemas/agent-definition.schema.json`).
- **W3 (self-learning loop)** — graduated learned patterns become stack-pack
  skill/rule proposals via the same `keryx skills create` + scout-gate path;
  `learned` provenance and the human-consent requirement are inherited
  unchanged from `learn.ts`'s existing apply-only-writer model.
- **W4 (portability/bundles)** — `keryx bundle export` packages installed
  modules/components (with their install-state) into a portable bundle;
  `keryx bundle import` runs a candidate external skill through the W1
  `scout` gate (dedupe) before it is added, and through W8's audit before
  `apply`.
- **W5 (multi-harness support)** — every module's `targets` list is validated
  against the unified harness capability matrix at install-plan time; a
  `hook-runtime` module may only target harnesses the matrix marks
  `native`/`adapter`.
- **W8 (harness-config security audit)** — `keryx security audit-harness`
  includes every installed skill's `scripts/` directory in its surface scan
  (secrets, command injection, unpinned dependencies) as part of its stated
  scope ("skills (scripts dirs)").

## Risks

- **Detection false-negatives on monorepos.** Extending
  `detectProjectStack`'s fail-open discipline to more signal sources
  (multiple manifest formats in one repo) risks a signal source
  disagreeing with another (e.g. a root `package.json` says no Python, a
  `pyproject.toml` two directories down says yes) — mitigated by per-signal
  uncertain contribution (§Design) rather than a single global flag, but the
  merge logic across many signal types needs its own test suite before
  Wave 4 content lands on top of it.
- **Content scale without governance discipline becomes the very thing D-7
  forbids.** Twenty-three target stacks at five skills + four rules each is
  ≈207 new files; without `scout`/`eval`/`stocktake` running *before* Wave 4
  batches (not after), this workstream risks producing catalog bloat
  indistinguishable from the drift `bundled-eval.test.ts` and
  `enforcement-claims.test.ts` already catch in miniature today (skills that
  exist but drift undetected).
- **`paths:` glob scoping is a new rule-loader behavior.** No current code
  path reads a `paths:` field on a rule file's frontmatter to conditionally
  load it — this is new loader logic, not just new content, and needs a
  correctness gate of its own before it's trusted for 23 stacks.
- **Cost of a general `keryx stack detect`.** Walking dependency manifests
  across many ecosystems (some requiring recursive workspace resolution to
  be *actually* certain, which `src/review/stack.ts` explicitly declines to
  do) means the honest v1 will report `uncertain` more often than a deeper
  implementation would — acceptable per the fail-open design, but it means
  early stack-aware profiles will over-install rather than under-install
  until walking is added as a scoped follow-up.

## Acceptance criteria

- **W1-AC1**: `keryx stack detect --json` on a repository with a
  `package.json` declaring `react` and no other manifest returns
  `tags.react: true`, `uncertain: false`, and a non-empty `matched` array
  containing `"react"`.
- **W1-AC2**: `keryx stack detect --json` on a repository whose only manifest
  is an unparseable `package.json` returns `uncertain: true` and every
  JS/TS-family tag `true`; non-JS tags stay `false` unless another signal
  marks them, and `reason` names the parse failure.
- **W1-AC3**: `keryx stack detect --json` on a workspace-root `package.json`
  (declares `workspaces`, no leaf dependencies matching any tag) returns
  `uncertain: true` for every JS/TS-family tag, with `reason` naming the
  declared workspace globs — mirroring `src/review/stack.ts`'s existing
  `workspacePatterns` behavior, generalized.
- **W1-AC4**: `docs/requirements/keryx-agent-platform-expansion/schemas/
  install-manifest.schema.json` parses as valid JSON Schema 2020-12 and
  validates at least one example manifest containing a `minimal`, a `core`,
  one per-stack, and a `full` profile.
- **W1-AC5**: For any module whose `kind` is `hook-runtime`, every entry in
  its `targets` array is a harness the W5 capability matrix marks `native`
  or `adapter` at install-plan time; a plan referencing an `unsupported`
  target fails with a named reason rather than silently installing.
- **W1-AC6**: `keryx skills install --profile <stack> --dry-run --json`
  produces a plan whose file list is reproducible (same profile + same
  `stack.json` input → byte-identical plan) and includes every module the
  profile's resolved component set requires, with no module appearing twice.
- **W1-AC7**: `keryx skills doctor` on an install-state where one recorded
  file's on-disk sha256 no longer matches its recorded hash reports that
  file as `drifted`, not `ok`, and `keryx skills uninstall` on that module
  without `--force` refuses to remove the drifted file.
- **W1-AC8**: Every rule file under a stack pack's `rules/` directory
  declares a `paths:` glob restricted to that stack's file types (verified
  by a guard test checking the glob only matches extensions listed for that
  stack in the target-stack table) and an `extends: common` marker.
- **W1-AC9**: `keryx skills scout` run against a description matching an
  existing skill's trigger space returns `decision: "use"` or `"fork"`
  (never silently `"create"`) when overlap exceeds a documented threshold.
- **W1-AC10**: `keryx skills eval <skill-id>` run at `--strictness high`
  reports both a trigger-accuracy split (true positive / false positive) and
  a per-scenario pass-rate across at least 3 trials — a single-trial boolean
  result fails schema/contract validation for the eval output.
- **W1-AC11**: `keryx skills stocktake` never emits a bare verdict — every
  `keep | improve | update | retire | merge` entry in its output carries a
  non-empty, skill-specific reason string (guard test rejects a generic
  reason reused verbatim across multiple skills in the same run).
- **W1-AC12**: Every new stack-pack skill/rule frontmatter includes
  `metadata.origin` with a value from `authored | generated | imported |
  learned`; a guard test extends `bundled-eval.test.ts`'s existing
  frontmatter checks to fail a skill missing this field once this workstream
  lands.
- **W1-AC13**: `keryx skills export --runtime claude` for any stack-pack
  skill produces a `SKILL.md` whose frontmatter still satisfies the existing
  Agent-Skills-standard constraints (`name` ≤64 chars, `description` ≤1024
  chars) after translation — export never rewrites content past those
  limits.

## Open questions

- Should `keryx stack detect` walk `workspaces` globs at all (even bounded to
  one level) as a v1.1 follow-up, given `src/review/stack.ts`'s documented
  reason for not doing so is cost/failure-mode complexity rather than
  infeasibility? Left open pending W7's correctness-first mandate (D-8) —
  detection correctness may be sequenced there instead.
- Where does the line sit between a stack pack's `security.mdc` and the
  existing generic `security-baseline.mdc`? This document says "narrowing
  allowed, widening not" but does not yet define the lint that checks it
  mechanically — deferred to the authoring-standard guard test's design in
  implementation-plan.md.
- Should `keryx skills eval`'s headless trial runs count against a project's
  existing `spawn_subagent` depth/child caps (`DEFAULT_MAX_TREE_DEPTH=3`,
  `DEFAULT_MAX_CHILDREN=16`), or does catalog governance need its own,
  separate budget ledger so a large stocktake run cannot starve concurrent
  user work? Not resolved here — deferred to the existing `keryx-multi-agent-engine`
  ledger (`src/harness/child/ledger.ts`) rather than a new one.
- Is a single `sql-db` capability with per-engine rule files sufficient, or
  does engine detection (Postgres vs. MySQL vs. Mongo) need its own marker
  set in `keryx stack detect` rather than staying a manually declared
  component? Left open; `src/gdskills/bundled/rules/core/` today ships only a
  generic, engine-agnostic `database-patterns.mdc`, so either answer is a
  strict improvement.
