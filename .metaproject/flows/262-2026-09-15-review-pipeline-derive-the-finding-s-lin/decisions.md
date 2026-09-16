# Decisions

## D0 — The anchor audit (item A, AC8): what the corpus can and cannot answer

**The criterion had to be revised, and the reason is worth keeping.** AC8 first
asked for the flow-260 report to be re-ingested under the new locator, listing
every finding whose derived line differed from the recorded one. That cannot be
performed: all 15 findings in those packages predate `quote`, so the locator has
nothing to locate and derives nothing. The criterion assumed a historical record
could be replayed through a mechanism whose input it does not contain — which is
the same shape of mistake as a reported line nobody checked.

**What was measured instead.** For every recorded finding carrying both `file`
and `line`, at the commit its own package names as the round's head: does the
file exist there, and does the line fall inside it?

| | |
|---|---|
| findings examined | 761 |
| carrying both `file` and `line` | 582 |
| anchor resolves at the recorded head | 474 |
| **file absent at that head** | **108 (18.6% of anchored)** |
| line past the end of its file | 0 |
| head not recorded, so uncheckable | 0 |

**What the 108 do and do not prove.** Three of those paths —
`src/wiki/provenance.ts`, `src/gdgraph/wiki-layer.ts`, `src/gdgraph/build.ts` —
exist in the repository today. So what is broken is not necessarily the path and
not necessarily the line: it is the PAIRING of an anchor with a head. Either the
recorded head is not the tree the finding was written against, or the anchor
came from a different state. These data cannot say which, and claiming otherwise
would be the unbacked precision this pipeline exists to remove.

It is still the failure the change addresses, because the pairing is exactly
what is checkable at ingest — the only moment both halves are in hand.

**Flow 260 specifically: all 15 anchors resolve cleanly.** For that round the
recorded lines were fine, and item A would have been insurance rather than
repair. Reported as found, per the flow's plan, which said this outcome had to
be stated and not buried.

Audit script: `/tmp/.../anchor-audit.ts`, re-runnable against
`.metaproject/flows/**/reviews/*/`.

## D1 — Related-file grouping (item D, AC6): DECLINED, with the measurement

**Decision.** `keryx review scope` will not group related files into review
units. `internal/agent/grouping.go` in `alibaba/open-code-review` is not copied.

**What it would have bought them, and why that does not transfer.** Their
pipeline reviews file by file: a change to `message_en.properties` and one to
`message_zh.properties` are two units unless something bundles them, and a
reviewer holding one half cannot see that the other half was not updated.
Grouping exists to repair a boxing that their sharding creates. Ours shards by
**domain** — `review-logic`, `review-security-code`, `review-testing-practices`
and the rest each receive the whole scoped diff — so no reviewer is ever handed
one half of a paired change.

**The measurement.** The counter-argument deserved a number rather than a
restatement, so: across every recorded review package in this repository —
**118 packages, 848 findings** — **307 findings (36%) carry a `class_scope`
spanning more than one file.** Examples run to five and seven files, across
skills, their contract schemas, and the TypeScript that reads them.

A reviewer that could not see across files could not produce those. The
enumeration is the evidence that our reviewers are already reading the change
whole, which is the property grouping would have been bought to create.

**What the measurement does NOT show, stated because it would be easy to
overclaim.** `class_scope.sites` is the enumeration of a class — every site
holding the shape — not a record of which files the reviewer had open when it
found the first one. A finding discovered in one file whose class reaches four
others would count here. So this is evidence that cross-file reasoning happens
and reaches the record; it is not a direct measurement of "a paired change was
seen whole". A direct measurement would need a corpus of paired changes with
known misses, which is the benchmark this flow explicitly leaves out of scope.

**What would reopen it.** One condition, and it is written down so the decision
is falsifiable rather than permanent: if the dispatch ever shards the scoped
diff **by file** — to fit a context window, to parallelise a large change, or
because a reviewer starts receiving a subset — grouping becomes necessary the
same day, because at that moment we acquire the boxing theirs was built to
repair. Nothing in the pipeline does that today.

**Cost of being wrong.** Low and visible. If a paired change is ever missed for
this reason, it surfaces as a finding about the unpaired half — the shape a
review round already reports — and this decision is the first thing to re-read.

Recorded against AC6, which refuses an unrecorded decision in either direction.

Evidence script: `/tmp/.../grouping-evidence.ts` (counts read from
`.metaproject/**/findings.json`; re-runnable against the corpus at any time).
