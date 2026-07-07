# Metaproject CI Protocol

Version: 0.1.1

## 1. Purpose

The CI protocol defines how CI jobs can publish normalized Metaproject artifacts
that agents and humans can read after a run.

## 2. Recommended CI Steps

```bash
gd-metapro standard validate
gd-metapro gdgraph build
gd-metapro test analyze
gd-metapro test run --changed
gd-metapro health run --changed
gd-metapro security report
gd-metapro dashboard build
```

`standard validate` is implemented in the reference CLI: it exits non-zero when
the workspace is non-compliant, so CI can fail fast before running the
module-specific steps.

## 3. Artifact Locations

CI should publish:

```text
.metaproject/gd-metapro-dashboard.html
.metaproject/data/health/artifacts/latest.md
.metaproject/data/health/artifacts/latest.json
.metaproject/data/testing/artifacts/latest.md
.metaproject/data/testing/artifacts/latest.json
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
.metaproject/data/gdgraph/artifacts/summary.md
.metaproject/data/gdgraph/artifacts/module-map.json
```

Optional:

```text
.metaproject/reports/
.metaproject/data/<module>/history/
```

## 4. Merge Gates

CI may fail a merge when:

- `health` quality gate is `fail`;
- `testing` changed-scope run fails;
- `security` gate blocks publishable artifacts;
- `tasks` contains blocked/frozen tasks that are required for the branch;
- standard validation fails for required profile fields.

The standard does not require every CI to enforce all gates. Projects should
declare gate policy in `.metaproject/README.md` or a future policy file.

## 5. PR Summaries

CI bots should post compact summaries from normalized artifacts, not raw logs.
Recommended order:

1. `health` latest Markdown;
2. `testing` latest Markdown;
3. `security` latest Markdown when publishable artifacts were checked;
4. `gdctx` summaries for large raw logs;
5. dashboard link;
6. raw logs only as secondary artifacts.

## 6. Security

CI must not publish:

- raw logs that contain secrets;
- local-only memory entries marked private;
- transient data directories that the lifecycle policy marks as local-only.
