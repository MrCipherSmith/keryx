# Implementation Plan

Status: draft

## Approach

One new module, `src/review/role-switches.ts`, owns the switches: the default-off roles (`review-clean-code`, `review-style`), the `reviewRoles` block of `routing.config.json`, the package's opt-in file `round-roles.json`, the pure decision "which roles of this roster are off and why", and the report line. `requiredReviewers` (src/review/coverage.ts) takes `enabledRoles` and applies the decision to the roster before the light branch and before the gates, so the light conventions fallback and diff mode see only roles that are on. Every package-bound caller passes `packageEnabledRoles(packageDir)`; `required --package` and `start` write the opt-in.

Decisions taken from the code, not from the doc text:
- Keryx writes no `required.json`: the doc's "required.json gets an excluded entry" is read as the `--json` output of `required` (which carries `excluded`), and the opt-in is persisted in a new `round-roles.json`, the way `round-depth.json` is.
- The opt-in is sticky in the package: `required --package` unions the recorded roles with its flags and rewrites the file, so a later `required --package` without the flag cannot silently drop what `start --style` recorded.
- All modes are filtered (also `--mode diff`), so the statement "without the flag the roles are not in `required`" is literal.
- A branch that changes `routing.config.json` cannot switch roles off for its own review: the config's `disabled` is ignored when scope A holds that file (the default-off roles stay off), the same rule as for project overlays (M6).
- Core roles (`NEVER_SUPERSEDED`) cannot be switched off by config.

## Steps

1. T1 module `role-switches.ts`, `requiredReviewers` option and tests.
2. T2 callers, `round-roles.json` writes, flags (`--style`, `--with-role`), `--all`/`--gating` warning, help; `review complete` report line; panel row; existing tests moved to the new default.
3. T3 docs, skill flag table, CHANGELOG; acceptance on `cp -a` copies of three vantage-frontend packages with fingerprints of the originals; verification.md.

## Risks

- Packages in flight whose dispatch includes the two roles: required gets smaller, the extra dispatches stay; nothing is newly refused.
- A project that relied on the two roles must add `--style` or `reviewRoles.enabled`; the report line and the start output say so.
- Merge with R6 (#1087): both add a line to `completeManagedReview` after the evidence line; the upserts are independent.
