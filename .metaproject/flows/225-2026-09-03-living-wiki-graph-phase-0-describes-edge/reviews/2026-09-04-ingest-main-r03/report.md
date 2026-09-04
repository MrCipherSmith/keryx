# Flow 225 Managed Review — Round 1

Target: `feat/lwg-phase-0` at `23962dfd`
Base: `main`
Fix round: false

Reviewers: clean-code, logic, architecture.

## Outcome

- 0 blockers
- 1 major (fixed in place)
- 1 minor (fixed in place)
- 1 info (accepted with a stated reason)
- External comments: collection ran against PR head `23962dfd`; zero comments.
- Focused suite after fixes: 231 passed, 0 failed across gdgraph + wiki.
- Full-suite comparison: 48 failures reproduce at the pre-change commit
  `94998d9a` in a worktree, and 48 after — zero regressions, +125 passes.

## Verdict

Three findings, two fixed in place, one accepted with a reason. No finding
challenges the shipped behaviour: the layer is correct on the real corpus
(50 pages, 373 describes edges, 6 undecidable) and the guarantee that made
the design change necessary is pinned by a byte-comparison test.

## Findings

**F-NEW-001 (major, fixed).** The `Describes:` field had two parsers, one in
`describes.ts` and one grown independently in `provenance.ts`. They already
normalised differently — only one handled markdown links — so a page could
resolve one set of paths for its edges and report another as provenance.
This is the same "second, possibly-drifting implementation" failure the
package forbids for module grouping, reproduced inside the package's own
code. The copy is deleted; `provenance.ts` imports the canonical parser.

**F-NEW-002 (minor, fixed).** `buildWikiLayer` selected describable targets
with `!== "asset"`. That negative filter is exactly what broke five call
sites when wiki nodes were going into `nodes.jsonl`, and repeating it here
would admit any future node kind. Now `=== "file"`, with the reason written
down at the site.

**F-NEW-003 (info, accepted).** The layer's bare catch in `buildGraph` makes
a real failure look like a project with no wiki. Kept: it matches the symbol
layer's precedent immediately above it, and a failed graph build is worse
than a missing optional layer. Phase 1's `limitations` channel is the right
place to surface it, and this is recorded there.

## External comments

Collected against PR head `23962dfd`: zero comments. Collection ran — that is
a different fact from no collection, and only the former is clean.

```json keryx:findings
[
  {
    "id": "F-NEW-001",
    "reviewer": "review-clean-code",
    "severity": "major",
    "problem": "`Describes:` frontmatter was parsed by two separate implementations \u2014 `parseDescribesField` in `src/wiki/describes.ts` and `parseDescribesPatterns` in `src/wiki/provenance.ts`.",
    "impact": "Two readers of one field drift. The copies already normalised differently (only one stripped markdown link syntax), so a page could resolve one set of paths for its describes edges and report another as its provenance \u2014 the exact 'second, possibly-drifting implementation' this package forbids elsewhere.",
    "suggested_fix": "Delete the copy in provenance.ts and import the canonical parser from describes.ts.",
    "evidence": "Both functions parse the inline comma form plus the indented block list; provenance.ts's copy lacked describes.ts's markdown-link handling.",
    "confidence": "high",
    "file": "src/wiki/provenance.ts",
    "line": 132,
    "class_scope": {
      "sites": [
        "src/wiki/provenance.ts:132",
        "src/wiki/describes.ts:67"
      ],
      "enumeration_method": "Grepped every reader of the Describes field across src/; these were the only two."
    },
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Both functions existed and parsed the same field; after the fix provenance.ts has no parser and 231 gdgraph+wiki tests stay green."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in commit ff390934 (PR #449): the duplicate parseDescribesPatterns is deleted from src/wiki/provenance.ts, which now imports parseDescribesField from src/wiki/describes.ts. typecheck clean; 231 gdgraph+wiki tests green."
    }
  },
  {
    "id": "F-NEW-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "`buildWikiLayer` derived its set of describable targets with `node.kind !== \"asset\"`.",
    "impact": "That negative filter is precisely the pattern that made putting wiki nodes into nodes.jsonl dangerous \u2014 it admits any node kind added later. Harmless today because the wiki layer is separate, but it re-introduces the shape of the bug this package exists to avoid.",
    "suggested_fix": "Filter positively on `kind === \"file\"`.",
    "evidence": "The package's own specification \u00a73.1 documents five call sites broken by exactly this negative filter.",
    "confidence": "high",
    "file": "src/gdgraph/wiki-layer.ts",
    "line": 74,
    "class_scope": {
      "sites": [
        "src/gdgraph/wiki-layer.ts:74"
      ],
      "enumeration_method": "Reviewed every node filter introduced by this change; this was the only negative one."
    },
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Filter read `!== \"asset\"` at the reviewed tree; tightened to `=== \"file\"` with tests still green."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in commit ff390934 (PR #449): src/gdgraph/wiki-layer.ts filters node.kind === \"file\" instead of !== \"asset\", with the reason recorded at the site. 231 tests green."
    }
  },
  {
    "id": "F-NEW-003",
    "reviewer": "review-architecture",
    "severity": "info",
    "problem": "`enrichBuildWithWikiLayer` is wrapped in a bare catch inside `buildGraph`, so a genuine failure (unreadable wiki, full disk) silently yields no layer.",
    "impact": "A missing layer is indistinguishable from a project with no wiki. Downstream this is safe \u2014 consumers treat an absent layer as 'no information', never as 'nothing is documented' \u2014 but an operator gets no signal that the layer failed.",
    "suggested_fix": "Leave as is for phase 0; phase 1's freshness report already has a `limitations` channel, which is the right place to surface it.",
    "evidence": "Mirrors the tree-sitter symbol layer's existing defensive import at build.ts:155.",
    "confidence": "high",
    "file": "src/gdgraph/build.ts",
    "line": 162,
    "class_scope": {
      "sites": [
        "src/gdgraph/build.ts:162"
      ],
      "enumeration_method": "Both defensive layer imports in buildGraph were reviewed."
    },
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "The catch is bare and matches the established precedent immediately above it."
    },
    "disposition": {
      "state": "dismissed-wont-fix",
      "evidence": "Decided in commit ff390934 (PR #449) and recorded in flow 225's journal: kept deliberately, consistent with the tree-sitter symbol layer's identical defensive import at src/gdgraph/build.ts:155. A failed graph build is a worse outcome than a missing optional layer; phase 1's freshness report carries the limitations channel built for this signal."
    }
  }
]
```
