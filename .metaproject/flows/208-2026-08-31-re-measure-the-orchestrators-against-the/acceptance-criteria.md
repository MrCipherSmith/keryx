# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The four orchestrators — `review-orchestrator`, `flow-orchestrator`, `job-orchestrator`, `task-implementer` — are inventoried by the SAME method Phase 7 used: every documented mechanism classified `wired` / `prose-only` / `advisory`, with the search that established it, and a call site found only in a test counted as `prose-only`.
- AC2: The result is stated as a **before and after**. The August measurement — `review-orchestrator` 2 of ~10 enforced, 34 unfinished tasks across 24 flows shipped behind one false sentence, `job-orchestrator` 6 of 217 — is the baseline. A number with no prior is not a measurement of improvement.
- AC3: Every claim of improvement names the commit or release that produced it. "It got better" without a diff is the class of assertion this whole programme exists to remove.
- AC4: The market comparison names each competitor, the version or date observed, and the source. A comparison against a competitor's marketing page is labelled as such and not reported as a capability finding.
- AC5: The comparison distinguishes **what was verified by running it** from **what was read**. We cannot run Spec Kit, Kiro or BMAD end to end here, and the report must say so rather than implying a head-to-head that did not happen.
- AC6: Any dimension where a competitor is **ahead** is reported with the same prominence as one where we are. A comparison that finds only favourable results is a marketing document, and its own method should be distrusted.
- AC7: The frozen-acceptance-criteria claim — that no comparable tool confirms criteria by evidence and that ours are checksum-protected — is re-verified rather than restated from the August note. Competitors change.
- AC8: The report states plainly what it does NOT establish. Specifically: no shared-task head-to-head was run, so no recall or precision number comparing tools is claimed.
- AC9: Where the programme's own instrumentation can now answer a question the August study could not, the answer is given with the instrument named (`keryx skills verify --bundled`, `filter_stats`, the review gate's five conditions, the build-parity guard).
- AC10: The output is a durable artifact under `docs/requirements/keryx-orchestrator-hardening/`, not a chat summary, so the next re-measurement has a baseline to diff against — which is exactly what the August study failed to leave.
- AC11: `bun run check:doc-links` 0 broken; any new document is linked from the requirements package index.
