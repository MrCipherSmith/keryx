# Flow Journal

- 2026-10-12T14:30:14.038Z - flow created
- 2026-10-12T15:25:34.689Z - frozen: 6 criteria; checksum recorded
- 2026-10-12T16:00:00.000Z - review fixes on PR #987 (acceptance-criteria text unchanged; decisions recorded here):
  - AC1 reading, refined: an object entry in a reviewer's `slices` counts as covered only when its `status` is absent or DONE, COMPLETE, COMPLETED, COVERED, OK (any case); other statuses leave the slice uncovered and are named with their ids in the retry-plan reason and the ledger gap. A driver's `slices` is an assignment list, so its entries' `status` is not read.
  - AC4 safety net now also protects files named after a required reviewer, not only a driver's reviewer; set-aside files are recorded in research.json under `setAside`.
  - `ledger build` reports id-less entries in a reply's `slices` by count in the gap, and a driver with such an entry as its own gap.
  - Not changed: a `DONE` result with unlisted slices is still accepted (pre-existing); `review-logic-verification.txt` still blocks as a reviewer-named file (conservative); the schema accepts `id: " "` while the runtime rejects it (harmless).
