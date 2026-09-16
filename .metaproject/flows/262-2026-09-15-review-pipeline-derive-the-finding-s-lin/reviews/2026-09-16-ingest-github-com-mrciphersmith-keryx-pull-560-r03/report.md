# Review round 2 (fix round) — flow 262 / PR #560 (`e8b62dc5`, merged as `7a53af36`)

Target: `pr` · https://github.com/MrCipherSmith/keryx/pull/560 · head `088801de0aa69e55d10f7bd2b8f9841fd8db398f`
Scope A: 2,276-line diff, nothing dropped by the pre-filter. Estimated before dispatch at ≈26,655 prompt tokens per reviewer, ≈106,620 across four — the first round this pipeline has ever priced in advance, which is one of the things under review.
Scope B: 57-line blast radius from `keryx review blast-radius`.
Reviewers: `review-logic`, `review-security-code`, `review-testing-practices`. `review-clean-code` was planned and not dispatched — recorded here rather than left silent.
External PR comments: collected against `088801de` — zero.

## Which commit this round speaks for

The verification ran against `4bbc9681`. This round is recorded against
`e8b62dc5`, the head that merged, and the difference between the two is stated
rather than assumed: `git diff --name-only 4bbc9681..e8b62dc5` lists **13 files,
of which 0 are source or contract files** — every one is a flow record under
`.metaproject/flows/262-*/`. No file the findings concern, and no file the
verifier exercised, changed between them.

This is written down because the completion gate is right to ask. A round
recorded against a commit it did not run on is exactly the pairing failure this
whole flow exists to repair, so the claim that the two commits are equivalent
for this purpose is made checkable instead of waved through.

## What this round is

Round 1 raised these six against `088801de`. `f0b1f8b6` and `4bbc9681` answer all
six; this round carries them forward with `review-verifier`'s verdicts, obtained
against the fixed tree by an agent that raised none of them. **All six are
refuted by execution** — every verdict has a command and a result behind it, and
F-006 additionally by mutating a copy until the new test failed.

Two numbers are worth keeping. The performance blocker measured 49,363 / 9,243 /
118 ms before and 11.1 / 2.3 / 1.3 ms after. And the mutant of the
whitespace-ambiguity branch now fails exactly one test, where before it failed
none.

## Verdict on round 1

**Six findings, two of them blockers, and both blockers are defects this PR
introduced.** Every one is backed by an execution the reviewer ran, not by
reasoning: the symlink bypass was reproduced against `/etc/passwd`, the
unbounded matcher was timed at 49 seconds for a single finding, and the stale
locator was reproduced by driving `createManagedReviewPackage` end to end.

The change under review makes `review ingest` read files named in a review
report. That is new attack surface, and the round found that the guard written
for it did not hold.

## Findings

### F-001 `blocker` — the containment check was lexical, so a symlink defeated it

`path.resolve` + `startsWith` inspects the spelling of a path, not the file
system. A symlink inside the tree pointing out of it passed, and `readFile`
followed it. Because the record then says `derived` or `unlocatable`, a quote
becomes a line-by-line oracle for any file the ingest process can read.

### F-002 `blocker` — no bound on file or quote, and the loop is sequential

O(file lines × quote lines) per finding, no cap on either dimension, no timeout.
50,000 lines against a 10,000-line quote: 49 s for ONE finding. A 20,000-line
lockfile against a 50-line quote: 118 ms per finding, ~2 minutes for a
thousand-finding report.

### F-003 `major` — a locator from a previous round survived unrechecked

With no fresh quote the loop did `continue`, keeping whatever `line`/`locator`
the input carried. A fix round echoing a finding out of `prior_findings` brings
the old pair with it — so the round where the anchor is least trustworthy is
where an unverified pair was written under a record claiming derivation.

### F-004 `major` — the per-finding cost rounded a real spend to a printed zero

`2 tokens / 10 findings` printed `per retained finding: 0 tokens` directly under
`tokens: 2`, contradicting the module's own rule that a zero means somebody
measured.

### F-005 `minor` — `acceptRepair` checked additions, never deletions

A repair that CLEARED `evidence` or `class_scope` passed a guard whose comment
promised to catch exactly that.

### F-006 `minor` — the whitespace-normalised ambiguity branch had no test

Collapsing it to "return the first hit" left all 584 tests green. The exact pass
was pinned; its mirror was not.

## Dispositions

