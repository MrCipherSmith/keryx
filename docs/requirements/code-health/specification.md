# Code Health: technical specification

Version: 0.5.0
Status: Phase 1 + skill-owned scope loop + history trends implemented (see section 21). Complexity is a token-based approximation; AST precision deferred.

## 1. Purpose

Code Health is a Metaproject module that aggregates code quality signals,
normalizes them into a versioned finding schema, calculates health metrics at
project/module/file granularity and produces deterministic, agent-readable
Markdown/JSON reports with a quality gate suitable for orchestrators and CI.

## 2. Design Decisions (frozen for v1)

| # | Decision | Choice |
|---|---|---|
| D1 | v1 first-class sources | ESLint, TypeScript, tests, coverage, dependency audit (Core-5). Sonar and external complexity tools are pluggable adapters. |
| D2 | Scoring | Documented default formula with weights; overridable in config. |
| D3 | Quality gate | Fail on critical/P0 or regression vs baseline; warn on thresholds; else pass. |
| D4 | Baseline | Accept-current on enable; changes only via explicit `baseline update`. |
| D5 | Config location | Separate `.metaproject/health.config.json` (consistent with `gdctx.config.json`). |
| D6 | gdskills coupling | Decoupled: Code Health is a producer; gdskills consumes `latest.json` via `skills learn --from-health`. |
| D7 | Source extensibility | Typed `SourceAdapter` contract; Core-5 built in, others added through the same contract. |
| D8 | Determinism | `auto` = import-if-present else safe local run; `--strict` forbids run fallback and fails on missing required source; provenance recorded. |
| D9 | Scopes in v1 | project + module + file (mapped via gdgraph). entity/component/store and skill-owned scope in a later phase. |
| D10 | Scope metrics in v1 | finding counts, coverage, churn (git), cyclomatic complexity (token-based). |
| D11 | Source failure semantics | Sources are `required` or `optional`; missing/failed required -> fail in `--strict`, warn otherwise; optional -> skipped, no gate impact. |
| D12 | Finding schema | Versioned (`schemaVersion`) stable public contract; changes follow semver; consumers validate. |

## 3. Placement

When enabled, `gd-metapro init` should create:

```text
.metaproject/
  health.config.json
  core/
    health/
      cli.ts
      run.ts
      gate.ts
      scoring.ts
      baseline.ts
      types.ts
      sources/
        index.ts
        eslint.ts
        typescript.ts
        tests.ts
        coverage.ts
        dependency-audit.ts
      metrics/
        churn.ts
        complexity.ts
      README.md
  health/
    baselines/
      scores.json
  data/
    health/
      artifacts/
        latest.md
        latest.json
      history/
      raw/
  skills/
    health/
      SKILL.md
  modules/
    health.md
```

## 4. Configuration

Config lives in `.metaproject/health.config.json`. The manifest
(`metaproject.json`) stores only `enabled`, paths, and commands.

Default config written on enable:

```json
{
  "schemaVersion": 1,
  "sources": {
    "eslint":          { "mode": "auto",     "required": true },
    "typescript":      { "mode": "auto",     "required": true },
    "tests":           { "mode": "auto",     "required": false },
    "coverage":        { "mode": "import",   "required": false },
    "dependencyAudit": { "mode": "auto",     "required": false },
    "sonarqube":       { "mode": "disabled", "required": false },
    "complexity":      { "mode": "auto",     "required": false }
  },
  "metrics": {
    "coverageTarget": 80,
    "coverageSoftFloor": 60,
    "complexityThreshold": 10,
    "churnWindowDays": 90
  },
  "scoring": {
    "priorityWeights": { "P0": 100, "P1": 20, "P2": 5, "P3": 1 },
    "coverageWeight": 1,
    "complexityWeight": 2,
    "normalizePerLoc": 1000
  },
  "gate": {
    "failOnPriorities": ["P0"],
    "failOnRegressionDrop": 10,
    "warnOnRegressionDrop": 3,
    "failOnMissingRequiredSource": true
  }
}
```

`complexity.mode: auto` refers to the built-in token-based metric (section 9), not an
external tool. External complexity tools are added as adapters (section 5).

