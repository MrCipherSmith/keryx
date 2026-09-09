# Review Report - MrCipherSmith/keryx#499, round 5

## Verdict: APPROVE

## Summary

The round that closes PR #499 and the follow-up it produced, carrying its
findings as a structured `keryx:findings` block and its verdicts as evidence
that names the commit it was checked against.

Rounds 1 to 3 recorded zero findings, and every verification claim attached to
them was discarded. The cause was not a missing capability: `review ingest`
reads findings from an embedded `keryx:findings` block in the report, and those
reports had none. A report without the block has no findings to read, which is
exactly what `findings: in=0` was saying.

All three findings were fixed and re-checked after the fix by an independent
verifier that executed rather than read, at 9246e1ed, which contains every
fix commit named below. None of them reproduces.

## Findings

### R1-LOGIC-001 - the was-to-is exemption was exploitable by shape

Fixed in d15052d8. `refuted` at 9246e1ed: the counterexample is now caught,
reported as 1 undeclared where it previously passed silently.

### R1-LOGIC-002 - `--remove --dry-run` removed for real

Fixed in d15052d8. `refuted` at 9246e1ed: the file is byte-identical after a
dry run, and the guard is load-bearing under mutation - removing it fails the
named test on a content assertion, not on an import error.

### R2-LOGIC-001 - a pair excused every cell sharing its row

Raised by the independent verification of R1-LOGIC-001's fix. Fixed in
2a875184. `refuted` at 9246e1ed: the same row now yields exactly one
violation, the third cell, while the genuine pair stays excused.

## Verification

Independent verifier, method `execution`, all three re-checked after the fix at
9246e1ed and none reproducing. Every check ran the working tree, never the
installed `keryx`.

## The structured findings

```json keryx:findings
[
  {
    "id": "R1-LOGIC-001",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "`isWasIsRow` in scripts/check-retired-cli-spellings.ts exempted any line containing a retired spelling and its replacement anywhere in the line, so ordinary prose instructing a reader to run the retired command was exempt from the gate that exists to catch exactly that.",
    "impact": "The gate reported 0 undeclared while a documented instruction to run `keryx mcp install` sat in docs/. A guard that cannot establish what it reports is the defect class this repository keeps recording.",
    "suggested_fix": "Require genuine cell pairing: split the row on `|` and exempt only when a cell starting with the retired spelling is directly adjacent to a cell starting with its replacement.",
    "evidence": "Confirmed by running, not by reading: the reviewer's line `| Tip | run `keryx mcp install --runtime cursor` (or the new `keryx integrate cursor`) |` dropped into docs/ produced 0 undeclared before the fix and 1 undeclared after it.",
    "confidence": "high",
    "file": "scripts/check-retired-cli-spellings.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "scripts/check-retired-cli-spellings.ts \u2014 isWasIsRow, the only exemption path",
        "scripts/check-retired-cli-spellings.ts \u2014 RETIREMENTS, the three retired spellings it keys on"
      ],
      "enumeration_method": "The gate has one exemption function and one caller; both were read in full. The scan covers 2318 files across README.md, docs/, .metaproject/ and src/, so the exemption is the only way a retired spelling passes."
    },
    "global_id": "2026-09-09-ingest-499-r06#R1-LOGIC-001",
    "source": "internal"
  },
  {
    "id": "R1-LOGIC-002",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "`keryx integrate --remove <editor> --dry-run` performed a real removal. `uninstallMcpClient` took no dry-run parameter, so the flag was accepted, documented, and ignored.",
    "impact": "A user asking to preview a removal had the config removed. The behaviour pre-existed the branch, but the branch rewrote the help text and dropped the old 'install only' qualifier, turning a documented limitation into a documentation lie.",
    "suggested_fix": "Thread `options: { dryRun?: boolean }` through uninstallMcpClient and preview instead of writing.",
    "evidence": "Mutation-proved rather than asserted: reverting the guard fails the named test on file contents \u2014 the config is still present after a --dry-run that claimed to preview \u2014 and not on an import or syntax error, which was the failure mode that made three earlier mutation attempts in this session invalid evidence.",
    "confidence": "high",
    "file": "src/mcp/client-config.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/mcp/client-config.ts \u2014 uninstallMcpClient, the removal path",
        "src/commands/integrate.ts \u2014 the --remove --dry-run caller",
        "src/commands/mcp.ts \u2014 the retired `mcp uninstall` alias reaching the same path"
      ],
      "enumeration_method": "Every caller of uninstallMcpClient was enumerated with `keryx ctx rg` over src/; three call sites, all read. The dry-run flag was traced from argument parsing to the write."
    },
    "global_id": "2026-09-09-ingest-499-r06#R1-LOGIC-002",
    "source": "internal"
  },
  {
    "id": "R2-LOGIC-001",
    "reviewer": "independent-verifier-a",
    "severity": "major",
    "problem": "The fix for R1-LOGIC-001 asked 'is this a was->is row?' once per ROW and applied the answer to every occurrence on it, so a row holding a genuine pair plus an unrelated instructional cell was exempted wholesale.",
    "impact": "A live instruction to run a retired spelling rides out on a neighbouring cell's legitimate exemption - the same failure the original finding named, one level in.",
    "suggested_fix": "Return the character ranges of the cells that earned the exemption and test which cell the occurrence actually sits in.",
    "evidence": "Found by independent verification of the first fix and confirmed by running it: a row pairing 'keryx mcp install' with 'keryx integrate' plus a third cell instructing the reader to run 'keryx mcp uninstall --runtime cursor' took occurrences from 59 to 61 while undeclared stayed 0.",
    "confidence": "high",
    "file": "scripts/check-retired-cli-spellings.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "scripts/check-retired-cli-spellings.ts - the exemption call in scanText, the only place the answer is applied"
      ],
      "enumeration_method": "The exemption has one caller; it was read in full and the row/occurrence granularity mismatch read off directly."
    },
    "source": "internal",
    "global_id": "2026-09-09-ingest-499-r06#R2-LOGIC-001"
  }
]
```
