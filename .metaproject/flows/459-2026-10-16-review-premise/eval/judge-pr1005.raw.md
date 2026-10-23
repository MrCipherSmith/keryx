STATUS: DONE

```json keryx:premises
{
  "judge": "review-premise",
  "model": "claude-opus-5-5",
  "premises": [
    {
      "finding_id": "F-066",
      "verdict": "upheld",
      "reasoning": "Nothing shows the gap was chosen. The comment at src/lib/trust-routine-command.ts:126-128 says the gate does not compute what the shell will make of a word and refuses it instead, so failing closed is the stated intent. The gap is that isShellSpelledOption only checks words that start with a dash or with \\ { $. A word like `HEAD$IFS--output=X` starts with H and gets through, and so does a backslash inside double quotes. This allowlist sits in front of git, which runs no check of its own, so the outcome (git writes or truncates an arbitrary file without a prompt) is real. Accepted practice for a command allowlist is to refuse anything the tokenizer cannot fully resolve. The suggested fix moves the code toward that, and it matches what the file already does elsewhere: isExpandable (line 279) refuses any $ \\ { } for cd targets, and line 347 refuses $( ${ and backticks across the whole command. A senior reviewer would accept the fix."
    },
    {
      "finding_id": "F-067",
      "verdict": "upheld",
      "reasoning": "There is one sign of intent: the scan-test exemption at src/commands/review-revision-operand.test.ts:184 says the operands are commits recorded in the graph provenance. The finding shows that reason is wrong. readProvenance (src/sync/provenance.ts:242) only checks that commit is a string, and .provenance.json is a tracked file, so whoever controls the repository controls the value. git's own documentation (git-rev-parse --end-of-options, added in git 2.24) recommends the same guard for revision operands that may be untrusted. The PR applies that guard (revisionOperand) at its other ref-to-git sites, so the fix makes the code more consistent, and it keeps checkGraphStaleness's never-throws contract by returning [] when a value is rejected. The trigger is reachable from `keryx gdgraph find`. The fix is sound."
    }
  ]
}
```

2 judged: 2 upheld, 0 held.
