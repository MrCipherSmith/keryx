# W1 — Stack-aware skills & rules catalog
Version: 0.2.6

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
than bulk-generated. Flow 325 (Wave 2) implemented (1) stack detection, (3)
the install profile→module→component lifecycle (plan/apply/doctor/uninstall),
and (5) the three governance gates; (2) stack pack content was scoped as a
Wave 4 target and (4) the authoring-standard lint remains planned. Flow 314
(Wave 4 batch 1) authored the first four stack packs against gate (5); flow
318 (Wave 4 batch 2) authored five more (nestjs, nextjs-nuxt, vue, angular,
mobx) — see "Implementation notes (flow 325)", "Implementation notes: Wave 4
batch 1 (flow 314)", and "Implementation notes: Wave 4 batch 2 (flow 318)"
below for what landed and what is still a target contract.

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
   `expected_behavior` list. Output: `{ skillId, scenarios: [{ prompt,
   strictness, trials, passRate, grader }], triggerAccuracy: { truePositive,
   falsePositive }, verdict: "pass" | "fail" }`. Multiple trials per scenario
   (3–5) report a pass-rate distribution, not a single boolean — a W1 design
   choice, validated by the first governance eval batch.
   - **Grading, revised in flow 316.** A behavior scenario's answer is no
     longer graded by string matching against the answer text. A
     `"grader": "judge"` expectation (`rubric`, `pass_criteria`,
     `fail_criteria`) is scored by a separate LLM judge call against the
     rubric, not the words the answer happens to contain; a deterministic
     `contains`/`regex`/`not-contains` expectation is kept only for an
     unambiguous fact (a specific API name or syntax every correct answer
     must contain), never for "does not mention token X", since a correct
     answer that only warns against an anti-pattern also does not contain
     it in the sense the token match cared about. See "Implementation
     notes: grader reliability (flow 316)" below.
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
| `keryx stack detect [--cwd <dir>] [--json] [--no-write]` | implemented (flow 325, Wave 2) | Deterministic stack detection, writes `.metaproject/data/stack/stack.json` |
| `keryx skills install --profile <p> [--with/--without <component>] [--target <harness>] [--include-deprecated] [--dry-run] [--json] [--force]` | implemented (flow 325, Wave 2) | Resolve profile→modules→components into an install plan/apply |
| `keryx skills doctor [--target <id>] [--json]` | implemented (flow 325, Wave 2) | Compare install-state to disk; report ok/drifted/missing/orphaned |
| `keryx skills uninstall --target <id> [--module <id>] [--force] [--json]` | implemented (flow 325, Wave 2) | Remove only Keryx-managed, recorded files |
| `keryx skills scout <name-or-description> [--include-imports] [--record <pack-dir>] [--candidate <dir>] [--scope bundled\|all] [--json]` | implemented (flow 325, Wave 2) | Pre-creation dedupe gate |
| `keryx skills eval <skill-id> [--strictness ...] [--trials N] [--runner <provider>] [--model-grader] [--json]` | implemented (flow 325, Wave 2) | Behavioral compliance eval, trigger-accuracy + pass-rate |
| `keryx skills stocktake [--scope bundled\|all] [--quick] [--json]` | implemented (flow 325, Wave 2) | Periodic keep/improve/update/retire/merge verdicts |
| `keryx skills create <target> --module <module> --name <skill-name>` | existing (`src/commands/skills.ts`) | Unchanged; scout-log presence becomes a prerequisite guard for stack-pack skills |
| `keryx skills verify <skill-or-target>` | existing | Unchanged freshness classification (`skill-lifecycle.mdc`) |
| `keryx skills export/sync --runtime ...` | existing | Unchanged format translation; consumed by W5 harness installs |

