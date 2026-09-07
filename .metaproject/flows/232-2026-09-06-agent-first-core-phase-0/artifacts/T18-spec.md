# Lint remediation specification
Version: 0.1.0

Fix lint findings in T18-lint-scope.json only, preserving runtime behavior and accepted public contracts. Use automatic fixes only on explicitly owned files. Remove unused type/import bindings carefully; preserve side-effectful initializer evaluation. For terminal ANSI control patterns and intentionally empty provider generators, use narrow documented rule exceptions when the flagged construct is required, rather than changing semantics. Never globally disable a substantive rule. Catch errors may contain secrets: do not attach unsafe cause just to satisfy preserve-caught-error; explicitly document sanitized boundary exceptions. The no-unsafe-finally finding in tui-shell.ts needs behavioral investigation, not mechanical deletion. No config/dependency changes; source scope excludes concurrent owner lanes.

Verification: owned-file ESLint and relevant existing tests; root typecheck may show unrelated concurrent issues and must be classified honestly. No global suite while RED lanes active. Report every behavior change or unresolved finding.
