# Dependency advisories, before and after

The phase 8 criterion asks for the before/after inventory and the advisory
paths to be preserved. They were not, and an independent review found that
nothing in the repository held them — the task was recorded done with no
evidence of any kind. This is that record, reconstructed from the one surviving
artifact, with what could not be reconstructed named as such.

## The two counts that disagreed

The task title said "14 P0 and 13 P1", which is 27. The closing note said 28.
Both were counting correctly and neither was complete: the true figure is **28
findings — 14 P0, 13 P1, and one P2** that the title did not mention. Nobody
was wrong; one number silently dropped a severity.

## Source of this record

`.metaproject/data/health/history/2026-09-06T20-11-30-148Z.json` —
`generatedAt: 2026-09-06T20:11:46Z`, `gitRef: 0bc6418`, produced by
`bun audit --json` (bun 1.3.12), `execution: completed`, `parse: parsed`,
`exitCode: 1`, `status: available`. It is the only snapshot of the pre-remediation
state that survives: of 45 health snapshots carrying a `dependencyAudit` source,
44 report zero findings and this one reports 28.

That single artifact is the whole of the surviving evidence, which is itself
worth recording — the inventory was preserved by accident rather than by
design, and one retention sweep with a shorter policy would have removed it.

## Before — 28 advisories across 7 packages

| package | findings | priority | severities |
|---|---|---|---|
| `protobufjs` | 11 | 6× P0, 5× P1 | critical, high, moderate |
| `fast-uri` | 6 | 6× P0 | high |
| `hono` | 4 | 3× P1, 1× P2 | low, moderate |
| `ip-address` | 3 | 1× P0, 2× P1 | high, moderate |
| `qs` | 2 | 2× P1 | moderate |
| `@hono/node-server` | 1 | 1× P1 | moderate |
| `sharp` | 1 | 1× P0 | high |

The single P2 is a `hono` low-severity advisory. It is the finding the task
title omitted.

## After

`bun audit` → **No vulnerabilities found**, exit 0. Confirmed through the
product's own path as well: `keryx health run --source dependencyAudit` →
`available | exit 0 | findings 0`, command `bun audit --json`.

Not a fabricated clean: `bun audit --json` on a clean tree emits `{}`, which the
adapter classifies as `{valid: true, format: "bun"}` — the genuine zero-advisory
shape, distinct from the ENOLOCK payload that `npm audit` produces in this
project and which parses to zero findings for every severity without ever
having run.

`"dependencies": {}` is intact. Every advisory was resolved through `overrides`,
so no top-level dependency was added.

## Advisory paths, and the two that leave the declared range

| override | requester's declared range | pinned | inside range? |
|---|---|---|---|
| `fast-uri` `^3.1.6` | `ajv` wants `^3.0.1` | 3.1.7 | yes |
| `ip-address` `^10.3.1` | `express-rate-limit` wants `^10.2.0` | 10.7.0 | yes |
| `hono` `^4.12.34` | `@hono/node-server` peer `^4` | 4.13.7 | yes |
| `@hono/node-server` `^1.19.15` | MCP SDK wants `^1.19.9 \|\| ^2.0.5` | 1.19.17 | yes |
| `qs` `^6.16.0` | — | 6.16.0 | yes |
| **`protobufjs` `7.6.6`** | `onnx-proto@4.0.4` declares `^6.8.8` | 7.6.6 | **no — major jump** |
| **`sharp` `0.35.4`** | `@xenova/transformers@2.17.2` declares `^0.32.0` | 0.35.4 | **no — breaking under 0.x** |

The last two are the untested combinations, and they are exactly the two entries
in `trustedDependencies`. `protobufjs` 6→7 is the major incompatibility the
criterion asks to have a migration step recorded for; no such step exists.

**Nothing exercises either.** `@xenova/transformers` is a devDependency,
`src/capability/no-optional-imports.test.ts` asserts it is never statically
imported, and its only dynamic loader is a benchmark script that appears in no
CI job. So "untested combination" is an accurate record and not a hedge — the
residual risk is that a break can only ever be found by hand.

## What could not be reconstructed, and is therefore open

- **Per-group packaging and regression evidence.** The criterion asks for it; no
  artifact holds it and the remediation is not separable into groups after the
  fact.
- **A migration step for `protobufjs` 6→7.** Named above, absent.
- **The advisory identifiers.** The surviving snapshot carries advisory ids in
  its finding ids (e.g. `health-dependencyAudit-advisory-1139322-…`), so the
  paths are recoverable from it, but the raw `bun audit` payload that named the
  dependency chains was not preserved.

The criterion is **partially met** and should be recorded that way. What is
verified is the end state and the override set; what is missing is the
per-group evidence and the migration record.
