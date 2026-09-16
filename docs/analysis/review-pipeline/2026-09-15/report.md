# The review pipeline: four gaps, measured against our own records

Written 2026-09-15 against keryx `main` at `b618e466` (22 bundled review skills,
0 project-local). Every number below is read off this repository's own review
packages or run against its own code; nothing here is an estimate.

The four items became flow 262. Items A–C shipped in 0.2.107; item D was decided
and declined, with the measurement recorded in that flow's `decisions.md`.

---

## Where our determinism sits, and where it does not

Our review logic lives in **22 markdown reviewer skills**, dispatched as parallel
subagents by whichever agent is driving. The deterministic half is not the
reviewing — it is the **perimeter**: `review scope` bounds what enters a round,
`review blast-radius` bounds what it may look at, `review ingest` bounds what it
may claim afterwards, and the flow completion gate bounds what may be called
done.

That division is deliberate and it is the right one for us. What the four items
below have in common is that they are all places where the perimeter had a hole:
something entered, or was claimed, without anything checking it.

---

## A — `line` was a claim nobody checked

**What it was.** `src/gdskills/contracts/review-finding.schema.json` took `file`
and `line` as reviewer assertions, both nullable, and `review ingest` verified
neither against the tree. On a fix round the file has moved under the finding
*by construction* — which is exactly when the anchor is least trustworthy and
most consequential.

**How big.** An audit of every recorded review package in this repository:

| | |
|---|---|
| findings examined | 761 |
| carrying `file` **and** `line` | 582 |
| anchor resolves at the package's own recorded head | 474 |
| **file absent at that head** | **108 (18.6%)** |
| line past the end of its file | 0 |

Three of those paths exist in the repository today, so what is broken is the
**pairing** of an anchor with a head, not necessarily either alone. The data
cannot decompose it further, and claiming otherwise would be unbacked.

**What shipped.** The reviewer quotes the code instead of counting lines, and
`review ingest` derives the line by locating that quote at the commit the round
records. Exact match, then whitespace-collapsed, then `unlocatable`. A quote
matching twice is never anchored to the first hit.

**What it found in its own first use.** The round was ingested after its fix
commit had rewritten the quoted lines, and five of six came back `unlocatable` —
true of the working tree, useless about the round. Re-checked at the recorded
head, six of six located. That became the seventh fix: a round is a claim about a
commit, and locating it anywhere else answers a question nobody asked.

## B — a mechanical omission killed a round

**What it was.** On 2026-09-12 one round took three consecutive refusals —
missing `id`, then `problem`, then `class_scope`. The first read:

```
Refusing to record two findings under one key: …#undefined claimed by 5 findings.
```

The first two are typing. The report's own ordering contained the ids, and the
reviewer had already written the problem as a title.

**What shipped.** `review ingest` fills in those two and records in
`manifest.repairs` what it supplied and where from. Everything requiring
judgement — `class_scope`, evidence, dispositions — stays refused. The repair is
accepted only if it introduces no property the contract does not define, removes
none, and preserves the finding count, so widening it fails a test rather than
passing a review.

## C — the round had no price

**What it was.** `keryx review budget` printed a ceiling beside `spent: not
recorded` and said, correctly, that the two are not the same. Nothing fed it. A
search for `estimateTokens|tokenEstimate|estimateCost` across `src/review/`
returned nothing.

**What shipped.** An estimate at `review scope` before dispatch, multiplied by
the fan-out because every reviewer receives the scoped diff; the actual usage
recorded at `review ingest`; and cost per retained finding at `review complete`.

**The first round to be priced** was flow 262's own: 552,502 tokens, six
findings retained, **92,084 tokens per retained finding**. Whether that is worth
paying is now a question with a number in it.

## D — related-file grouping: declined, with the measurement

A file-sharded pipeline needs to bundle related files so a paired change is seen
whole. We shard by **domain** — every reviewer receives the whole scoped diff —
so no reviewer is ever handed one half of a pair.

Checked rather than asserted: across **118 packages and 848 findings, 307 (36%)
enumerate a class spanning more than one file.** A file-boxed reviewer could not
produce those.

The limit of that measurement is stated in the flow: `class_scope.sites` records
the class, not which files were open when the first site was found. The decision
is reopened the day the dispatch shards the scoped diff by file, because that is
the day we create the boxing grouping exists to repair.

---

## What the round on this work then found

Flow 262's own review round raised six findings against the code above, two of
them blockers, and every one was verified by an independent agent by execution:

- containment was enforced on the path **string**, so a symlink inside the tree
  pointing out of it was followed — and because the record says `derived` or
  `unlocatable`, a quote became a line-by-line oracle for any file the process
  could open;
- the matcher was O(file × quote) with no cap on either and ran once per
  finding: 50,000 lines against a 10,000-line quote took **49 seconds for one
  finding**. Bounded, and with the scan stopping at the second match, the same
  case measures **11.1 ms**;
- a locator carried in from a previous round survived unrechecked, on precisely
  the round type where the anchor is least trustworthy;
- a per-finding cost of 2 tokens over 10 findings printed `0`, contradicting this
  package's own rule that a zero means somebody measured;
- the repair guard checked additions and not deletions, promising more than it
  enforced;
- the whitespace-normalised ambiguity branch had no test and survived being
  collapsed to "return the first hit".

That is the argument for the fan-out and the independent verifier, made with this
repository's own numbers rather than in the abstract.

---

## Honest limits

- The 108 figure measures anchor-versus-head pairing, not line accuracy. A round
  whose head is recorded wrongly counts here the same as one whose line drifted.
- The 36% figure measures class enumeration, not what a reviewer had open.
- Flow 260's own 15 anchors all resolve, so for that round item A would have been
  insurance rather than repair. Reported because the plan said to report it
  either way.
- We still have **no benchmark of review quality**: no labelled corpus, no
  ground truth. `scripts/review-precision-baseline.ts` measures precision over
  our own recorded findings, and the pipeline's own code says what that is worth
  — a corpus that logs only survivors returns 100% whatever the reviewers got
  right. That is the widest remaining gap, it is a dataset rather than a code
  change, and it deserves its own flow.
