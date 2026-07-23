# Implementation Plan

Status: done

## Approach

Extract a pure `selectBoxHeight(count, withDescription, max)` helper that returns
enough rows for every item to survive `floor(height / linesPerItem)`, and use it
for the described provider picker. Add a regression test asserting the invariant.

## Steps

1. Confirm root cause in `@opentui/core` (`linesPerItem = showDescription ? 2 : 1`,
   `maxVisibleItems = floor(height / linesPerItem)`). [done]
2. Add exported `selectBoxHeight`; size the provider picker with it +
   `showScrollIndicator`. [done]
3. Regression test: `floor(selectBoxHeight(n, true)/2) >= n`, cap, non-zero. [done]
4. Verify: tsc clean, full suite green (+1 test, no regression). [done]

## Risks

- Over-tall box on many providers → capped at `max=16`, overflow scrolls.
