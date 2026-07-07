# Metaproject Hooks

Hooks are local project scripts executed by selected `gd-metapro` lifecycle commands.

## git post-commit gdgraph hook

When enabled during `gd-metapro init`, the Git `post-commit` hook refreshes gdgraph only after commits that touched files relevant to the graph.

Purpose:

- keep graph artifacts current without rebuilding on every agent question;
- avoid broad raw file search when graph context is stale;
- leave generated graph storage local while versioning curated artifacts.

## git post-commit gdskills hook

When enabled during `gd-metapro init`, the Git `post-commit` hook runs lightweight project-skill verification after relevant project or Metaproject context changes.

Purpose:

- keep generated project-skills from silently drifting after code/wiki/rule changes;
- run non-mutating dry-run verification and report failures without changing files;
- write verification reports only during explicit `gd-metapro skills verify` runs or orchestrator-controlled checks;
- keep the hook local, optional and non-blocking.

## git post-commit health hook

When enabled during `gd-metapro init`, the Git `post-commit` hook runs a lightweight changed-scope Code Health check after relevant source/config changes.

Purpose:

- detect obvious type/complexity regressions close to the commit that introduced them;
- update the latest agent-readable health report for changed scope;
- avoid heavy sources in hooks: tests, audit, coverage and external providers stay manual or orchestrator-controlled.

## git post-commit testing hook

When enabled during `gd-metapro init`, the Git `post-commit` hook refreshes testing context after relevant source, test, config or documentation changes.

Purpose:

- keep `.metaproject/data/testing/context.md` aligned with test stack and conventions;
- stay non-blocking and avoid running heavy suites on every commit;
- give agents fresh context before test generation or debugging.

## git post-commit dashboard hook

When any Metaproject post-commit hook is enabled, a lightweight dashboard hook refreshes service files after the other hooks.

Purpose:

- keep `.metaproject/index.md` and `.metaproject/gd-metapro-dashboard.html` aligned with enabled modules and available service files;
- recover missing `.metaproject/metaproject.json` for older initialized projects;
- avoid generated data work: the hook runs `gd-metapro update --skip-runtime --no-tasks`, not module builders.

## git pre-push testing hook

When enabled during `gd-metapro init`, the Git `pre-push` hook runs changed-scope tests and blocks the push on failure.

Purpose:

- catch focused test failures before remote publication;
- use Testing Module related-test selection instead of always running the whole suite;
- keep blocking behavior explicit and opt-in.

## post-update.d

Executable files in `post-update.d/` run only when `gd-metapro update --hooks` is requested.

Rules:

- keep hooks idempotent;
- keep hooks project-local;
- do not require network access unless the hook clearly documents it;
- use generated data under `.metaproject/data` for outputs.
