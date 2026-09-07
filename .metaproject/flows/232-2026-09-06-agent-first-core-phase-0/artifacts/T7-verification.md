# T7 M01 implementation verification

- Timestamp: `2026-09-06T11:01:23Z`
- Git HEAD before parent integration: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Writer SHA-256: `03427445eed43e45fe7562971ebd464b0bed48100b2c300fa49b26ebd8706dc8`
- T5 test SHA-256: `f4f5759f0e818def06ac5544f872bdd7a562f3c807b876ff62bca128b1be9145`
- Git actions: none (`auto_commit=false`)

## TDD outcome

The preserved RED baseline was reconfirmed before implementation:

- Command: `bun test src/commands/routing-entrypoint-lifecycle.test.ts`
- Result: `0 pass`, `3 fail`
- Gdctx capture ID: `2026-09-06T10-54-11-434Z_run`

After implementation:

- Command: `bun test src/commands/routing-entrypoint-lifecycle.test.ts`
- Result: `3 pass`, `0 fail`, `91 expect() calls`
- Gdctx capture ID: `2026-09-06T10-56-02-720Z_run`

## Directly affected regression suite

- Command: `bun test src/commands/routing-entrypoint-lifecycle.test.ts src/lib/templates.test.ts src/commands/rules.test.ts src/commands/init.test.ts src/commands/update.test.ts src/ctx/orient.test.ts src/gdskills/agent-catalogue-xref.test.ts src/commands/skills-route.test.ts`
- Result: `57 pass`, `0 fail`, `416 expect() calls`
- Gdctx capture ID: `2026-09-06T10-57-16-042Z_run`

A final narrower post-refactor run covering routing, rules, orient, catalogue, skill routing, and templates also passed `46/46`:

- Gdctx capture ID: `2026-09-06T10-59-46-025Z_run`

## Type and health

- `bun run typecheck`: exit `0`; gdctx capture ID `2026-09-06T10-56-27-893Z_run`.
- `keryx health run --changed --source eslint,typescript`: gate `PASS`, score `97`, zero findings.
- `keryx health status`: TypeScript available; ESLint skipped because no project ESLint command is available.

## Shared changed-scope gate

`keryx test run --changed --strict` ran while the independently owned M10 tests were still in their RED phase. It reported `112` passing and `7` actual failing tests (`14` in the normalized failure counter). Every failure belongs to M10:

- agent tool-call budget: 2
- containment port resolver: 2
- scripts typecheck target: 2
- offline stress JSON: 1

No M01 test failed. Gdctx capture ID: `2026-09-06T10-58-39-703Z_read`. Parent owns the post-M10 integration rerun.

## Routing audit

- `graph_used`: pre-change `keryx gdgraph context` and affected queries for templates/rules/catalog/orient; the graph predates the new writer file and was not used as post-change proof because generated graph artifacts are parent-owned during concurrent work.
- `wiki_used`: index plus `components/src-lib.md`, `components/src-commands.md`, and `components/src-gdskills.md`; stale command references were verified against source.
- `ctx_used`: compact reads/searches, diff/status, and all test/typecheck captures.
- `memory_used`: accepted search for routing/index writer history; no applicable routing decision found.
- `raw_rg_used`: no.
