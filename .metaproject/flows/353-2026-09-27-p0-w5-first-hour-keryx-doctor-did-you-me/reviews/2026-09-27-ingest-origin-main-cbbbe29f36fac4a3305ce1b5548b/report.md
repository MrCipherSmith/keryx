# Review round 6 (verifier-only) — flow 353, PR #773

- Round ref (head under review): `cbbbe29f36fac4a3305ce1b5548bfa8ce3063079`
- Range: `origin/main..cbbbe29f36fac4a3305ce1b5548bfa8ce3063079` (0 files per `keryx review scope --json` — `origin/main` already carries identical content, per the squash-merge at `503c20c6`)
- `is_fix_round: true`; this round answers a completion-gate defect, not a new code change: round 2
  (`2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42`) raised L3 (blocker) and T3 (minor),
  round 3 (`2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e`) fixed both but reported only
  new findings (T4, T5) — it never re-reported L3/T3 with their own `global_id` and a verifier
  `refuted` verdict. `keryx flow complete 353` therefore reads them as marked `acted-on` with no
  verifier verdict of `refuted`. This round closes that gap by re-checking both by execution.
- verification_mode: `filter`
- No domain reviewers dispatched this round — `review-verifier` only, per the gap the completion
  gate named. No new findings are raised.

## Prior findings — disposition at this head

| id | severity | disposition | evidence |
|---|---|---|---|
| L3 | blocker | **closed** | `bun run src/cli.ts integrate cursor,claude --dry-run` at `cbbbe29f` (repo state identical at `origin/main`/`503c20c6`) → exit 0, writes both `.cursor/mcp.json` and `.mcp.json` dry-run previews, no `Unknown command`. `src/lib/group-subcommands.ts` carries no `integrate` row (only a comment at lines 181-182 explaining why it is deliberately absent). Fixed at `861be8c20e366df1c1a6eea22728ab2e0d2a886e` (round 3), which removed the `integrate` row from `GROUP_SUBCOMMANDS`. |
| T3 | minor | **closed** | `bun test src/cli.test.ts` at this head → 68 pass, 0 fail. The positive guard test named by T3's `suggested_fix` exists: `src/cli.test.ts:337` — `"a group whose first positional is a comma-joined list is not in the map and is never refused"` — exercising `integrate cursor,claude`'s comma-joined shape. Added at `861be8c20e366df1c1a6eea22728ab2e0d2a886e` (round 3); its own partiality was separately filed and closed as round-3 finding T4 (`70538bea`), which is not this round's concern. |

## New findings

None. This round only re-verifies L3 and T3 against their original `global_id`.

```json keryx:findings
[
  {
    "id": "L3",
    "reviewer": "review-logic",
    "severity": "blocker",
    "problem": "The round-1 fix for L1 adds a central pre-dispatch 'unknown subcommand' guard in src/cli.ts (main()), driven by src/lib/group-subcommands.ts's GROUP_SUBCOMMANDS map. That map included the 'integrate' group with the closed enum [cursor, claude, opencode, vscode, generic, all] -- the individual editor names commands/integrate.ts's EDITOR_USAGE documents. But commands/integrate.ts's own parseEditors() (lines 51-58) explicitly treats the first positional as a comma-splittable LIST, not a single closed-vocabulary token: 'keryx integrate cursor,claude' is a documented, pre-existing, working invocation that addresses two editors in one call. The guard checked the raw token 'cursor,claude' against the per-editor enum, found no exact match, and refused the command with 'Unknown command: cursor,claude...' before integrateCommand ever ran -- breaking a real, currently-working invocation.",
    "impact": "`keryx integrate cursor,claude`, `keryx integrate cursor,claude,vscode`, and any other comma-joined multi-editor invocation of `keryx integrate` exited 1 with 'Unknown command: <the whole comma list>. Run `keryx integrate --help` for the list.' and wrote NO client config, instead of installing the MCP client config for every named editor.",
    "suggested_fix": "Remove `integrate` from GROUP_SUBCOMMANDS in src/lib/group-subcommands.ts, OR make the cli.ts guard comma-aware for this one group before checking membership.",
    "evidence": "Original finding, round 2 (2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42).",
    "confidence": "high",
    "file": "src/lib/group-subcommands.ts",
    "line": null,
    "quote": "[\"integrate\", [\"cursor\", \"claude\", \"opencode\", \"vscode\", \"generic\", \"all\"]],",
    "class_scope": {
      "sites": [
        "src/commands/integrate.ts:51-58 (parseEditors, the caller whose comma-list contract breaks)",
        "src/cli.ts:314-320 (the guard that wrongly refused it)"
      ],
      "enumeration_method": "Round-2 enumeration, carried forward unchanged; round 6 re-verified by direct execution at cbbbe29f36fac4a3305ce1b5548bfa8ce3063079 (see verifications)."
    },
    "reviewer_note": "re-reported for round-6 re-verification of the fix; content unchanged from round 2 — round 3 (861be8c20e366df1c1a6eea22728ab2e0d2a886e) fixed this by removing the `integrate` row from GROUP_SUBCOMMANDS, but never re-reported this finding with a verifier `refuted` verdict against its own global_id, which is the gap this round closes",
    "global_id": "2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#L3"
  },
  {
    "id": "T3",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "cli.test.ts's coverage for the central 'unknown subcommand' guard (describe block for review round 1 L1) proved the negative case (a nonsense token is refused) for all 40 groups, but only two positive real-subcommand invocations were exercised ('keryx health status', 'keryx wiki ask --help'), and neither used a value shaped any differently from a single bare word.",
    "impact": "A group whose real first-positional shape is not 'one bare word from the enum' -- as `integrate`'s comma-joined editor list turned out to be -- had no test proving the guard did not wrongly refuse it. This was the exact gap L3 fell through.",
    "suggested_fix": "Add, per group in GROUP_SUBCOMMANDS, at least one assertion that a REAL subcommand/positional is not rejected as 'Unknown command' -- specifically a case for `integrate` exercising its comma-joined form once the L3 fix lands.",
    "evidence": "Original finding, round 2 (2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42).",
    "confidence": "high",
    "file": "src/cli.test.ts",
    "line": null,
    "class_scope": {
      "sites": ["src/cli.test.ts:286-330"],
      "enumeration_method": "Round-2 enumeration, carried forward unchanged; round 6 re-verified by execution at cbbbe29f36fac4a3305ce1b5548bfa8ce3063079 (see verifications)."
    },
    "reviewer_note": "re-reported for round-6 re-verification of the fix; content unchanged from round 2 — round 3 (861be8c20e366df1c1a6eea22728ab2e0d2a886e) added the comma-joined-list positive test this finding asked for, but never re-reported this finding with a verifier `refuted` verdict against its own global_id, which is the gap this round closes",
    "global_id": "2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#T3"
  }
]
```
