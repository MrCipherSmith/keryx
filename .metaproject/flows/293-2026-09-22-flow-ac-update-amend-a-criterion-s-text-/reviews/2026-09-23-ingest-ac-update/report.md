# Review — flow 293, `flow ac update` amends a criterion's text (PR #653)

Two review passes ran over `src/flow/store.ts`, `src/flow/service.ts` and `src/commands/flow.ts`
(the `flow ac` command family) after the T5–T7 implementation landed. The first pass found five
defects in how a criterion's text was rewritten on disk and how its arguments were parsed; all
five were fixed in one commit (T9). The second pass re-reviewed that fix and found that its
block-replacement approach — deleting a criterion's continuation lines wholesale — silently
destroyed indented evidence notes and fenced code blocks that were never part of the criterion's
own text; that defect, and a related mixed-line-ending regression, were fixed by replacing
block-replacement with an explicit refusal (T10), which superseded T9's block-deletion behaviour
entirely. All seven findings were acted on before merge. PR #653 merged as `1b38143a` with 18/18
checks green at head `9ebbb1b00942f9034330e0a7dcd58d26fd9eacfa`.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (flow, pass 1)",
    "severity": "blocker",
    "file": "src/flow/store.ts",
    "quote": "content.split(\"\\n\")",
    "problem": "writeAcCriterion split the file's content on \"\\n\" alone and matched a criterion line with an anchored `(.*)$` regex. On a CRLF file, every line carried a trailing \"\\r\" that the regex never matched, so a replace found nothing to rewrite in place.",
    "impact": "A replace against a CRLF acceptance-criteria.md silently fell through to the append path and wrote a SECOND `- ACn:` line outside the Criteria section, leaving the original (unchanged) line still present — a duplicate criterion with two different texts, both apparently live.",
    "suggested_fix": "Detect the file's own line-ending convention once, split lines without swallowing or leaking the \"\\r\", and rejoin with the detected ending so a CRLF file stays CRLF and a matched line is genuinely replaced, not appended past.",
    "evidence": "src/flow/write-ac-criterion.test.ts (pre-fix): a CRLF fixture replace produced two `- AC1:` lines instead of one, and typeof the second line's raw bytes still carried \\r only on the untouched lines.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/flow/store.ts writeAcCriterion"],
      "enumeration_method": "writeAcCriterion is the only writer of acceptance-criteria.md; readAcCriteria/acChecksum/ac-confirm already tolerated CRLF on read, so the single write path was the only site that could reintroduce the bug."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by the CRLF-aware split/join in commit 3cca5176 (T9: 'amend criteria correctly in CRLF and multi-line files, and read flag values as given'); merged to main in 1b38143a via PR #653."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (flow, pass 1)",
    "severity": "major",
    "file": "src/flow/store.ts",
    "quote": "writeAcCriterion",
    "problem": "Before T9, a criterion's continuation lines (indented sub-bullet evidence notes, or a wrapped second line of the criterion's own text) were left on disk, untouched, when the `- ACn:` line above them was replaced — even though readAcCriteria/acChecksum/ac-confirm already treated those continuation lines as belonging to the criterion, not as their own entry.",
    "impact": "After a replace, the file showed the NEW criterion text followed by continuation lines that described the OLD text — an orphaned, misleading remnant that the checksum and the readers silently absorbed into the new criterion's block, without anyone having written it there.",
    "suggested_fix": "Compute the criterion's full block (its `- ACn:` line plus every indented, non-empty line after it, stopping at the next `- ACn:` line, a blank line, or a heading) and treat the whole block as what a replace removes and rewrites, so a rewritten criterion never inherits a stale continuation.",
    "evidence": "src/flow/write-ac-criterion.test.ts (pre-fix): replacing a criterion with a continuation line left that continuation line, describing the old text, immediately under the new one-line criterion.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/flow/store.ts writeAcCriterion", "src/flow/store.ts acBlockEnd"],
      "enumeration_method": "Grepped every acceptance-criteria.md in the repo for indented lines following a `- ACn:` line; 1098 such continuation lines exist across 224 files, all reachable only through writeAcCriterion's replace path."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by acBlockEnd-based block removal on replace, added in commit 3cca5176 (T9); this block-deletion behaviour was itself superseded two days later by commit 9ebbb1b0 (T10) after review pass 2 found it deleted content that was not part of the criterion (see F-006) — merged to main in 1b38143a via PR #653."
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (flow, pass 1)",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "--reason",
    "problem": "`acUpdate` and `acReseal` accepted a `--reason` value containing a newline with no validation, even though `--text` was already validated to be single-line.",
    "impact": "A multi-line `--reason` was written straight into flow.json's history and then rendered into journal.md, corrupting its one-bullet-per-line format — a later journal read would misparse the corrupted entry as multiple history lines.",
    "suggested_fix": "Add `validateSingleLineReason`, called from both `acUpdate` and `acReseal` after the existing empty-reason checks, refusing any `--reason` containing \\n or \\r.",
    "evidence": "service.test.ts (pre-fix): a `--reason` with an embedded newline was accepted and written verbatim into flow.json's history.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by validateSingleLineReason in commit 3cca5176 (T9), with a byte-unchanged-journal regression test in service.test.ts; merged to main in 1b38143a via PR #653."
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (flow, pass 1)",
    "severity": "minor",
    "file": "src/commands/flow.ts",
    "quote": "rejectUnusedAcArgs",
    "problem": "The pre-fix flag parser tokenized args, validated known flags with `rejectUnusedAcArgs`, then separately extracted each flag's value with `optionValue`. A value that itself started with `--` (e.g. `--note \"--fix the thing\"`) was misread by the tokenizer as an unrecognised flag of its own.",
    "impact": "`ac confirm --note \"--looks like a flag\"` was refused with 'unknown flag: --looks' instead of recording the note, silently narrowing what an operator could write as evidence without any documented restriction on the value's first characters.",
    "suggested_fix": "Replace the two-pass tokenize-then-extract with one `parseAcArgs` that tokenizes, validates and extracts values in a single pass: a recognised flag always consumes the very next token as its value, unless that token is itself one of the subcommand's own flag names.",
    "evidence": "ac-strict-args.test.ts (pre-fix): `ac confirm <id> AC1 --note \"--fix the thing\"` was refused as an unknown flag instead of being recorded.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by the single-pass parseAcArgs in commit 3cca5176 (T9); merged to main in 1b38143a via PR #653."
    }
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (flow, pass 1)",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "neither known nor next unused",
    "problem": "When `--criterion` named a number that was neither an existing criterion nor the next unused one, the refusal message was the same generic text whether the number was simply too far ahead or was a genuine GAP in the numbering (e.g. AC1/AC2/AC4 with AC3 missing).",
    "impact": "An operator hitting a real gap (AC3 missing) had no way to tell, from the error alone, that the fix was to edit the file directly rather than retry with a different number — and retrying with different numbers could not succeed, since filling the lowest gap through `--criterion`/`--text` is deliberately unsupported (it would put a new line out of numeric order).",
    "suggested_fix": "When the requested number is below the highest known one, name it explicitly as a gap and say to edit acceptance-criteria.md directly with `--reason` alone; keep the generic 'next unused is ACn' message for a number that is simply out of range.",
    "evidence": "service.test.ts (pre-fix): requesting AC3 in a AC1/AC2/AC4 file produced the same message as requesting AC9.",
    "confidence": "medium",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by the gap-naming branch in commit 3cca5176 (T9), with a gap-vs-out-of-range distinction test in service.test.ts; merged to main in 1b38143a via PR #653."
    }
  },
  {
    "id": "F-006",
    "reviewer": "code-reviewer (flow, pass 2)",
    "severity": "major",
    "file": "src/flow/store.ts",
    "quote": "acBlockEnd",
    "problem": "T9's fix for F-002 made writeAcCriterion delete a criterion's ENTIRE block — the `- ACn:` line plus every indented, non-empty line after it — on replace. `acBlockEnd` could not distinguish a criterion literally wrapped across two lines from an indented sub-bullet evidence note or a fenced code block placed under the criterion for documentation.",
    "impact": "Replacing a single-line criterion that happened to have an indented note or a fenced code block underneath it silently deleted that note or code block along with the old criterion text — content the operator never asked to remove, with no warning.",
    "suggested_fix": "Stop treating a criterion's continuation as content to delete-and-replace. Use the block-extent calculation only to (a) find where to insert a brand-new appended criterion, skipping past any existing block, and (b) detect whether the REPLACE target has any continuation at all — and if it does, refuse the replace by name rather than guessing what to keep.",
    "evidence": "write-ac-criterion.test.ts (pre-fix, T9 code): replacing a criterion followed by an indented sub-bullet evidence note, or by a fenced code block, silently removed the note/block along with the old text.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/flow/store.ts writeAcCriterion", "src/flow/store.ts acBlockEnd"],
      "enumeration_method": "Same single writer as F-002 (writeAcCriterion); walked every shape acBlockEnd's 'indented, non-empty line' rule matches — a wrapped criterion line, a sub-bullet note, and a fenced code block are structurally indistinguishable from the file's bytes alone, so all three were affected identically."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by removing block-deletion and refusing a multi-line replace outright, in commit 9ebbb1b0 (T10: 'refuse to replace a multi-line criterion instead of guessing where it ends'); merged to main in 1b38143a via PR #653."
    }
  },
  {
    "id": "F-007",
    "reviewer": "code-reviewer (flow, pass 2)",
    "severity": "minor",
    "file": "src/flow/store.ts",
    "quote": "detectEol",
    "problem": "T9's CRLF fix (F-001) detected ONE line-ending convention for the whole file and rejoined every line with it, even in a file that legitimately mixed \\r\\n and \\n per line.",
    "impact": "A replace or append against a mixed-ending acceptance-criteria.md rewrote every line's ending to the single detected convention, so lines the operation never touched still changed on disk byte-for-byte — a diff far larger than the one criterion that was actually edited.",
    "suggested_fix": "Track each line's OWN original terminator individually (splitAcLines/renderAcLines) instead of one file-wide convention; a replace keeps the matched line's own original ending, and an append takes the ending of the line it is inserted after, falling back to the file's overall convention only when that preceding line had none.",
    "evidence": "write-ac-criterion.test.ts (pre-fix, T9 code): a file mixing \\r\\n and \\n per line had ALL lines rewritten to one ending after a single-line edit, not just the matched line.",
    "confidence": "medium",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed by per-line-ending tracking (splitAcLines/renderAcLines) in commit 9ebbb1b0 (T10); merged to main in 1b38143a via PR #653."
    }
  }
]
```

## Coverage

Reviewed: `src/flow/store.ts` (`writeAcCriterion`, `acBlockEnd`, `splitAcLines`, `renderAcLines`,
`detectEol`), `src/flow/service.ts` (`acUpdate`, `acReseal`, validation), and `src/commands/flow.ts`
(`parseAcArgs` and the `ac` subcommand dispatch). Not reviewed: the rest of the repository,
unchanged by this flow.

## Outcome

Seven findings across two passes: one blocker, three major, three minor — all acted on and
re-verified against the merged code; none dismissed. Pass 2 re-reviewed pass 1's own fix and found
that its block-deletion strategy, while it fixed the orphaned-continuation defect it targeted,
introduced a new content-loss defect of its own; the final design (T10) removes block-deletion
entirely in favour of an explicit refusal, which is a narrower guarantee than "always correctly
rewrites a multi-line criterion" but is one the code can actually keep.