All six acted on in `f0b1f8b6`, each with a test. The two blockers were
re-measured after the fix: 49 s → 4.2 ms, 118 ms → 0.8 ms.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/review/managed.ts",
    "quote": "      const resolved = path.resolve(input.cwd, relative);\n      if (resolved !== input.cwd && !resolved.startsWith(`${path.resolve(input.cwd)}${path.sep}`)) {\n        return null;\n      }",
    "problem": "The round-tree containment check is lexical, not real: a symlink inside the tree defeats it and lets `review ingest` read arbitrary host files.",
    "impact": "Anyone who can add a file to the tree under review can plant a symlink and then use the derived locator state as a line-by-line oracle for any file the ingest process can read.",
    "evidence": "Reproduced live: symlinked /etc/passwd into the round tree and drove createManagedReviewPackage with a finding quoting a line of it; findings.json recorded {\"state\":\"derived\",\"method\":\"exact\"}. Lexical traversal attacks are correctly refused, which is what makes the symlink the gap.",
    "suggested_fix": "realpath both sides before the containment comparison, and refuse to follow a link whose target falls outside the tree.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/managed.ts — anchorFindings, default readTreeFile closure"],
      "enumeration_method": "keryx ctx rg for the containment shape across src/ — one match; keryx ctx rg for readTreeFile confirms production ingest never overrides it, so this is the sole check on the real path."
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/review/locate.ts",
    "quote": "  for (let start = 0; start + needle.length <= haystack.length; start += 1) {\n    const window = shape(haystack.slice(start, start + needle.length));\n    if (window.every((line, offset) => line === needle[offset])) {\n      hits.push(start + 1); // 1-based, like every line number a human reads\n    }\n  }",
    "problem": "locateQuote is O(file lines x quote lines) with no cap on either, and anchorFindings runs it once per finding sequentially, so a report can hang review ingest for minutes.",
    "impact": "A report is attacker-influenced data by this round's own framing; a single ingest can be made to hang with no cap, no timeout and no bailout, using inputs that look ordinary.",
    "evidence": "Measured on one core with no I/O: 50,000-line file x 10,000-line quote = 49,363 ms for one finding. 20,000 lines x 5,000-line quote = 9,243 ms. Realistic case — 20,000-line lockfile x 50-line quote — 117.9 ms per finding, ~118 s extrapolated to 1,000 findings. No MAX_QUOTE/timeout/AbortController anywhere on the path.",
    "suggested_fix": "Bound quote length and file size before matching, and stop the scan once ambiguity is established.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/locate.ts — findRuns/locateQuote", "src/review/managed.ts — anchorFindings, the sole caller"],
      "enumeration_method": "keryx ctx rg for locateQuote|locateFinding across src/ — one non-test call site, inside anchorFindings' sequential loop; no length or timeout guard present in either file."
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/review/managed.ts",
    "quote": "  for (const finding of findings) {\n    const locator = await locateFinding(finding, read);\n    if (locator === undefined) {\n      continue;\n    }",
    "problem": "A finding carrying a stale locator and line but no quote is written through unrechecked.",
    "impact": "On a fix round — the round type this change's own comments call out as where the anchor is least trustworthy — an unverified line/locator pair is written verbatim into the new round's findings.json, defeating the derivation guarantee for exactly that case.",
    "evidence": "Drove createManagedReviewPackage with a finding carrying line 42 and a fabricated unlocatable locator and no quote; the persisted record came back with both intact, unexamined, with no warning and no schema rejection.",
    "suggested_fix": "Clear any pre-existing locator when the finding has no quote, so 'no quote means no locator' holds of the record.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/managed.ts — the `if (locator === undefined) { continue; }` branch in anchorFindings"],
      "enumeration_method": "Searched every caller of locateFinding/anchorFindings in src/review — one definition, one call site — then reproduced the pass-through through the real entry point."
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/review/cost.ts",
    "quote": "  if (tokens !== undefined) {\n    lines.push(`per retained finding: ${grouped(Math.round(tokens / retained))} tokens`);\n  }",
    "problem": "The per-finding cost rounds a nonzero spend down to a printed zero, contradicting the module's own rule that a zero means somebody measured.",
    "impact": "A reader who trusts the module's promise reads 'per retained finding: 0 tokens' as free when the round spent tokens — the exact confusion the module exists to prevent, reappearing through a different door.",
    "evidence": "renderCostPerFinding({ input_tokens: 2 }, 10) returned [\"tokens: 2\", \"retained findings: 10\", \"per retained finding: 0 tokens\"]. renderCostPerFinding({ spent_usd: 0.00001 }, 10) returned \"per retained finding: 0.0000 USD\".",
    "suggested_fix": "Print a distinguishing form when the figure rounds to zero but the total did not.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/cost.ts — the tokens division in renderCostPerFinding", "src/review/cost.ts — the spent_usd division in the same function"],
      "enumeration_method": "Read the whole of renderCostPerFinding; it has exactly two per-finding divisions and both were exercised against the real exported function."
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/review/repair.ts",
    "quote": "    const added = Object.keys(finding).filter((key) => !had.has(key));",
    "problem": "acceptRepair's key-set check only catches added fields, never deleted ones, so a repair that cleared a judged property would pass.",
    "impact": "Not live under the current call path, but the guard's comments claim a promise the implementation does not keep: a later edit that clears a field instead of adding one would drop evidence or a class_scope enumeration without being caught.",
    "evidence": "Read the before/after key-set diff in acceptRepair: it computes only `added` and never the removed set.",
    "suggested_fix": "Compute the removed set too and refuse when it is non-empty.",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/review/locate.ts",
    "quote": "  const loose = findRuns(haystack, needle.map(normalise), (window) => window.map(normalise));",
    "problem": "The whitespace-normalised ambiguity branch has no test and survives deletion.",
    "impact": "Collapsing the branch to return the first hit — anchoring an ambiguous quote instead of refusing — left the full suite green at 584 pass. The exact-match path is the only one actually protected, and this is the failure mode the module's own comment calls unacceptable.",
    "evidence": "Mutated a scratchpad copy: replaced the loose-pass ambiguity branch with a first-hit return and ran bun test src/review/ — 584 pass, 0 fail.",
    "suggested_fix": "Add an ambiguity case for the loose pass beside the existing exact-match one.",
    "confidence": "high"
  }
]
```
