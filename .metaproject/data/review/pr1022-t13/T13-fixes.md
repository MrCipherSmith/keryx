# T13 — targeted fixes after independent review

Baseline reviewed: `3cf3b2c65afe38621f6f1a60decfc6e457d57f9a`.
Status: fixes implemented and independently inspected; execution pending GitHub CI.
This report supplements T13-interim.md; it is not an overall approval or closure.

## Changes

- Projection separates informational semantic fallback from source withholding.
- Archive reuse validates newline offsets with a forward cursor instead of
  repeatedly decoding the full preceding prefix.
- Writer contention before mutation has a distinct error and does not poison
  the retained lifecycle; uncertain mutation and integrity errors stay fail-closed.
- Generic file inventory, admission and final confirmation exclude session-store
  subtrees using lexical and canonical paths, including data-directory aliases.
- Enabled hybrid without an embedding owner is explicitly gated. Disabled hybrid
  remains inert. This is not production embedding-provider wiring.

Regression tests were added for all five fixes. Independent static re-review
found no remaining blocker in these targeted changes; it ran no tests or tsc.
Its report is raw/fixes-static-review.txt in the local review evidence directory.

Remaining: CI for the published fix head, complete role/slice coverage and review
research gates, and the previously recorded restart/race/no-write test gaps.
Large single-line complexity and separate-process contention coverage also remain.
