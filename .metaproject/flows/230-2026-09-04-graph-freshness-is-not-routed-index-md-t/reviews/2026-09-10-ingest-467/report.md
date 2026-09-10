# Review Report - MrCipherSmith/keryx#467

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Retrospective review of a diff merged on 2026-09-04. Twenty files. One finding,
major, fixed in b0024c8c and independently re-checked there.

The finding is the PR's own subject turned on the PR. #467 exists so the graph
cannot go stale with "nothing in the answer to say so". Its post-commit hook
decided relevance from a hand-written list of directory prefixes while the
builder indexes by extension almost everywhere, and the gap between those two
definitions was indexed source that the hook passed over in silence.

Silence is the whole of it. A missed rebuild that announced itself would be an
inconvenience. Every other branch of that hook says something when the graph
may be stale; this one returned 0 with no output.

## Findings

### R1-LOGIC-001 - indexed source outside the prefix list was silently skipped

Fixed in b0024c8c by keeping the prefix list and adding an extension test whose
exclusion mirrors IGNORE_DIRS. `refuted` at b0024c8c by a verifier that did not
raise it: all four previously-silent paths now trigger a rebuild, all three
never-walked paths still do not, and the fifteen excluded directory names match
the builder's set exactly in both directions.

## Verification

Independent verifier, method `execution`, at b0024c8c. It ran the rendered hook
in a scratch repository against a fake `keryx` on PATH and observed which
commits invoked `gdgraph build`, rather than reading the regex.

## Recorded, not carried

While fixing this, CI failed on a defect older than the fix: `installManagedHook`
wrote managed blocks with the string form of `String.replace`, which reads `$'`
as "everything after the match". The new hook content ends `(...|py)$'`, so
writing it spliced the rest of the hook file back in and duplicated every
managed block below it. Fixed in the same commit, in both update.ts and
init.ts. It is not carried as a finding of this round because it is not in
#467's diff - it was one character away from firing since long before.

## The structured findings

```json keryx:findings
[
  {
    "id": "R1-LOGIC-001",
    "reviewer": "review-pr467",
    "severity": "major",
    "problem": "The post-commit hook decides whether a commit is graph-relevant from a list of directory prefixes (^src/, ^lib/, ^app/, ^packages/, ^services/, ^scripts/, ^docs/), while the builder indexes any .ts/.tsx/.js/.jsx/.java/.py file anywhere except the fifteen directories in IGNORE_DIRS. Source between those two definitions was indexed and undetected.",
    "impact": "The graph went stale after a commit to indexed source and NOTHING said so. Every other branch of this hook prints a warning when the graph may be stale - keryx missing, build failed, rebuild opted out - but this one returned 0 in silence, which is the exact failure the PR was written to end. Live in this repository: vscode-extension/src/ (18 TypeScript files), install.ts at the root, and the fixtures/ sources are all in the graph and none can match ^src/.",
    "suggested_fix": "Keep the prefix list, which covers paths that change how the graph resolves without being indexed, and add an extension test whose exclusion mirrors IGNORE_DIRS in src/gdgraph/build.ts.",
    "evidence": "Reproduced by running the rendered hook in a scratch repository: committing vscode-extension/src/extension.ts, a root install.ts and fixtures/leaf.ts each produced NO output and exit 0, while the positive control src/a.ts reached the rebuild branch. Confirmed independently against the graph itself - vscode-extension/src appears in .metaproject/data/gdgraph/storage/build-manifest.json.",
    "confidence": "high",
    "file": "src/lib/templates.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/lib/templates.ts - renderGdgraphPostCommitHook, the single source of the hook written into every project keryx scaffolds or updates",
        ".metaproject/modules/gdgraph.md - 'Automatic refresh', claims the hook covers the committed half of the freshness gap",
        ".metaproject/hooks/README.md - same claim",
        ".metaproject/skills/gdgraph/SKILL.md - 'Refresh Policy', same claim",
        "docs/docs/workspace-and-lifecycle.md - hooks table, 'rebuilds the graph after a graph-relevant commit'"
      ],
      "enumeration_method": "Searched the PR's 20 changed files for 'graph-relevant' and 'relevant to the graph' to find every restatement of the coverage claim, then read the unchanged indexer in src/gdgraph/build.ts to establish the scope those sentences were claiming to match."
    },
    "global_id": "2026-09-10-ingest-467#R1-LOGIC-001",
    "source": "internal"
  }
]
```