## 5. Sources and the SourceAdapter contract

Core-5 first-class sources: `eslint`, `typescript`, `tests`, `coverage`,
`dependencyAudit`. `sonarqube` and external complexity tools ship as adapters
through the same contract.

```ts
export type SourceStatus =
  | "available"
  | "missing"
  | "configured-but-failed"
  | "skipped";

export type RawSourceResult = {
  source: string;
  command: string | null;   // null when imported
  toolVersion: string | null;
  exitCode: number | null;
  rawPath: string;          // .metaproject/data/health/raw/<source>/<ts>.log
  content: string;
  imported: boolean;
};

export interface SourceAdapter {
  id: string;                                   // "eslint"
  detect(ctx: HealthContext): Promise<SourceStatus>;
  run(ctx: HealthContext): Promise<RawSourceResult>;
  import(ctx: HealthContext): Promise<RawSourceResult>;
  parse(raw: RawSourceResult, ctx: HealthContext): Finding[];
}
```

`HealthContext` carries: project root, config, scope selector, git info,
optional gdgraph module-map, and strict flag.

## 6. Execution modes and determinism

Per-source mode:

- `auto` - import existing report if present, else run a safe local command.
- `run` - execute the configured command.
- `import` - read an existing report only.
- `disabled` - ignore the source.

Determinism rules:

- every source result records `command`, `toolVersion`, `exitCode`, `imported`;
- `--strict` (and CI mode) forbids the `auto` run fallback: import-only, and a
  missing/failed `required` source makes the run fail;
- raw logs are always written under `data/health/raw/<source>/`.

## 7. Finding schema (versioned)

Reports carry a top-level `schemaVersion`. A normalized finding:

```json
{
  "schemaVersion": 1,
  "id": "health-eslint-no-explicit-any-src-file-ts-10",
  "source": "eslint",
  "severity": "warning",
  "priority": "P2",
  "category": "lint",
  "message": "Unexpected any. Specify a different type.",
  "file": "src/file.ts",
  "line": 10,
  "symbol": "ExampleStore",
  "scope": {
    "project": "current",
    "module": "pipelines",
    "file": "src/file.ts",
    "entity": null,
    "skill": null
  },
  "suggestedAction": "Replace any with a concrete DTO type.",
  "provenance": {
    "command": "eslint --format json",
    "toolVersion": "9.x",
    "rawLog": ".metaproject/data/health/raw/eslint/2026-....log"
  }
}
```

Default severity -> priority mapping (overridable):

| Priority | Sources / conditions |
|---|---|
| P0 | TypeScript errors; failing tests; dependency audit `critical`/`high`. |
| P1 | ESLint `error`; dependency audit `moderate`; coverage below `coverageSoftFloor`. |
| P2 | ESLint `warning`; complexity above `complexityThreshold`. |
| P3 | `info` and advisory signals (not gating). |

`scope.skill` is populated (Phase 2) from the gdskills project-skill registry;
`scope.entity` remains reserved (`null`).

## 8. Scopes and granularity

v1 computes metrics for:

- `project`;
- `module` (from gdgraph module-map when available, else top-level `src/*` dirs);
- `file`.

`skill-owned` scope is shipped (Phase 2): Code Health maps files to the owning
project-skill via the gdskills registry and emits `skill:<module>/<name>` scope
metrics. `entity/component/store` scopes remain reserved.

## 9. Scope metrics

Each scope carries:

- finding counts by severity/source/category/priority;
- `coverage` (from the coverage source, when available);
- `churn` - changed-line count over `churnWindowDays` from `git log`;
- `complexity` - cyclomatic complexity per function via a token-based scan (comment/string-stripped, function bodies located by brace matching), with
  per-scope max and count above `complexityThreshold`;
- `health_score`, `risk_score`, `trend`, `regression_score` (section 10).

Complexity and churn are computed for TS/JS in v1 (section 20).

## 10. Scoring

All formulas use `scoring` config; defaults below.

