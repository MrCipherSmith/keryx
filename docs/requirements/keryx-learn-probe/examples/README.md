# Learn Probe Artifact Examples
Version: 0.2.0

## Scope

Synthetic documentation fixtures, not model measurements and not a runtime
implementation. [Task set](task-set.json) references repository paths for shape
illustration only; the checker does not create/remove worktrees. [Bundle](artifact-bundle.json)
contains plan, immutable comparison and finalized mutable checkpoint. The plan
hash uses UTF-8 JSON.stringify(plan) plus newline as fixture bytes. Task-set hash
uses the actual checked-in file bytes. Every runtime hashes its own exact plan bytes.

## Reproducible local check

From project root, with existing Bun and no installs/network:

```sh
bun docs/requirements/keryx-learn-probe/examples/validate.ts
```

[Checker](validate.ts) imports the existing project Draft-2020-12 subset validator
and link parser. It checks all four schemas' references and supported keyword
coverage, positive nested fixtures, every verdict/reason branch and negative
mutations (null shapes, reasons, paths, budgets, digests, checkpoint finalization).
Selected semantic checks cover identity/hash linkage, aggregates and uniqueness;
JSON Schema alone cannot prove arithmetic or crash/idempotency semantics.
Output/late-drift examples are constructed in memory: measured improved may
coexist with skipped/environment-drift finalization, never a comparison rewrite.
No runtime/test/source files are changed. This checker is documentation tooling,
not the future probe implementation. Required runtime AC tests remain planned.

## Index

- [Package README](../README.md)
- [Immutable plan schema](../schemas/probe-plan.schema.json)
- [Mutable checkpoint schema](../schemas/probe-checkpoint.schema.json)
- [Comparison schema](../schemas/probe-comparison.schema.json)
- [Task set schema](../schemas/probe-task-set.schema.json)
