# Implementation Plan

Status: ready

## Approach

Extend the existing `src/product` module and the `flow init` template; add no command, no module, no skill. The verdict grammar is a single closed set parsed in `src/product/extract.ts`; a line that starts with `outcome-observed:` and does not match is a failure, never a silent "observed". The failure keeps the flow in the open queue so a typo cannot hide an intent.

Docpack observations reuse the same parser on an `Outcome observations` section of the package README.

The template hint text is a placeholder: the extractor must treat it as no criterion stated, so G1a measures declarations and not the presence of the template.

## Steps

1. Verdict parser and types (`IntentOutcome` gains `verdict`), parse failures for malformed lines, fingerprint unchanged in kind (it already covers journal.md and the package README).
2. `index` and `open` output, TUI view: verdict counts.
3. `flow init` template gains `Outcome criteria`; placeholder handling in the extractor; the informational intent-statement line at init.
4. Docpack `Outcome observations`.
5. Docs: implementation-plan G1a/G1b, metrics-and-validation "before" arm, module page, README, CLI reference, CHANGELOG 0.3.31, version bump.
6. Review, CI, merge, release; then stop before G1a.

## Risks

- A stricter observation line invalidates any hand-written `outcome-observed:` line: there are none in the corpus (measured 0).
- The init note prints for every title-only flow because the template is a placeholder; it must stay one line and never affect the exit code.
- The metrics document does not exist in the product package yet; it is created with the standard's file name, not a new document a human must maintain.
