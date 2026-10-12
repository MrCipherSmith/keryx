# Implementation Plan

Status: draft

## Approach

The board is a pure function of the product index (`IntentIndex`, `src/product/types.ts`): no clock, no randomness, no new store. One new command, `keryx product map`, builds it; `keryx dashboard build` calls the same builder, and the TUI `/product` surface renders the same model. The header counters reuse the functions behind `openHeaderLines` so the surfaces cannot disagree. Staleness uses the existing content-fingerprint check (`checkStaleness`).

## Steps

1. Board model in `src/product/`: columns, counters, contradictions, card fields; unit tests for each edge case (AC6).
2. `product map` command (text and `--format html`), stale or missing index refusal, determinism test, invariant test that it gates nothing (AC1, AC3, AC4); descriptors, help, usage and `bulk-budget.test.ts` (AC7).
3. Dashboard integration through `buildDashboard()` (AC8).
4. TUI board view in the `/product` surface, readline text form, sidebar, menu and slash entry (AC9).
5. Docs, CHANGELOG, version bump, PR, review, release, npm smoke (AC10-AC12).

## Risks

- `bulk-budget.test.ts` forbids `map` today; the edit must stay narrow and keep `admit`, `show`, `list` refused.
- The TUI `/product` surface may need scrolling for a long "effect not verified" column.
- It is not yet verified how `dashboard build` consumes data; step 3 starts by reading it.