```text
risk_score(scope)   = Σ priorityWeights[finding.priority] for findings in scope
coverage_penalty    = max(0, coverageTarget - coverage) * coverageWeight
complexity_penalty  = count(functions with complexity > complexityThreshold) * complexityWeight
normalized_penalty  = (risk_score + coverage_penalty + complexity_penalty)
                      * normalizePerLoc / max(loc(scope), normalizePerLoc)
health_score(scope) = clamp(100 - normalized_penalty, 0, 100)
```

- `trend` - vs baseline `health_score`: `improved` (+Δ > 2), `regressed`
  (-Δ > 2), `stable` (|Δ| ≤ 2), `unknown` (no baseline).
- `regression_score` - `baseline.health_score - current.health_score`
  (positive = regressed).

Critical findings (P0) are always surfaced in reports independent of the
aggregate score.

## 11. Quality gate

Gate status is computed per run (default policy, overridable via `gate` config):

- `fail` if any finding has a priority in `failOnPriorities` (default `P0`),
  OR `regression_score(project) >= failOnRegressionDrop`,
  OR (`--strict` AND a `required` source is missing/failed),
  OR any configured hard threshold is exceeded.
- `warn` if `regression_score(project) >= warnOnRegressionDrop`,
  OR an optional source failed,
  OR coverage is below `coverageSoftFloor`.
- `pass` otherwise.

`gd-metapro health gate` exits non-zero on `fail` (and on `warn` only with
`--strict-warn`) for CI use.

## 12. Baseline and history

- On enable, Code Health writes an **accept-current** baseline: the current
  per-scope scores/metrics become `health/baselines/`. Legacy projects become
  actionable without requiring perfect health.
- Normal runs never mutate the baseline.
- `gd-metapro health baseline update [--scope ...]` updates it explicitly.
- Versioned baseline: `.metaproject/health/baselines/**/*.json`.
- Runtime history: `.metaproject/data/health/history/<timestamp>.json` (ignored).

## 13. CLI

Namespace: `gd-metapro health <command>`.

```bash
gd-metapro health run [--scope project|module:<name>|file:<path>]
                      [--changed] [--since <ref>]
                      [--source eslint,typescript] [--strict]
gd-metapro health status
gd-metapro health gate [--strict-warn]     # CI: exit code from gate status
gd-metapro health sources                  # list detected sources and statuses
gd-metapro health explain <file-or-module>
gd-metapro health baseline update [--scope ...]
gd-metapro health trend [--scope <scope-key>] [--limit <n>]
```

`run` pipeline:

1. Load manifest + `health.config.json`.
2. Detect sources; resolve scope; honor `--strict`.
3. Run/import each enabled source per mode.
4. Normalize findings; map to scopes via file paths and gdgraph when available.
5. Compute metrics, scores, trend, regression vs baseline.
6. Evaluate gate.
7. Write layered outputs.

## 14. Outputs

```text
.metaproject/data/health/
  artifacts/
    latest.md      # agent-facing summary
    latest.json    # full normalized report (schemaVersion)
  history/<timestamp>.json
  raw/<source>/<timestamp>.log
```

`latest.md` must include: gate status (`pass|warn|fail`); source status table
(with tool versions/provenance); top P0/P1/P2 findings; affected scopes; score
summary; trend/regression summary; suggested next action.

`latest.json` contains the full normalized findings, per-scope metrics, gate
result, and `schemaVersion`.

## 15. Service contract

```ts
export interface CodeHealthService {
  run(input: HealthRunInput): Promise<HealthRunResult>;
  status(input: HealthStatusInput): Promise<HealthStatusResult>;
  gate(input: HealthGateInput): Promise<HealthGateResult>;
  sources(input: HealthSourcesInput): Promise<HealthSourcesResult>;
  explain(input: HealthExplainInput): Promise<HealthExplainResult>;
  updateBaseline(input: HealthBaselineInput): Promise<HealthBaselineResult>;
}
```

`HealthRunResult` includes `gate`, per-scope metrics, findings, and the written
artifact paths.

## 16. gdskills integration (decoupled)

- Code Health only produces normalized findings (`latest.json`); it does not
  call gdskills at runtime.
- gdskills consumes the report:

```bash
gd-metapro skills learn --from-health .metaproject/data/health/artifacts/latest.json
```

- The `schemaVersion` is the contract between the two modules; gdskills
  validates it before consuming.
