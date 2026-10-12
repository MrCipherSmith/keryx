# Review of PR 852 (flow 390): flow origin

Round 1 of 1. Independent Sonnet code-reviewer, run before PR #852 merged (merge 7d306103307fa0df8863c637406fd5e0180be34e; PR head f4b5e4f74060f7db5c847a067f9bf64ba8a134b6, which carries both fixes below). The reviewer verified: the quote is stored byte for byte, an old flow.json without an origin still loads, an explicit outcomeAuthor is kept, origin-set is journaled, and the G1a table has an unknown bucket.

**F-001 and F-002 (major, fixed before merge).** A TS2322 typecheck failure from a required `OpenEntry.origin`, and `flow origin set` throwing on an invalid kind against AC7. Both fixed in f4b5e4f74060f7db5c847a067f9bf64ba8a134b6; F-002 has two new tests in `src/flow/origin-never-gates.test.ts`.

**F-003 and F-004 (minor, not blocking).** originSet keeps the previous quote and source when the kind changes; `/flow origin` with no id prints every flow. Both are recorded as follow-ups. Neither is dismissed: no human has decided that, and a dismissal is a human act. They stay open until a person fixes or dismisses them.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow390-sonnet-code-reviewer",
    "severity": "major",
    "problem": "`OpenEntry.origin` was declared required in src/product/types.ts, but src/scheduler/digest-content.test.ts builds an OpenEntry without it. The typecheck fails with TS2322.",
    "impact": "The PR could not pass typecheck-and-tests; the origin field is new and every existing OpenEntry producer would have had to change.",
    "suggested_fix": "Make `origin` optional on OpenEntry and have the reader treat absence as unknown.",
    "evidence": "Read src/product/types.ts line 113 at f48b90ee and the construction in src/scheduler/digest-content.test.ts. Fixed in f4b5e4f7 before merge.",
    "confidence": "high",
    "file": "src/product/types.ts",
    "line": 113,
    "quote": "readonly origin: OriginReading;",
    "class_scope": {
      "sites": [
        "src/product/types.ts:113 (OpenEntry declaration)",
        "src/product/open.ts:73 (openEntryLines reads entry.origin)",
        "src/product/service.ts (builds OpenEntry rows)",
        "src/scheduler/digest-content.test.ts (builds OpenEntry without origin)"
      ],
      "enumeration_method": "keryx ctx rg -l 'OpenEntry\\b' src: four files, all four read for a construction or a read of the origin field."
    }
  },
  {
    "id": "F-002",
    "reviewer": "flow390-sonnet-code-reviewer",
    "severity": "major",
    "problem": "`keryx flow origin set <id> robot --reason x` threw and exited 1 on an invalid kind. AC7 says an invalid origin never fails a command: it is reported and the flow carries on.",
    "impact": "AC7 violated for the one write path that takes a kind from the operator. The old text of the throw was in src/flow/service.ts originSet.",
    "suggested_fix": "Report the invalid kind as a note, leave the origin unchanged, exit 0; add tests for the service and for the CLI.",
    "evidence": "Read src/flow/service.ts originSet at f48b90ee: `throw new Error(`origin kind must be one of ...`)` before the mutate. Fixed in f4b5e4f7 with two tests in src/flow/origin-never-gates.test.ts, before merge.",
    "confidence": "high",
    "file": "src/flow/service.ts",
    "line": 984,
    "quote": "async originSet({ cwd, id, kind, reason, quote, source }): Promise<OriginSetResult> {",
    "class_scope": {
      "sites": [
        "src/flow/service.ts originSet (threw on an invalid kind)",
        "src/flow/service.ts:735 flow init --origin (already reports an invalid kind, no throw)",
        "src/flow/origin.ts:52 and :81 (readOrigin and resolveOrigin return undefined or a note)"
      ],
      "enumeration_method": "keryx ctx rg 'isOriginKind\\(' in src excluding tests: five call sites, each read for a throw on an invalid kind; only originSet threw."
    }
  },
  {
    "id": "F-003",
    "reviewer": "flow390-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "originSet inherits the previous quote and source when the kind changes: a human-request to agent-proposal change keeps the human's source and quote unless the caller overrides them.",
    "impact": "An origin recorded as agent-proposal can still carry the human's verbatim quote and source, which reads as the human having asked for it. Not blocking: the change is journaled and the quote is not used as evidence for a non-human kind.",
    "suggested_fix": "Drop the inherited quote and source when the kind changes, or require them explicitly.",
    "evidence": "Read src/flow/service.ts lines 1003-1007: `quote` and `source` fall back to `before?.quote` and `before?.source` whatever the new kind is.",
    "confidence": "high",
    "file": "src/flow/service.ts",
    "line": 1005,
    "quote": "quote: quote !== undefined && quote.length > 0 ? quote : before?.quote,"
  },
  {
    "id": "F-004",
    "reviewer": "flow390-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "`/flow origin` with no id loads every flow and prints one block per flow, which is a very large output on a repository with hundreds of flows.",
    "impact": "The TUI transcript fills with output nobody asked for. Not blocking: it is read-only and the id form is the intended use.",
    "suggested_fix": "Cap the listing, or list only flows whose origin is not unknown, with a count of the rest.",
    "evidence": "Read src/tui/flow-origin-command.ts lines 98-101: `service.list({ cwd })` and a loop over every summary.",
    "confidence": "high",
    "file": "src/tui/flow-origin-command.ts",
    "line": 98,
    "quote": "const flows = await service.list({ cwd });"
  }
]
```
