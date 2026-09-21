# Review round 1 — flow 280 (the graph-provenance stall)

One reviewer read the fix commit `ce309d58` against `main` and found two defects: the
fast path stamped every module's provenance, bypassing the wiki's freshness gate, and
the code-file set missed `.mts`/`.cts`, which turned a real code change into "nothing
changed" on that same path. Both were fixed in `771de997` and re-reviewed by a second
reviewer, which found nothing at or above its threshold. Both commits are contained in
merge commit `f5b90d2c`, which landed PR 636 on `main`.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (sync fast path)",
    "severity": "blocker",
    "file": "src/commands/sync.ts",
    "quote": "recordProvenance",
    "problem": "The fast path added by ce309d58 called recordProvenance for every module in SYNCED_MODULES, gdwiki included, without consulting resolveWikiSourceGate — the only other place that stamps gdwiki provenance (applyModule) always asks that gate first.",
    "impact": "diffSince is a committed-history diff and cannot see an untracked file, so with an untracked src/new.ts beside a metaproject-only commit the wiki recorded freshness for a tree it had never read — exactly the over-claim the AFC-08 gate exists to prevent.",
    "suggested_fix": "Consult resolveWikiSourceGate for gdwiki on the fast path and refuse through the existing printApplyOutcome/describeSourceGate wording when the gate is not fresh.",
    "evidence": "Read of the fast path against applyModule's gdwiki branch and of diffSince's git diff --name-status, which omits untracked paths, while checkGraphStaleness reads git status --porcelain.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/sync.ts fast path in syncCommand", "src/commands/sync.ts applyModule gdwiki branch"],
      "enumeration_method": "Listed every call site of recordProvenance in the sync command and checked which of them consult the wiki source gate."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At fix commit 771de997 (contained in merge f5b90d2c) sync.test.ts drives a real git repository: sync --apply on a clean tree, then an untracked src/new.ts, then a metaproject-only commit — gdwiki provenance stays on the first commit and the refusal wording is printed, while gdgraph and memory advance; a control without the untracked file advances gdwiki. Full suite re-run on the merged branch: 11641 pass, 0 fail.",
      "verifier": "orchestrator re-run plus an independent second review of 771de997"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 771de997 asks resolveWikiSourceGate on the fast path for gdwiki and refuses via printApplyOutcome; merged to main in f5b90d2c via PR 636."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (sync fast path)",
    "severity": "major",
    "file": "src/sync/diff.ts",
    "quote": "CODE_EXT",
    "problem": "CODE_EXT omitted .mts and .cts, so a commit touching only such a file produced an empty code diff.",
    "impact": "Before the fast path that only left an artifact stale; after it, the empty diff was read as proof that the code is identical and provenance advanced, claiming freshness for code the artifacts were never built from.",
    "suggested_fix": "Add mts and cts to the code-file set and document why it stays broader than the graph parser's own extension list.",
    "evidence": "The regex at src/sync/diff.ts does not match foo.mts; the fast path treats an empty code diff as identity.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/sync/diff.ts CODE_EXT", "src/commands/sync.ts codeOnly consumers"],
      "enumeration_method": "Traced every importer of isCodeFile/codeOnly: only the sync command reads them, so the extension set is the single place the classification is decided."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At fix commit 771de997 (contained in merge f5b90d2c) diff.test.ts classifies .mts/.cts as code and sync.test.ts proves a .mts-only commit still takes the full rebuild path. Full suite re-run on the merged branch: 11641 pass, 0 fail.",
      "verifier": "orchestrator re-run plus an independent second review of 771de997"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 771de997 widens CODE_EXT and explains why it differs from the graph parser's SOURCE_EXTENSIONS; merged to main in f5b90d2c via PR 636."
    }
  }
]
```
