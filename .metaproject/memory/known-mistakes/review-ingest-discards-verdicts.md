# Findings reach a review round through the report's keryx:findings block, and a round without one silently records none

Version: 0.3.0
Type: known-mistake
Status: accepted
Caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
could not accept findings at all and the completion gate was therefore
unsatisfiable. That was wrong. It is corrected here rather than deleted, because
the wrong diagnosis is the more useful half.
Confidence: high

## Summary

`keryx review ingest --report <md>` reads structured findings from a fenced
` ```json keryx:findings ` block inside the report. A report without that block
ingests as `findings: in=0`, and every `--verifications` claim naming one of its
findings is then discarded as unresolvable — because the finding it names is not
in the round.

That produces a completion gate that looks impossible: `flow complete` demands a
verifier verdict of `refuted` on every `acted-on` finding, and the verdicts keep
being thrown away. The mechanism is not missing. The block is.

## Details

The failure is quiet in the specific way that matters: `findings: in=0
retained=0` is printed, `verification claims discarded: N` is printed, and both
are accurate — they simply describe a report that carried no findings, which
reads identically to a tool that cannot carry them.

Flow 243 burned three rounds on this. Each was rejected for a different and
individually correct reason, which made the rejections look like a moving target
rather than one root cause:

- r01 — dispositions citing no commit SHA. "Fixed" with nothing to point at is
  a claim, not a record.
- r02 — run against a SHA on another branch, not the PR head. A clean round
  against a commit that will not merge proves nothing about what merges.
- r03 — `verification_mode: off`, meaning nobody but the finding's author
  checked it.

All three had zero findings, for the one reason above, and that was the fact
worth reading first.

What actually closed it (r06): a report carrying the findings in a
`keryx:findings` block, `--verifications` claims whose evidence NAMES the commit
the fix landed in, and distinct identities for the party that raised a finding
and the party that verified it — the tool rejects self-verification by name, so
"independent-verifier" cannot both raise and refute.

Two further contracts learned the same way:

- `review complete` will not overwrite an existing disposition. The outcome and
  the record of it are one record; a correction must be a new round.
- `refuted` means "the defect no longer reproduces", NOT "the finding was
  wrong". It is the verdict a fix earns.

## What to do instead

Put the findings in the report:

    ```json keryx:findings
    [ { "id": "R1-...", "reviewer": "...", "severity": "major", ... } ]
    ```

Exactly one block per report — the parser throws on two, because an orchestrator
concatenating one block per reviewer silently kept the first and dropped the
rest.

And before concluding that a tool cannot do something, search for the path it
documents. `ManagedReviewInput.findings` is a declared field whose doc comment
names `parseEmbeddedFindings`; reading either one would have answered this in a
minute instead of three rounds.

## The mistake worth keeping

The wrong version of this entry was written confidently, committed, merged in
PR #505, and reported to the operator as a tooling defect with a proposed fix —
on the strength of having read `ManagedReviewIngestInput` and the CLI flag list
and finding no `--findings`. Absence of a flag was treated as absence of a
mechanism.

That is the same defect class this repository keeps recording, turned on itself:
a mechanism that could not establish something, reporting that it had. The check
that would have caught it is the one applied to everything else here — try to
make the claim fail before publishing it. One `keryx ctx rg parseEmbeddedFindings
src/` would have done it.

## Provenance

- Source: manual
- Link: https://github.com/MrCipherSmith/keryx/pull/499
- Author: MrCipherSmith
- Confirmed-By: flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: review, flow
- Entity: parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
- Files: src/review/managed.ts, src/review/types.ts, src/commands/review.ts
- Skills:

## Tags

review, flow, gate, verification, wrong-diagnosis

## Changelog

- 0.1.0 - Initial version.
- 0.2.0 - Recorded a tooling gap that does not exist.
- 0.3.0 - Corrected: the mechanism is the report's keryx:findings block. Kept
  the wrong diagnosis and how it was reached, because that is the reusable part.
