# Flow Journal

- 2026-09-04T06:33:35.496Z - flow created
- 2026-09-04T06:34:57.211Z - task-done: T1: Collect remaining context
- 2026-09-04T06:34:57.303Z - task-added: T5: Freshness queue writer + post-commit hook body, append-only, 50ms budget (AC6,AC14)
- 2026-09-04T06:34:57.378Z - task-added: T6: Change classification over SymbolNode.signature with honest degradation (AC1,AC2,AC4)
- 2026-09-04T06:34:57.459Z - task-added: T7: Impact propagation: edge-type policy, confidence decay, reason chains (AC3,AC13)
- 2026-09-04T06:34:57.534Z - task-added: T8: Both freshness paths: git range and VerifiedScope fallback (AC11,AC12)
- 2026-09-04T06:34:57.635Z - task-added: T9: keryx wiki freshness: categories, limitations, --json, exit 0 always (AC5,AC7,AC8,AC9)
- 2026-09-04T06:34:57.733Z - task-added: T10: Orphan category projected from wikiPruneOrphans, not reimplemented (AC10)
- 2026-09-04T06:34:57.834Z - task-added: T11: Tests per AC incl. no-git, absent graph, corrupt queue line, hub-module propagation (AC15)
- 2026-09-04T06:34:57.938Z - frozen: 15 criteria; checksum recorded
- 2026-09-04T06:34:58.037Z - started

## 2026-09-04 — T6 and T7: classification and propagation

### Hub blast radius, measured rather than assumed

The plan named this as a risk and demanded a real measurement, not a fixture.
On the actual graph (1124 nodes, 3406 edges, 373 describes edges, 55959 call
edges), a single change propagated:

| change | pages reached | must-refresh / review-suggested / fyi |
|---|---|---|
| `src/lib/fs.ts` signature | 37 of 50 | 1 / 23 / 13 |
| `src/lib/fs.ts` body | 1 | 0 / 1 / 0 |
| `src/lib/config-dir.ts` signature | 17 | 1 / 3 / 13 |
| `src/gdgraph/types.ts` signature | 10 | 1 / 6 / 3 |
| `src/wiki/service.ts` signature | 10 | 3 / 2 / 5 |
| `src/wiki/service.ts` body | 3 | 0 / 3 / 0 |

2–5 ms per call, so speed is not the concern.

**The decay does bound the walk, but it does not make a hub change quiet.**
A signature change in `src/lib/fs.ts` reaches 74% of the corpus. That is not
wrong — a utility that half the repository imports genuinely can invalidate
that much prose — but 23 advisory rows from one commit is more than a person
will read, and an unreadable backlog is an ignored one.

The wrong fix would be a fan-out cap. The specification rejects arbitrary hop
limits for a reason, and a cap on breadth is the same instrument wearing a
different hat: it would silently drop real signal with no way to tell which.

The right fix is at presentation, and it belongs to T9: **`wiki freshness`
should show `must-refresh` and `review-suggested` by default, with `fyi`
behind a flag.** The data stays complete, the default view stays actionable,
and nothing is discarded. Recorded here so T9 does not have to rediscover it.

Also worth noting for the same reason: a `body` change reaches exactly one
page in every case measured. The direction rules are doing real work — most
of the fan-out cost is paid only by the class that has earned it.

### Classification: what it can and cannot claim

`signature` detection reuses the tree-sitter adapter over both revisions of a
file rather than adding a second parser; the adapter already accepts arbitrary
`FileRecord`s, so a file's previous content can be extracted the same way its
current content is.

Without that layer the classifier returns `body` for any substantive change
and never `signature` (AC4), and the same holds when the extractor throws.
Both directions were chosen deliberately: a guessed `signature` routes a page
to prose enrichment, which is the expensive path, on no evidence.

The cosmetic normaliser walks string and template literals so a `//` inside a
URL is never read as a comment, and returns the input unchanged when it
cannot parse confidently. That failure direction costs a wasted backlog entry;
the opposite would silently drop a real change and nobody would learn of it.
- 2026-09-04T07:05:33.883Z - task-done: T6: Change classification over SymbolNode.signature with honest degradation (AC1,AC2,AC4)
- 2026-09-04T07:05:33.983Z - task-done: T7: Impact propagation: edge-type policy, confidence decay, reason chains (AC3,AC13)