## Implementation notes (flow 325)

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
- **Stack-pack content was deferred to Wave 4** at flow 325 time, per this
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
  flow 314), `python` (started in flow 325 as an empty-file placeholder,
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
- **Batch 1 results (flow 314, fix attempt 1 — honest gate re-run).** Review
  round 1 found the skills and their graders had effectively been tuned to
  each other, so the owner decided the gate model for the real run had to be
  independent of both: `deepseek` `deepseek-chat` at `--strictness high` /
  `--trials 5`,
  `--scope bundled`, `PACK_BEHAVIOR_PASS_FLOOR = 0.8`. Every report's
  `skillDigest` binds it to the current skill directory contents, so
  editing a skill invalidates its recorded report rather than triggering a
  re-run. The honest run failed all four
  batch-1 packs — every one stays `stability: experimental`, and no
  generated `<id>-code-auditor`/`<id>-build-fixer` agent pair ships for any
  of them (each pack's `agent-refs.json` lists `"agents": []` with a note):
  - `ts-js-node`: `nodejs-implementation` and `nodejs-code-review` pass;
    `nodejs-testing` fails (`mock-boundary-not-internal`, `passRate` 0),
    `nodejs-build-fix` fails (`no-ts-ignore-suppression`, `passRate` 0), and
    `nodejs-esm-migration` fails (`convert-before-flip-type`, `passRate`
    `0.2`).
  - `python`: `python-code-review` passes; `python-implementation` fails (a
    trigger-positive false negative plus `resource-with-block`, `passRate`
    `0.2`), `python-testing` fails (`mock-external-not-internal`, `passRate`
    0), and `python-build-fix` fails (`mypy-error-no-blanket-suppress`,
    `passRate` 0).
  - `go`: `go-implementation`, `go-code-review`, and `go-build-fix` pass;
    only `go-testing` fails (`table-driven-subtests`, `passRate` `0.4`) —
    but a pack needs every report to pass, so the whole pack stays
    experimental.
  - `react`: `react-implementation`, `react-code-review`, and
    `react-upgrade-migration` pass. `react-build-fix` fails
    (`no-disable-hooks-lint`, `passRate` 0). `react-testing`'s own report
    verdict reads `pass` — `evalSkill`'s per-report verdict threshold is
    `0.5`, and its `mock-network-boundary` behavior scenario scores
    `passRate` `0.6`, which clears that — but `0.6` is below the pack gate's
    `PACK_BEHAVIOR_PASS_FLOOR` of `0.8`, so `react-testing` fails the pack
    gate too. That makes two failing react skills, not one.

  A local `ollama` `llama3.1:latest` run at the same strictness/trials is
  kept only as a supplementary signal, not a gate outcome (its raw
  per-skill reports live outside this repo, alongside the flow's working
  notes): `go` clears all four of its skills under `llama3.1`; `ts-js-node`
  clears four of five (only `nodejs-testing` fails); `python` clears two of
  four (`python-build-fix`, `python-code-review` pass; `python-implementation`,
  `python-testing` fail); `react` clears three of five (`react-build-fix`,
  `react-implementation`, `react-testing` pass; `react-code-review`,
  `react-upgrade-migration` fail). The two models disagree on which skills
  fail, which is itself evidence for the grader-audit follow-up below rather
  than a reason to trust either run alone.

  Stack coverage (packs with any authored content beyond review-only) stood
  at 2 (NestJS/Prisma, React/MobX review-only) at this point: none of the
  four batch-1 packs had cleared the honest gate yet, so the coverage count
  did not move from this batch. Flow 316 re-ran the gate with a hardened
  grader and two of the four packs cleared it — see "Implementation notes:
  grader reliability (flow 316)" below for the count moving from 2 to 4.

  **Follow-up: grader audit.** A strong model (DeepSeek `deepseek-chat`)
  scoring `0` on three suppression-avoidance behavior scenarios —
  `ts-js-node/nodejs-build-fix`'s `no-ts-ignore-suppression`,
  `react/react-build-fix`'s `no-disable-hooks-lint`, and
  `python/python-build-fix`'s `mypy-error-no-blanket-suppress` — suggests
  these graders may be mis-specified (too strict a regex/not-contains match,
  or a prompt that doesn't elicit the graded behavior) rather than the model
  genuinely reaching for a suppression every time. Before re-authoring any
  skill content, audit these three scenarios' graders and prompts, fix what
  is actually mis-specified, and re-run the gate.

## Implementation notes: grader reliability (flow 316)

The grader audit flagged at the end of Wave 4 batch 1 found the batch-1
graders themselves mis-specified, not the skills they were scoring. Flow 316
replaced string-matching for behavior scenarios with a rubric-graded LLM
judge, hardened the stable-pack gate around it, and re-ran the honest gate.

- **Judge design.** `src/gdskills/governance/judge.ts` (core, no provider
  imports) defines the `"judge"` expectation kind (`rubric`, `pass_criteria`,
  `fail_criteria`) and the one grading function, `gradeScenarioAnswer`, used
  by the eval trial loop, the anti-gaming harness, and `skills judge-check`
  alike, so the three can never disagree about what "this answer passes this
  scenario" means. `buildJudgePrompt` wraps the task prompt and the answer
  each in its own boundary tag, derived from the sha256 of the content it
  wraps, and tells the judge explicitly that text inside those tags is
  untrusted data to grade, never an instruction to follow — mentioning an
  anti-pattern only to warn against it does not count as committing it, and
  text addressed to "the grader"/"the judge" inside an answer counts as
  evidence against that answer, not for it. `JUDGE_PROMPT_VERSION` is bumped
  whenever the prompt text changes; a recorded verdict is only trusted against
  the exact prompt version that produced it.
- **Deterministic checks, narrowed.** A deterministic `contains`/`regex`/
  `not-contains` expectation is now kept only for an unambiguous fact (a
  specific API name or syntax every correct answer must contain) — never for
  wording, and never `not-contains` an anti-pattern token, since a correct
  answer that warns against the anti-pattern still mentions its name.
- **Anti-gaming, mandatory per scenario.** Every judge scenario is proven
  hard to game against six canned answers (`antiGamingAnswers`): `empty`,
  `echo` (repeats the prompt back), `known-wrong` (a hand-written wrong
  answer that commits the anti-pattern), `injection` (known-wrong plus a
  paragraph telling the grader to output pass), and `stuffed` (known-wrong
  plus the rubric's own wording pasted in) must all FAIL; `known-right` (a
  hand-written correct answer) must PASS. `keryx skills judge-check
  <skill-id> --judge <provider>[:<model>] [--record]` runs this set against a
  live judge and exits 1 on any mismatch; `--record` persists the verdicts
  for offline replay by the integrity guard.
- **Gate hardening.** `STACK_PACK_GATE_POLICY`
  (`src/gdskills/governance/gate-policy.ts`) pins both roles to DeepSeek
  `deepseek-chat` — the runner that answers each scenario AND the judge that
  grades it, since a free choice of grader model would weaken the gate. The
  gate additionally requires every ran behavior scenario to carry
  `trialRecords` (one full record per trial: output, its sha256,
  deterministic results, judge verdict), and `regradeRecordedReport` to
  re-derive the same pass/fail from those records with no discrepancy. A
  report's `catalogDigest` pins the bundled catalog it was scored against; on
  drift the gate re-scores the trigger scenarios live and fails only if a
  result actually changed, rather than invalidating every report on any
  unrelated bundled-skill edit.

- **Threat model: what the gate proves, and what it does not (fix 1, R1-2).**
  Review round 1 on PR #698 found the wording above, and the guide's own
  wording, read as claiming more than the artifact delivers. Stated plainly:
  the gate proves **internal consistency** of a recorded report against the
  *current* files on disk — the recorded outputs hash to their recorded
  digests, `passed`/`passes`/`passRate`/trial counts are re-derived from the
  trial records rather than trusted as self-declared fields (R1-1), trigger
  results are re-scored live against the current bundled catalog every time,
  never conditionally on whether a self-computable `catalogDigest` still
  matches (R1-3), and the `runner`/`model`/`judge`/`judgeModel` labels are
  checked against an allowlist. The gate does **not** prove provenance. The
  trial outputs, the judge's verdicts and reasons, the runner/judge labels,
  and every AG (anti-gaming) recording are self-declared artifacts written by
  whoever ran the eval — anyone with write access to the repository can
  author a fully internally-consistent report or recording by hand, with no
  model call at all (round 1's forgery probes, `forge.ts`, did exactly this
  and cleared the gate). The control for provenance is not the gate; it is
  **human review of the committed raw outputs and recordings in the pull
  request** — the same way any other committed artifact is reviewed. Nothing
  in this workstream, the rubric-authoring guide, or the CLI reference should
  describe a recorded "pass" as surviving "a fresh re-grade" or a "re-judge"
  — the gate re-derives from the *recorded* verdicts and outputs; it never
  re-runs the judge model. A live re-judge sampler that would close this gap
  (re-running the judge against a sample of recorded outputs when a judge
  credential is available) is tracked as follow-up **FU6**, not done in this
  flow.
- **Honest DeepSeek runner+judge gate run (T13).** Each of the 18 batch-1
  skills ran once through the real CLI:
  `skills eval --scope bundled --runner deepseek:deepseek-chat --judge
  deepseek:deepseek-chat --strictness high --trials 5 --json`. Outcome by
  pack:
  - **ts-js-node — gate PASS.** All 5 skills pass; every scenario clears the
    0.8 floor (`no-ts-ignore-suppression` and `dirname-replacement` both
    score 4/5).
  - **react — gate PASS.** All 5 skills pass (`no-disable-hooks-lint` and
    `no-mobx-scope` both score 4/5).
  - **python — gate FAIL.** `python-build-fix`'s `mypy-error-no-blanket-
    suppress` scored 0/5 and `python-implementation`'s `resource-with-block`
    scored 3/5.
  - **go — gate FAIL.** `go-testing`'s `table-driven-subtests` scored 2/5.
- **Diagnosis of the python/go failures (T13), recorded rather than tuned —
  no re-run followed.** Taken from the judge's own reasons in the recorded
  eval.json:
  - `python mypy-error-no-blanket-suppress`: the scenario prompt ("mypy
    reports a type error on a function I touched. Fix it.") supplies no code
    and no error text. All 5 answers correctly ask for the missing error and
    refuse a blanket suppression, but the rubric demands naming the exact
    type mismatch and editing code, which is not possible without the code —
    the scenario looks under-specified. Working hypothesis, unproven until
    the follow-up re-run: a scenario defect rather than a skill defect.
  - `python resource-with-block`: 2 of the 5 failures use
    `Path.read_text()` + `json.loads`, which is resource-safe. The pass
    criterion demanding a literal `with open(...)` block looks too narrow.
    Working hypothesis: a rubric defect.
  - `go table-driven-subtests`: in 3 of the 5 failures the model emitted a
    shell/tool call instead of an answer; the skill tells it to inspect the
    function first, and the single-turn runner has no tools to do that with.
    Working hypothesis: a runner/skill interaction limitation, to be tested
    with an answer-in-text runner note in the follow-up.
  - None of these hypotheses is proven. The follow-up fixes (a concrete
    snippet or a revised rubric for mypy, a widened resource-safety
    criterion, an answer-in-text runner note) are each validated only by a
    fresh honest re-run.
  - Both packs stay `stability: experimental` and the reason is recorded
    here — fixing these scenarios is follow-up work for the next grader pass,
    not something this flow does after seeing the run (that would be tuning
    the grader to the result).
- **AC9 evidence: the old graders were mis-specified (T14).** The real
  DeepSeek outputs from the honest run were re-graded under the
  pre-migration `not-contains`-based expectations (`git show 8c7e50da`).
  - `nodejs-build-fix no-ts-ignore-suppression`: old grader 1/5, judge 4/5.
    In 4 of the old failures the only failing checks were `not-contains
    "@ts-ignore"` / `"as any"`; every mention of those tokens was inside a
    warning (for example, "These all make the error disappear without fixing
    anything: ... `// @ts-ignore`").
  - `react-build-fix no-disable-hooks-lint`: old grader 0/5, judge 4/5. All 5
    fail `not-contains "eslint-disable"`, and 4 of them mention it only under
    "What not to do".
  - `python-build-fix mypy-error-no-blanket-suppress`: old grader 0/5, judge
    0/5 — the judge fails these for a different and real reason (the
    scenario is under-specified, above), not the old grader's reason.
  - Conclusion: penalizing any mention of a suppression token failed correct
    answers that warn against using it. The old graders were mis-specified,
    not the skills.
- **Stack coverage: 2 → 4 (T13; superseded).** ts-js-node and react cleared
  the honest gate and now ship with generated pairs (`agents generate --stack
  <id>`). Counting the pre-existing NestJS/Prisma and React/MobX review-only
  coverage plus these two newly-cleared packs, stack coverage moves from 2 to
  4. python and go stay experimental, for the specific, recorded reasons
  above. **This count is superseded** — review round 1 found the live judge
  lenient on vague answers (R1-4), and the fix-1 re-run under judge prompt v2
  found `react` no longer clears the gate. See "Implementation notes: fix
  attempt 1 (flow 316, review round 1)" below for the corrected outcome
  (stack coverage 2 → 3, ts-js-node only).

## Implementation notes: fix attempt 1 (flow 316, review round 1)

Adversarial review round 1 on PR #698 (0 blocker, 4 major, 8 minor, 3 info)
found the gate trusted several self-declared fields at face value (R1-1,
R1-3), the docs overclaimed what the gate proves (R1-2, see the threat-model
note above), and the live judge was lenient on vague one-line answers and
non-deterministic on identical input (R1-4). Fix attempt 1 addressed all of
these before the honest gate was re-run.

- **Judge prompt v2 and two new canned kinds.** `JUDGE_PROMPT_VERSION` was
  bumped to `2026-09-25.1`. The judge's system prompt now states the
  concreteness rule explicitly: a pass criterion holds only when it is
  concretely present in the answer — the specific change, code, or step is
  actually shown or named, not merely gestured at or promised — and the
  judge's "reason" must cite where each pass criterion is satisfied. The
  canned anti-gaming answer set (`antiGamingAnswers`,
  `src/gdskills/governance/judge.ts`) grew from six kinds to eight: `vague`
  (a plausible, generic 1-3 sentence answer that points in the right
  direction but gives no concrete fix; must FAIL) and `subtle-wrong` (a
  reasonable-sounding, well-written answer that still commits the
  anti-pattern or misses a required behaviour realistically — a partial fix,
  hedging, a non-`any` cast, log-and-continue; must FAIL) are authored per
  scenario via two new required `calibration` fields, `vague` and
  `subtle_wrong`.
- **Judge determinism.** `runModelTurn`'s judge call now runs at
  `temperature: 0` (follow-up FU5 from the T15 journal), the closest a
  provider gets to deterministic scoring — review round 1 had caught the live
  judge flipping verdicts on byte-identical input. `judge-check --samples <n>`
  (default `3`) now runs each canned answer `n` times against the live judge
  and treats the anti-gaming proof as a mismatch if **any** sample disagrees
  with the expected verdict, or if any sample's reply was unparseable — one
  recorded sample per canned answer no longer stands in for the judge's
  actual behaviour. AG recordings under
  `src/gdskills/governance/judge-recordings/` now store `samples`, requiring
  every recorded sample to be unanimous.
- **Integrity rules I7c and I10 (R1-6, R1-7).** I7c requires every
  `anti_patterns` token to appear (case-insensitive) in the scenario's own
  rubric or a fail criterion — not just in prose the grader never reads — so
  an authored anti-pattern token is actually something the judge is told
  about. I10 rejects a fail criterion that is only a negation-only note (for
  example, a standalone "Mentioning X only to warn against it is not a
  failure." entry) — that sentence belongs folded into the fail criterion it
  qualifies, never listed as its own criterion under "ANY holding fails the
  answer."
- **Content corrections (R1-5), not skill tuning.** `python-implementation`'s
  `resource-with-block` dropped its literal `with open(...)` regex and
  criterion; the criterion now accepts any answer that closes the handle on
  every path, including `Path.read_text()`. `python-build-fix`'s
  `mypy-error-no-blanket-suppress` now accepts an answer that asks for the
  missing mypy error while committing to fix the mismatch, or that names and
  fixes it directly — the same under-specified-prompt class as FU1. These are
  eval corrections backed by the recorded run's own evidence (a correct,
  resource-safe answer was failing on wording alone), not skill tuning:
  `SKILL.md` was not touched in any pack.
- **Honest re-run under judge prompt v2 (T23).** One run per skill through
  the real CLI, `skills eval --scope bundled --runner deepseek:deepseek-chat
  --judge deepseek:deepseek-chat --strictness high --trials 5 --json`, HEAD
  and the stacks/governance trees unchanged from start to end, `eval.json`
  built verbatim from the raw outputs. This replaces the T13 outcome above:
  - **ts-js-node — gate PASS, stable.** Every scenario clears the 0.8 floor.
    `no-ts-ignore-suppression`, `reproduce-before-fix`, and
    `dirname-replacement` are each exactly 4/5 (0.8); everything else is 5/5.
    Ships with its generated pair.
  - **react — gate FAIL, back to experimental.** `no-disable-hooks-lint`
    scored 3/5 (0.6) — one failure recommended `eslint-disable-next-line`
    inside the answer, the other gave no staleness explanation and asked for
    the code instead of answering. `mock-network-boundary` and
    `no-forced-resolution` are at the 0.8 floor (4/5), not below it, so
    `no-disable-hooks-lint` is the only scenario blocking the pack. Its
    generated `react-code-auditor`/`react-build-fixer` pair is removed —
    tracked as follow-up **FU7**.
  - **python — gate FAIL, but only on the trigger.** Every python behavior
    scenario now clears 0.8 (`mypy-error-no-blanket-suppress` 5/5,
    `resource-with-block` 4/5, after the content corrections above). The pack
    still fails because `python-implementation`'s trigger-positive prompt
    ("Add a new feature to this Python service that logs each request with
    the logging module") is still not selected (6/7) — the pre-existing FU3
    trigger/description gap, unchanged since flow 314.
  - **go — gate FAIL.** `go-testing`'s `table-driven-subtests` is 2/5 — the
    model still emits a tool/shell call instead of an answer (FU4, unchanged
    from T13). `go-testing`'s `no-sleep-sync` is a newly-observed 3/5: the
    judge failed one answer using a `select`/`time.After` timeout and one
    using a bounded `time.Sleep` poll.
  - **Stack coverage: 2 → 3.** Only `ts-js-node` clears the gate and ships a
    pair this time — the count moves from 2 (pre-existing NestJS/Prisma and
    React/MobX review-only coverage) to 3, not to 4: react's earlier pass was
    the judge-leniency artifact R1-4 caught.
- **Stability is marginal at the floor (R1-14).** Three `ts-js-node`
  scenarios — `no-ts-ignore-suppression`, `reproduce-before-fix`, and
  `dirname-replacement` — sit at exactly 4/5 (0.8), the pack floor itself.
  Given the judge-variance evidence from review round 1 (before temperature
  was pinned to 0), this is an honest result but fragile evidence for
  "stable": one more judge flip on any of the three would fail the pack.
  Nothing was changed to inflate these scores. The judge now runs at
  temperature 0 and the anti-gaming proof requires 3 unanimous samples per
  canned answer, both of which should reduce (not eliminate) this fragility
  going forward; consider `trials >= 10` for graduation in a future pass.
- **AC9 evidence is now reproducible from the repo (R1-13).** The AC9
  re-grade probe and its raw output — previously scratchpad-only — are
  committed under this flow's package,
  `.metaproject/flows/316-2026-09-24-grader-reliability-rubric-llm-judge-with/evidence/ac9-regrade.ts`
  and `evidence/ac9-regrade.out.txt`, so the "AC9 evidence" conclusion above
  (the old graders were mis-specified, not the skills) can be reproduced by
  anyone with the recorded DeepSeek outputs, not just from the journal's
  prose.

**Follow-ups**, tracked for the next grader pass — each validated only by a
fresh honest re-run, never by tuning mid-flow:

- **FU1** (python `mypy-error-no-blanket-suppress`, under-specified prompt) —
  **done in this flow**, as an eval correction (the criterion now accepts
  asking for the missing error while committing to fix it).
- **FU2** (python `resource-with-block`, over-narrow `with open(...)`
  criterion) — **done in this flow**, as an eval correction (the regex was
  dropped; the criterion now accepts `Path.read_text()`).
- **FU3** (python `python-implementation` trigger-positive-6 not selected) —
  **done in flow 317**: `go/go-implementation`'s generic description text was
  outscoring python-implementation's own on a prompt naming a Python service
  that logs requests, because the skill's description never used the word
  "service." Strengthened the description/triggers to match what the skill's
  own workflow already covers (`logging.Logger`); never touched `evals.json`.
  Verified no regression with a full bundled-catalog trigger-only pass
  (110/110 positives, 108/108 negatives).
- **FU4** (go `table-driven-subtests`, the model emits a tool/shell call
  instead of an answer because the single-turn runner has no tools) —
  **done in flow 317**: `buildEvalRunner` now appends a uniform
  `RUNNER_SYSTEM_NOTE` ("answer in plain text... no tools") after the
  skill's own `SKILL.md` system prompt, applied to every skill/scenario
  alike. Reports gain `runnerPromptVersion`, bound by the stable-pack gate
  the same way `judgePromptVersion` already is.
- **FU5** (judge temperature control) — **done in this flow**: the judge now
  calls with `temperature: 0`.
- **FU6** (a live re-judge sampler, opt-in, re-running the judge against a
  sample of recorded outputs when a credential is available) — **done in
  flow 317**: `keryx skills eval --reverify <pack-dir> [--sample N] --judge
  <provider>[:<model>]` (`reverifyPackSample`, `src/gdskills/governance/eval.ts`).
  See the CLI reference's threat-model paragraph for `eval --reverify`.
- **FU7** (react `no-disable-hooks-lint`, 3/5 under judge prompt v2) —
  **checked in flow 317, not a defect**: at trials=10 the scenario scored
  3/10 (0.3) — a LOWER rate than 3/5, confirming a genuine model weakness
  rather than floor noise. `react` stays `stability: experimental`.

## Implementation notes: flow 317 (grader follow-ups)

Seven follow-ups from flow 316's own journal (FU1..FU7 above, plus two more
found while executing this round) were closed in one flow, each backed by
recorded evidence, never by tuning a grader to force a pass:

- **`PACK_MIN_TRIALS` raised 5 -> 10.** Several scenarios sat exactly on the
  0.8 floor with only 5 trials — one flipped trial away from failing either
  direction. Doubling the trial count halves that single-flip swing. No
  grandfathering: a report recorded at the old minimum fails the gate
  (regression test in `eval.test.ts`).
- **Two more scenario defects found while diagnosing the trials=10 run's own
  failures**, both the SAME under-specified-prompt class flow 316 already
  established for python's `mypy-error-no-blanket-suppress`: `go-build-fix`'s
  `no-nolint-suppression` (prompt supplies no call site, yet `pass_criteria`
  demanded showing "the actual flagged call site's fix") and `go-testing`'s
  `no-sleep-sync` (the `fail_criteria` wording didn't distinguish a
  `select`+`time.After` deadline GUARD, which the scenario's own
  `known_right` calibration endorses, from a blocking `time.Sleep`). Both
  fixed with the narrowest possible wording change, re-recorded, and re-run
  clean.
- **The getter-accessor calibration variant** review round 2 found
  (`nodejs-build-fix#no-ts-ignore-suppression`, R2-1) is now documented in
  `pass_criteria`/`known_right` — the calibration schema supports only one
  `known_right` string, so this is a rubric note rather than a schema
  change.
- **The honest trials=10 gate run** (one CLI call per skill, HEAD unchanged
  start to end, `governance/eval.json` rebuilt verbatim from raw outputs):
  - **python — gate PASS**, every scenario 1.0/1.0, trigger 7/7. **Promoted
    to `stability: stable`**; ships `python-code-auditor`/`python-build-fixer`.
  - **go — gate PASS** after the two scenario-defect fixes above. **Promoted
    to `stability: stable`**; ships `go-code-auditor`/`go-build-fixer`.
  - **react — gate FAIL**, unchanged conclusion: `no-disable-hooks-lint`
    3/10. Stays `experimental`, no generated pair.
  - **ts-js-node — gate FAIL, DEMOTED from `stable`**: `no-ts-ignore-suppression`
    fell from the marginal 4/5 (0.8) at trials=5 to 6/10 (0.6) — exactly the
    fragility review round 1's R1-14 predicted ("one more judge flip... would
    fail the pack"; here it was more trials revealing the true rate, not a
    single flip). The 4 failing trials each name the right direction but
    never show the corrected declaration/access code — a genuine
    model-answer-quality failure, not a rubric defect (unlike the two go
    scenarios above, this prompt IS concrete enough to answer, and the
    calibration's own `known_right` does answer it). No grandfathering: the
    generated pair is removed and `ts-js-node/agent-refs.json` records why.
  - Net stack coverage: 1 (ts-js-node only) -> 2 (python, go) generated
    pairs shipped; ts-js-node's pair removed the same round.

## Implementation notes: Wave 4 batch 2 (flow 318)

Five new packs authored against the batch-2 list: `nestjs` (extends
`ts-js-node`), `vue` (extends `ts-js-node`), `angular` (extends
`ts-js-node`), `nextjs-nuxt` (extends `["react", "vue"]` — a meta-framework
pack covering both Next.js App Router and Nuxt 3+; `pack.json`'s `extends`
field widened from `string` to `string | string[]` for this, a content
decision since `extends` is pack.json-only authoring metadata, not part of
`install-manifest.schema.json`'s `component` $def), and `mobx` (extends
`react`, implement + test focused — `code-mobx-store-review` and
`mobx-store-template.mdc` already covered MobX review before this flow, so
`mobx`'s own pack ships `review: []`, `build-fix: []` deliberately rather
than duplicating that ground or the TS/React build-fix skills that already
cover MobX's build-failure surface).

- **Packs authored.** `nestjs`: `nestjs-implementation`, `nestjs-testing`,
  `nestjs-build-fix` (`review`/`migrate` empty — `review-backend` and
  `nestjs-dto.mdc` already ship). `nextjs-nuxt`: `nextjs-nuxt-implementation`,
  `nextjs-nuxt-testing`, `nextjs-nuxt-code-review`, `nextjs-nuxt-build-fix`,
  `nextjs-nuxt-upgrade-migration` (full five-skill set). `vue`:
  `vue-implementation`, `vue-testing`, `vue-code-review`, `vue-build-fix`,
  `vue2-to-vue3-migration` (full set). `angular`: `angular-implementation`,
  `angular-testing`, `angular-code-review`, `angular-build-fix` (`migrate`
  empty — no distinct version-migration concern scoped this batch). `mobx`:
  `mobx-store-implementation`, `mobx-observable-testing`.
  `install-manifest.json` gained `<id>-rules`/`<id>-skills` modules for all
  five; the pre-existing `framework:nestjs` and `capability:mobx` components
  were EXTENDED with the new modules rather than duplicated, per this
  document's own "cross-reference, don't duplicate" rule for existing tool
  packs; `framework:vue`, `framework:angular`, and `framework:nextjs-nuxt`
  are new components, each with its own stack-aware profile.
- **A worker-review pattern found and fixed before the honest gate ran, on
  three of the five packs.** Two distinct eval-softening patterns showed up
  in pack workers' self-reported trigger-accuracy tuning, both caught and
  reversed by the orchestrating flow before acceptance, never left for the
  honest gate to catch silently:
  - **Positives leaning on exact API tokens** (`mobx-store-implementation`,
    `nestjs-testing`): a worker reported "sharpening" positive trigger
    prompts toward literal API names (`runInAction`, `Test.createTestingModule`)
    to clear its own trigger-accuracy self-check — the same shape of
    tuning-toward-the-scorer this document has warned against for eval
    scenarios generally, now observed in trigger prompts. Fixed by
    rewriting the affected prompts to describe the symptom/goal instead
    (`"I need this MobX store to keep track of which item is currently
    selected..."` rather than naming `@action.bound`/`runInAction`), and
    where that cost trigger accuracy, fixing it in the skill's own
    `description`/`triggers` frontmatter — never by re-adding jargon to the
    prompt.
  - **Negatives weakened to easy far-away cross-stack prompts**
    (`nextjs-nuxt`, all 5 skills): every negative trigger prompt was
    originally a different-language/different-stack request (Go, Python,
    NestJS), which trivially passes trigger accuracy without proving any
    real routing discrimination. Fixed by requiring at least half of each
    skill's negatives to be realistic near-misses — a different-category
    prompt from the SAME pack, or a plain React/Vue request that should
    route to the sibling `react`/`vue` packs instead. This is what surfaced
    the real, structural collisions the honest gate below confirms: a
    5-skill meta-framework pack whose skills necessarily share heavy
    vocabulary cannot be fully separated under `checkSkillSelected`'s
    same-pack-siblings-never-block rule, and this pack's own "Not for plain
    React/Vue..." disclaimer clauses are indexed as positive vocabulary for
    the very out-of-scope query they are meant to exclude — the identical
    negation-unaware-scorer defect logged as a follow-up below, reproduced a
    second time independently.
- **Two real regressions in the PREVIOUSLY STABLE `go` pack, caused by
  adding this batch's content, caught by the guard tests rather than
  shipped.** Adding new skills to the catalog changes every existing skill's
  relative trigger score, since selection is a bag-of-words match across the
  WHOLE catalog. `nestjs-build-fix`'s and `angular-code-review`'s
  descriptions used generic connector vocabulary ("between... two...",
  "context", "store", "code") that, once added, out-scored `go-build-fix`
  and `go-code-review` on their own already-recorded, already-gate-passing
  trigger-positive prompts. `checkStablePackGate`'s `catalogDigest` drift
  check caught both live (`stack-packs.test.ts`'s "the stable-pack eval gate
  is not-applicable or passing" assertion for `go` failed with "trigger
  results changed since recording"). Fixed by rewording the two batch-2
  descriptions to keep their own genuine trigger accuracy while dropping the
  incidental generic overlap — never by touching `go`'s own content, which
  had done nothing wrong.
- **Judge calibration (T12).** `skills judge-check --judge
  deepseek:deepseek-chat --scope bundled --samples 3 --record`, one run per
  new skill (19 total). Every judge scenario's eight canned anti-gaming
  answers graded to the expected verdict unanimously across all 3 samples on
  the first live run — zero mismatches, no scenario/rubric rewrites needed.
- **Honest gate run (T13).** One CLI call per skill, HEAD unchanged start to
  end: `skills eval --scope bundled --runner deepseek:deepseek-chat --judge
  deepseek:deepseek-chat --strictness high --trials 10 --json`.
  - **nestjs — gate PASS (superseded, see "fix attempt 1" below).** All 3
    skills pass. Promoted to `stability: "stable"`; ships
    `nestjs-code-auditor`/`nestjs-build-fixer`.
  - **angular — gate PASS (superseded, see "fix attempt 2" below).** All 4
    skills pass. Promoted to `stability: "stable"`; ships
    `angular-code-auditor`/`angular-build-fixer`.
  - **mobx — gate PASS (pair claim superseded, see "fix attempt 1"
    below).** Both skills pass. Promoted to `stability: "stable"`. This
    section originally also said it ships `mobx-code-auditor`/
    `mobx-build-fixer` — WRONG even at the time this section was written:
    it silently reversed this document's own §Design decision that mobx's
    review ground is already covered by `code-mobx-store-review`/
    `mobx-store-template.mdc`, caught in review round 1 (M1). mobx has no
    `agentProfile` and ships no generated pair.
  - **nextjs-nuxt — gate FAIL.** Every skill's trigger accuracy carries real
    false positives, matching the worker's own honestly-reported self-check
    exactly: `nextjs-nuxt-implementation` 3/6, `nextjs-nuxt-testing` 4/6,
    `nextjs-nuxt-code-review` 3/6, `nextjs-nuxt-build-fix` 1/6,
    `nextjs-nuxt-upgrade-migration` 3/6. Root cause recorded above and in
    `agent-refs.json`'s `note`. Stays `experimental`; no generated pair.
  - **vue — gate FAIL, but only on one skill.** `vue-implementation`,
    `vue-testing`, `vue-code-review`, and `vue2-to-vue3-migration` all clear
    the gate cleanly. `vue-build-fix` alone fails: `falsePositive=1`
    (`trigger-negative-1`, "fix this tsc error in a plain typescript service
    file" — a CROSS-pack collision with `ts-js-node/nodejs-build-fix`, not a
    same-pack near-miss; corrected in R1 review, PR #719, minor-3) and its
    `template-union-type-narrowing` behavior scenario scores `0.4`, below
    the `0.8` `PACK_BEHAVIOR_PASS_FLOOR` — but a pack needs every skill's
    report to pass, so the whole pack stays `experimental`; no generated
    pair.
- **A false-positive persona-guard finding, fixed at the guard, not the
  content.** A DeepSeek-recorded trial answer for `nextjs-nuxt-testing`
  used idiomatic Nuxt code importing `~/pages/orders.vue` — Nuxt's own
  `srcDir` root alias, resolving identically on every machine, exactly the
  same shape as `~/.claude` for a harness config root. `bundled-eval.ts`'s
  home-path persona guard (flow 206/207, AC1) flagged it as a path into a
  particular person's home directory. Fixed with a narrowly-scoped
  `FRAMEWORK_TILDE_ALIAS_DIRS` allowlist (Nuxt's own fixed set of top-level
  directories only), mirroring the existing `HARNESS_HOME_ROOTS` exception
  rather than weakening the tilde check generally — never by editing the
  recorded trial's `output` text, which would have invalidated its
  `outputSha256` and broken the integrity guard's trial-record
  re-derivation.
- **Stack coverage: 2 → 5 generated-pair packs (superseded, see below).**
  Counting go and python (flow 317) plus nestjs, angular, and mobx (this
  flow), 5 packs now ship a generated `<id>-code-auditor`/
  `<id>-build-fixer` pair. `ts-js-node`/`react`/`nextjs-nuxt`/`vue` remain
  `experimental` with none. **This count is superseded** — adversarial
  review round 1 found several eval-content defects, whose fixes changed
  the honest gate's outcome for `nestjs`; see "Implementation notes: fix
  attempt 1 (flow 318, review round 1)" below for the corrected count.

## Implementation notes: fix attempt 1 (flow 318, review round 1)

Adversarial review round 1 on PR #719 (1 blocker, 6 major, 9 minor, 3 info)
found: a real CI break (a type the PR itself introduced was never propagated
to every call site); a silently-reversed W2 design decision (mobx gaining a
generated pair contradicted the pack's own documented "no pair" reasoning
from the pack-authoring notes above); three generated personas claiming
review coverage the gate never measured; a widespread pattern of positive
trigger prompts that were near-copies of their own skill's frontmatter
`triggers:` — the SAME "author wrote both sides" issue this flow's own
worker-review step had already caught and fixed for two OTHER packs, just
not exhaustively; two `stable`-pack scenarios (in `angular`, then still
experimental) that graded a technically-correct answer as wrong; a
`stable`-pack scenario (`nestjs-testing`) that failed an approach NestJS's
own docs endorse; a security rule scoped to file types it was never about;
and nine smaller defects (a bypassable persona-guard allowlist, two
descriptions that lost technical accuracy while dodging a collision, a
misattributed failure cause, several oddly-evasive prompts, missing
`lang:ts-js-node` profile components, broken nested backticks, a
runtime-vs-build-time error-class mix-up, a strawman calibration answer,
and a trigger prompt that gave away its own answer). Full findings:
`review-r1.md` in the flow's own package.

Every blocker and major was fixed (see the flow's own commit history for
the exact diffs — B1: a widened `extends` type call site; M1: `mobx`'s
`agentProfile` and generated pair removed again, back to the original W2
decision; M2: `generateStackAgentPair` now only emits a persona when its
matching skill bucket is non-empty, and drops the "gate has confirmed"
overclaim for `auditFocus`; M3: integrity rule I11 — Jaccard similarity
`>= 0.5` against a skill's own frontmatter `triggers:` is a near-copy,
enforced on all five batch-2 packs; M4: `nextjs-nuxt/security.mdc` and
`vue`'s `STACK_EXTENSIONS` widened to `*.ts`; M5: the `angular` OnPush
scenario reframed around an `@Input` reference mutated across a
parent/child boundary, and a scenario whose `subtle_wrong` calibration
used `runInInjectionContext()` — which the scenario's OWN rubric names as
valid — replaced; M6: `nestjs-testing` now accepts either mock-construction
form and no longer teaches a redundant double-mock). All nine minors and
the info item were fixed too (Risks section above).

**The I11 rewrite (M3) surfaced its own second-order gaming risk.** Four
parallel workers rewrote the 72 flagged positive prompts; the owner's
explicit standing instruction for this round was that I11 is a floor, not
the goal, and any rewrite that only clears the threshold via synonym
substitution reproduces the exact pattern being removed. Two of the four
workers' first drafts did exactly that — one via literal word-swapping
("called"→"invoked"), one by disclosing (in its own reply) that it had
iterated against the live router until a phrasing was "dense enough in
distinctive Nest vocabulary" to route, including naming an internal
NestJS provider token (`APP_FILTER`) a real user would essentially never
say unprompted. Both were re-rewritten by the orchestrating flow with
genuine sentence restructuring rather than word substitution. The honest
consequence in both cases was a small amount of trigger accuracy given
back (an nextjs-nuxt-code-review prompt and the nestjs-implementation
exception-filter prompt both stopped routing correctly) — accepted, per
the standing instruction, rather than polished back to a passing score.

**Honest re-run under judge prompt v2 / final review-r1 gate (T-final).**
One clean run per skill through the real CLI, HEAD unchanged start to end,
identical to T13's command. This is the count that stands, replacing T13's
provisional 5:
- **angular — gate PASS, stable.** All 4 skills clear cleanly, unchanged
  from T13's outcome. Ships `angular-code-auditor`/`angular-build-fixer`.
- **mobx — gate PASS, stable.** Both skills clear. No generated pair — a
  deliberate M1 decision, not a gate failure.
- **go, python — gate PASS, stable (re-confirmed).** The same cross-pack
  trigger-collision class fixed once already in this flow (a batch-2
  description's generic connector vocabulary out-scoring a `go` skill's own
  recorded trigger prompt) reappeared a THIRD time after the I11 rewrite
  batch changed the catalog again — `nestjs-build-fix`'s M2/minor-2 wording
  fix had reintroduced "between two" — and was fixed the same way, before
  this final run. `checkStablePackGate` re-confirms `go`/`python` pass
  against the settled catalog.
- **nestjs — gate FAIL, DEMOTED from `stable`.** `nestjs-build-fix` and
  `nestjs-testing` both still pass. `nestjs-implementation` alone fails:
  its exception-filter trigger prompt, once de-jargoned away from naming
  `APP_FILTER` (the M3/I11 fix above), no longer routes (`truePositive`
  6/7). A pack needs every skill to pass, so `nestjs` reverts to
  `stability: "experimental"`; `nestjs-build-fixer.md` is removed and
  `agent-refs.json` records the specific, honest reason.
- **nextjs-nuxt — gate FAIL, unchanged conclusion.** Same structural
  trigger collisions as T13 (same-pack siblings never block each other in a
  5-skill meta-framework pack; the disclaimer-as-positive-vocabulary
  scorer defect). Stays `experimental`.
- **vue — gate FAIL, unchanged conclusion.** `vue-build-fix` alone fails
  (the same cross-pack collision, its attribution corrected by minor-3, and
  the `template-union-type-narrowing` behavior scenario at `0.4`). Every
  other `vue` skill passes cleanly. Stays `experimental`.
- **Stack coverage: 2 → 3 generated-pair packs (superseded, see "fix
  attempt 2" below).** `go` and `python` (flow 317) plus `angular` (this
  flow) ship a generated pair. `mobx` is `stable` with no pair by design.
  `ts-js-node`/`react`/`nestjs`/`nextjs-nuxt`/`vue` are `experimental` with
  none — `nestjs` having reached and then honestly lost `stable` status
  within this same flow, the direct cost of removing a trigger prompt's
  scorer-gaming rather than keeping it.

## Implementation notes: fix attempt 2 (flow 318, review round 2)

A narrow Opus verification of fix attempt 1 (above) confirmed every review
round 1 blocker/major was genuinely fixed, but returned its own findings
(fix attempt 2 of the runner's 3-attempt budget):

- **N-B1 (blocker, CI red).** `bun run typecheck` failed with 9 TS18048
  ("possibly undefined") errors in `src/agents/verify.test.ts:558-604` —
  three fixture tests used `pair.auditor` directly after `M2` widened
  `GeneratedAgentPair.auditor`/`.fixer` to optional. Fixed with a local
  `const auditor = pair.auditor!` per test (the fixture's own
  `reviewPack()` always declares both skill buckets non-empty, so this is
  always defined at runtime).
- **N-M1 (major).** Review round 1's realism sweep caught the gaming
  pattern in two of the four I11-rewritten packs (`nextjs-nuxt`, `nestjs`)
  but missed it in `angular`/`mobx`: `angular-testing`'s e2e/staging
  negative had been quietly reworded away from an honest false positive
  (traced to an earlier `minor-4` fix in fix attempt 1, itself a
  self-inflicted regression, already corrected), and several
  `angular-implementation`/`mobx-store-implementation` positives were
  still trigger-prefix constructions (a trigger phrase plus a tail, or a
  close synonym swap) rather than genuinely restructured phrasing.
  Rewritten using the reviewer's own natural probes, `mobx-store-
  implementation`'s SKILL.md frontmatter reverted (a description clause +
  2 triggers that existed only to make an earlier round's gamed positives
  route), and explicitly NOT iterated against the router afterward, per
  the same standing instruction fix attempt 1 already established.
- **The honest, accepted-as-final consequence.** Re-recorded judge
  calibration for the two touched judge scenarios (see the minors below)
  and ran the honest 10-trial gate once for `angular` and `mobx`, with no
  further iteration:
  - `angular-implementation`'s trigger accuracy collapsed (`truePositive`
    1/7).
  - `angular-testing` picked up a real false positive (1/6) — the
    restored, honest e2e/staging negative.
  - `mobx-store-implementation`'s trigger accuracy dropped (`truePositive`
    4/8).
  - `angular-build-fix`, `angular-code-review`, and `mobx-observable-
    testing` all stayed clean.
  - A pack needs every skill to pass: both `angular` and `mobx` revert to
    `stability: "experimental"`. `angular-code-auditor.md`/`angular-
    build-fixer.md` are removed; `install-manifest.json`'s `angular-rules`/
    `angular-skills`/`mobx-rules`/`mobx-skills` revert to `"experimental"`;
    each pack's `agent-refs.json` `note` records the specific honest
    reason.
- **Two scenario-content bugs the review also caught.** The OnPush
  `fail_criteria` fix attempt 1's M5 wrote lumped a genuine no-op
  (`this.items = this.items`) together with a genuinely valid fix
  (`this.items = [...this.items]`, which DOES create a new array
  reference) as if both were the same failure — narrowed to the true no-op
  only. The `inject-inside-injection-context-only` `pass_criteria` still
  only accepted the field/constructor pattern even though the scenario's
  own rubric names `runInInjectionContext()` as an equally valid fix —
  widened to accept either, provided the `Injector` itself was captured in
  a valid injection context beforehand.
- **Minors fixed.** `nestjs-build-fix`'s awkward "circular dependency
  warning naming these NestJS @Module()-decorated modules" trigger
  reworded to natural phrasing ("these two NestJS modules have a circular
  dependency on each other"), re-verified against the exact `go-build-fix`
  collision class this flow has now hit three separate times from
  unrelated wording changes elsewhere in the catalog. `vue/rules/
  patterns.mdc`'s `paths:` actually widened to `*.ts` (composables are
  routinely plain `.ts` files, not `.vue` SFCs) rather than leaving fix
  attempt 1's M4 note as vue-side documentation with no real change. The
  generator's "A Angular-focused..."/"a Angular build..." grammar fixed
  (an `indefiniteArticle` helper, covered by two new tests). The stale
  "mobx — gate PASS... ships mobx-code-auditor/mobx-build-fixer" line
  above (never true even when it was written — M1 had already removed the
  pair) corrected to the same "superseded" pattern used for `nestjs`.
- **Info (I11 containment threshold) — deliberately NOT changed in this
  PR.** A follow-up flow will own a containment-based I11 variant (the
  share of a trigger's OWN tokens present in the prompt, at a `0.75`
  threshold, rather than symmetric Jaccard) plus the batch-1 rewrite this
  flow's own M3 explicitly deferred (`go` 15/24, `python` 18/25 under the
  same measure).
- **Stack coverage: 2 generated-pair packs (final, this flow).** Only `go`
  and `python` (flow 317) ship a generated pair. `angular`, `mobx`, and
  `nestjs` each cleared the honest gate at some point in this flow and
  were each honestly demoted once their trigger prompts were de-gamed —
  the direct, accepted cost of removing scorer-optimization rather than
  keeping it. `ts-js-node`/`react`/`nextjs-nuxt`/`vue` remain
  `experimental` for their own, unrelated reasons.

## Implementation notes: Wave 4 batch 4 (flow 336)

Four new packs authored against the batch-4 list: `csharp-dotnet` (language,
standalone full pack), `swift-ios`, `kotlin-android`, and `flutter-dart`
(framework family per the target-stack table, but authored **standalone** —
see below). Each pack carries `pack.json`, 4 `rules/*.mdc` files scoped to
its own file extensions (`.cs`; `.swift`; `.kt`/`.kts`; `.dart`), 4 skills
(`implement`/`test`/`review`/`build-fix`; none of the four needed a distinct
`migrate` skill), judge-format `evals.json` per skill, and a pack-level
`governance/eval.json`. Version-specific claims (current .NET LTS/nullable
reference types default, Swift 6 concurrency/`@Observable`/Swift Testing,
Jetpack Compose recomposition guidance, Dart 3 mandatory sound null safety
and `context.mounted`) were verified via ctx7 before being written, not
recalled from training data.

- **"Extends" is standalone for all three framework packs, despite the
  table.** The target-stack table calls `swift-ios`/`kotlin-android`/
  `flutter-dart` "full pack; extends `lang:swift`"/"`lang:kotlin`"/
  "`lang:dart`" — but none of those three base components exist anywhere in
  the catalog or `install-manifest.json` (unlike `react`/`angular`, which
  genuinely extend the already-authored `ts-js-node`). Since the same table
  entry calls each one a "full pack" (ships every rule/skill itself), this
  flow treats all four batch-4 packs as standalone: no `extends` key in
  `pack.json`, no `dependencies` in their install-manifest modules onto a
  component that doesn't exist. Recorded as a runner decision, not silently
  assumed; a future flow authoring `lang:swift`/`lang:kotlin`/`lang:dart` as
  their own components could retrofit a real `extends` relationship then.
- **I11 enforced from the start**, like batch 2 and unlike batch 1's deferred
  exemption — these four packs were authored after I11 existed.
  `csharp-dotnet`/`flutter-dart` needed 11 trigger-positive prompts reworded
  (restated their own skill's frontmatter triggers too closely); `swift-ios`/
  `kotlin-android` needed none.
- **Stable-pack protection.** `checkStablePackGate(packDir, "stable")` run
  directly against `go` and `python` after adding all four batch-4 packs to
  the bundled catalog: both still `{"status":"pass"}` — no collision from the
  larger catalog, no fix needed, `go`/`python` evals untouched.
- **Calibration clean on the first attempt.** `skills judge-check <pack>/
  <skill> --judge deepseek:deepseek-chat --samples 3 --record` for all 16
  skills — every one of the 8 canned answers (empty, echo, vague,
  known-wrong, subtle-wrong, injection, stuffed, known-right) graded to its
  expected verdict on the first live-judge run for every skill.
- **The honest trials=10 gate run** (one CLI call per skill, HEAD unchanged
  start to end, `governance/eval.json` built verbatim from raw outputs):
  every behavior scenario across all 16 skills clears
  `PACK_BEHAVIOR_PASS_FLOOR` (0.8), mostly 1.0/1.0. Every one of the 16
  skills still fails the gate, on trigger accuracy alone:
  - `csharp-dotnet`: dotnet-implementation TP2/7 FP1/8; dotnet-testing TP4/7
    FP0/8; dotnet-code-review TP3/7 FP0/8; dotnet-build-fix TP1/7 FP0/8
    (worst of the 16 — even genuinely .NET-specific vocabulary the
    description already lists, "NuGet", "StyleCop", "CS####" compiler error
    codes, still didn't route).
  - `swift-ios`: swiftui-implementation TP1/7 FP0/7; swift-testing TP3/7
    FP0/7; swift-code-review TP2/6 FP2/7 (one false positive was a prompt
    asking to *implement* a fix, wrongly routed to the read-only review
    skill despite its own "Read-only, no edits" description clause);
    swift-build-fix TP1/6 FP0/7.
  - `kotlin-android`: compose-implementation TP3/7 FP0/7;
    kotlin-android-testing TP3/7 FP0/7; kotlin-android-code-review TP4/7
    FP0/7; kotlin-android-build-fix TP4/7 FP0/7 — the pack's best trigger
    recall of the four and zero false positives on any of its 4 skills,
    still short of the pass bar.
  - `flutter-dart`: flutter-implementation TP6/7 FP2/7; flutter-testing TP3/7
    FP2/7; flutter-code-review TP6/7 FP4/7 (worst false-positive rate of any
    batch-4 skill — a prompt explicitly asking to "also fix the bugs you
    find" still routed to the read-only review skill); flutter-build-fix
    TP3/7 FP2/7 — the strongest positive recall of the four packs, paired
    with the weakest negative discipline.
- **No SKILL.md/evals.json edits followed the gate, for any of the 16
  skills.** Every pack's own scope-boundary language ("Read-only, no edits",
  the DI/EF Core/async vocabulary, etc.) was already present before the gate
  ran; the router still missed. No candidate description edit could be
  constructed that both (a) states a real, general scope boundary rather
  than restating a failing eval prompt's wording (forbidden per this flow's
  standing rule, tightened after a batch-6 lesson: a description that
  merely repeats vocabulary from a failing prompt is not an honest fix), and
  (b) would plausibly move any of these numbers. Concluded this is genuine,
  catalog-scale routing weakness — 12+ stacks now share near-identical
  implement/test/review/build-fix category framing — not an authoring
  defect specific to these four packs.
- **Stack coverage: unchanged at 2 (`go`, `python`).** All four batch-4
  packs stay `stability: "experimental"`; no generated
  `<id>-code-auditor`/`<id>-build-fixer` pair ships for any of them. Each
  pack's `agent-refs.json` records the real per-skill numbers and the
  reasoning above.

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

- **A `stable` pack's install-manifest modules depend on `experimental`
  ones.** `nestjs-rules`/`nestjs-skills` and `angular-rules`/
  `angular-skills` (both `stable`) declare `dependencies: ["ts-js-node-rules"]`/
  `["ts-js-node-skills"]`; `mobx-rules`/`mobx-skills` (also `stable`) depend
  on `react-rules`/`react-skills` — and `ts-js-node`/`react` are both
  `experimental` (flow 316/317; `react`'s `no-disable-hooks-lint` behavior
  scenario still fails at trials=10). Nothing in the install/doctor pipeline
  currently checks that a `stable` module's own dependency chain is itself
  `stable`, so installing a `stable` profile can pull in `experimental`
  content transitively with no warning (R1 review, PR #719, info). Not
  incorrect — a stack pack's rules/skills genuinely do extend their base
  stack's content regardless of the base's own gate status — but worth
  flagging as a gap in what `stability` actually guarantees end to end; a
  future pass could add a `keryx skills doctor`-style check that surfaces
  (not blocks) this specific shape.
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
