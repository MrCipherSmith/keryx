# Implementation Plan

Status: approved (autonomous run; decisions recorded in journal.md)

## Approach

Three new, loosely coupled modules plus CLI wiring, built in parallel lanes
with disjoint files, then a small authored pack that exercises everything.

### Lane A — stack detection (`src/stack/`)
- `src/stack/detect.ts`: `detectStack(cwd, opts)` → `StackDetection`
  `{schemaVersion:"1.0.0", detectedAt, tags, uncertain, reason, matched, perSignal[]}`.
  Tag registry (`STACK_DETECT_TAGS`) with a family per tag (`js`, `python`,
  `go`, `rust`, `jvm`, `dotnet`, `swift`, `dart`, `php`, `ruby`, `c-cpp`,
  `infra`, `ci`, `sql`). Signals: manifests (package.json, pyproject.toml,
  setup.cfg, requirements.txt, go.mod, Cargo.toml, pom.xml,
  build.gradle(.kts), *.csproj/*.sln, Package.swift, pubspec.yaml,
  composer.json, Gemfile) and markers (Dockerfile, docker-compose.yml, *.tf,
  .github/workflows/*.yml, .gitlab-ci.yml, *.sql). Root-level manifests only
  (no workspace walking, per the spec's open question), plus a bounded
  marker/extension scan (depth ≤ 3,
  skip node_modules/.git/dist/vendor/.metaproject, sorted, capped file count;
  a cap hit marks the extension-derived tags uncertain). package.json logic
  reuses `src/review/stack.ts` semantics (workspaces / no deps / unparseable
  → JS family uncertain). Per-signal uncertain contribution: a failed signal
  sets only its own family's tags to `true` and uncertain.
- Determinism: all lists sorted; `detectedAt` is kept from the existing
  `stack.json` when the content fingerprint (`inputsSha256` over everything
  except `detectedAt`) is unchanged, so a re-run writes a byte-identical file
  and prints identical JSON. No network/model imports.
- `src/commands/stack.ts` (`keryx stack detect [--cwd] [--json] [--no-write]`),
  registered in `src/cli.ts`; zone entry in `src/lib/import-zones.ts`.
- `src/review/stack.ts` stays unchanged (review dispatch keeps its 7 tags);
  a mapping helper `toReviewStack()` is NOT wired in this flow.

### Lane B — install manifest (`src/gdskills/manifest/`)
- `src/gdskills/bundled/install-manifest.json` (schemaVersion 1.0.0):
  profiles `minimal`, `core`, `react`, `nestjs`, `python`, `full`; modules
  pointing at EXISTING bundled skills/rules (e.g. review-frontend,
  mobx-store-template, review-backend, nestjs-dto) plus the new python pack;
  components `lang:ts-js-node`, `framework:react`, `framework:nestjs`,
  `capability:mobx`, `lang:python` with detectionMarkers + provenance.
- Schema validation via the repo's existing JSON-schema validator (the one
  W5-b/W8 use); schema copied/loaded from
  `docs/requirements/.../schemas/install-manifest.schema.json` (a test pins
  the bundled copy to it if a copy is needed for packaging).
- `plan.ts`: resolve profile → modules + components (stack-detection-aware
  intersection using `stack.json`/`detectStack`; uncertain → include all),
  `--with/--without`, dependency closure, dedupe, deterministic sort; per
  target destination table (v1: `claude` → `.claude/skills/<name>/SKILL.md`,
  `.claude/rules/<file>`; `keryx-shell` → `.metaproject/skills/gdskills/...`,
  `.metaproject/rules/...`); unknown destination or matrix-`unsupported`
  target → plan error; `hook-runtime` module target must be matrix
  `native|adapter` (via `generateCapabilityMatrix()` in-process).
- `apply.ts`, `state.ts`, `doctor.ts`, `uninstall.ts`: install-state at
  `.metaproject/data/skills/install-state/<target>.json` (schema
  `installState`), sha256 per path, `_keryxManaged` sentinel recorded as
  boolean; doctor ok/drifted/missing/orphaned; uninstall recorded +
  hash-matching only, drifted needs `--force` and prints a diff first.
- CLI: extend `keryx skills install` — manifest path when any of
  `--with/--without/--target/--dry-run/--json` is given or the profile is a
  manifest-only id (`core`, stack ids); legacy path unchanged otherwise.
  New `keryx skills doctor`, `keryx skills uninstall`.

### Lane C — governance (`src/gdskills/governance/`)
- `catalog-index.ts`: loads bundled + `.metaproject/skills/gdskills/` skills
  (id, category, name, description, triggers, body, origin, sha256).
- `authoring-lint.ts`: rules from the standard; `metadata.origin` parsed via
  `skill-frontmatter.ts` (extended additively with `metadataOrigin`).
- `scout.ts`: deterministic token-overlap score (documented thresholds:
  ≥0.55 `use`, ≥0.30 `fork`, else `create`); `--record <pack-dir>` appends to
  `<pack>/governance/scout.json`; `--include-imports` reports W4 absent;
  `--candidate <path>` runs W8 `runHarnessAudit` on the candidate dir.
- `eval.ts`: eval spec `evals.json` next to a SKILL.md or synthesized from
  frontmatter (positives from triggers/description, negatives from other
  categories' triggers); trigger grader = deterministic router scoring;
  behavior scenarios graded by deterministic graders
  (contains/regex/not-contains) over a `Runner` output; runner injectable,
  CLI runner only when `--runner <provider>` capability given, else
  behavior scenarios `not-run` with reason; model grader only with
  `--model-grader` + capability. Output contract validated (high strictness
  ⇒ trials ≥3); pass@k reported.
- `stocktake.ts`: per-skill verdict from lint + scout overlap + lifecycle
  freshness + eval; reason always cites skill-specific evidence; cache at
  `.metaproject/data/skills/stocktake/cache.json` keyed by content sha256;
  report at `.metaproject/data/skills/stocktake/<date>.json`.
- CLI subcommands `keryx skills scout|eval|stocktake` with `--json`.

### Lane D — minimal pack + guards (after A–C)
- `src/gdskills/bundled/stacks/python/`: `pack.json` (component shape,
  stability experimental), `rules/coding-style.mdc` (`paths: ["**/*.py"]`,
  `extends: common`, `metadata.origin: authored`), one skill
  `skills/python-testing/SKILL.md`, `agent-refs.json` (empty list),
  `governance/scout.json` recorded by the real scout.
- Guard tests: stack rule paths/extends, stack skill scout-record presence,
  stable-pack eval-verdict presence, strict lint + origin on stack content,
  export limits (AC13).

## Steps (tasks)
T1 context (done by orchestrator) → T5/T6/T7 lanes A/B/C in parallel →
T8 pack + guards → T9 verification: determinism (AC4) → T10 verification:
gates on bundled catalog (AC14) → T11 docs (W1 spec status, CLI help) →
T4 review/PR.

## Risks
- Shared-file conflicts: `src/cli.ts` (A only), `src/commands/skills.ts`
  (B and C both touch — C adds its subcommands via a separate
  `src/commands/skills-governance.ts` dispatcher; B edits install/doctor/
  uninstall branches). Help/grouping tests may need updates.
- Legacy `--profile minimal|full` name clash — resolved by flag-triggered
  manifest path.
- Eval over 72 skills may show poor trigger accuracy — that is a finding
  recorded, not a failure of the gate.