- `scope.skill` is populated from the gdskills project-skill registry; `skills
  learn --from-health` auto-resolves the owning skill and scopes lessons to it.

## 17. Init flow

`gd-metapro init` asks:

```text
Enable Code Health reports?
Y. Yes - aggregate lint, type, test, coverage, and audit signals
N. No
```

If enabled:

- write `.metaproject/health.config.json` (default config, section 4);
- create folder structure (section 3);
- write an accept-current baseline on first successful run (or immediately if
  sources are importable);
- ask about an optional lightweight hook:

```text
Install lightweight git hook for changed-scope health checks?
Y. Yes - runs only lightweight checks for changed/affected scopes
N. No - run health manually or through orchestrators
```

The hook is optional, runs only lightweight local sources, and never runs heavy
remote/import sources unless explicitly configured.

Flags: `--no-health`, `--health-strict`.

## 18. Orchestrator and CI integration

- Orchestrators run Code Health after implementation and after review fixes,
  and before the final report.
- CI uses `gd-metapro health gate --strict-warn` for a fail-fast exit code.
- The final report includes: gate status, top findings, changed-scope health,
  regressions, and whether findings were sent to `skills learn --from-health`.

## 19. Git policy

Versioned:

- `.metaproject/health.config.json`;
- `.metaproject/health/baselines/**/*.json`;
- `.metaproject/modules/health.md`;
- `.metaproject/skills/health/SKILL.md`.

Ignored:

- `.metaproject/data/health/raw/**`;
- `.metaproject/data/health/history/**`;
- `.metaproject/data/health/artifacts/latest.*`;
- `.metaproject/core/health/**/*.ts` (per existing core policy).

## 20. Language scope

v1 is TS/JS-first: complexity (token-based) and churn cover `.ts/.tsx/.js/.jsx`.
Finding sources that are language-agnostic (audit) apply regardless. Other
languages are supported later through adapters and are reported as `skipped`
when unsupported.

## 21. Implementation phases (production plan)

### Phase 1 - v1 production (frozen scope)

- `health.config.json` + init integration (`--no-health`, optional hook);
- `SourceAdapter` contract + Core-5 adapters (eslint, typescript, tests,
  coverage, dependency audit);
- versioned finding schema + normalization + severity->priority mapping;
- scopes project/module/file via gdgraph;
- metrics: finding counts, coverage, churn, complexity;
- scoring (default formula), gate (default policy), accept-current baseline;
- CLI: `run`, `status`, `gate`, `sources`, `explain`, `baseline update`;
- layered outputs + provenance + `--strict`;
- manifest, module doc, skill.

### Phase 2 - adapters and feedback (in progress)

- [x] skill-owned scope: Code Health reads the gdskills project-skill registry,
  tags findings with `scope.skill`, and emits `skill:<module>/<name>` metrics;
- [x] gdskills consumption end-to-end: `skills learn --from-health` auto-resolves
  the owning skill and scopes learned lessons to it;
- [ ] entity/component/store scopes;
- [ ] adapters: SonarQube, external complexity tools;
- [x] history-based trends: `gd-metapro health trend` over `data/health/history` snapshots.

### Phase 3 - advanced

- multi-language adapters;
- richer regression analytics and release notes;
- cross-run dashboards.

## 22. Acceptance criteria (production v1)

- `gd-metapro init` enables Code Health, writes `health.config.json`, and asks
  about the optional hook.
- `gd-metapro health run` produces `latest.md` and `latest.json` with
  `schemaVersion`, source statuses, and provenance.
- Reports include gate status and project/module/file metrics.
- Scoring, gate, and severity->priority mapping match documented defaults and
  respect config overrides.
- Missing/failed `required` sources fail the run under `--strict` and warn
  otherwise; optional sources are `skipped` without gate impact.
- Baseline is accept-current on enable and only changes via `baseline update`.
- `gd-metapro health gate` returns a non-zero exit code on `fail`.
- `latest.json` is consumable by `gd-metapro skills learn --from-health`.

## 23. Decision record

Frozen via brainstorm + interview (see [brainstorm.md](brainstorm.md) section 5).
Decisions D1-D12 are listed in section 2.
