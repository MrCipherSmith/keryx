# PR #792 review (flow361-pr792-review)

No blockers. Nothing gates: every kind consumer (freeze, ac update, ac kinds, governance, TUI, check-ac) reports only, and freeze prints its distribution inside a swallowed try/catch after the freeze is saved. No existing frozen criterion changes behaviour (no `[verify:` in the 339-flow corpus outside flow 361 and the product-module flow). Six findings, all minor or info.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow361-pr792-review",
  "severity": "minor",
  "problem": "The trailing-marker anchor is computed on the code-span-masked text, so a code span after the marker is trimmed away with the padding and the marker still reads as 'last on the line'. stripVerifyMarker then deletes everything after the marker start. Probe on the branch: parseAcKindText('see `a` [verify: judged] `b`') returned judged with no error and stripVerifyMarker returned 'see `a`'; 'x [verify: exec `bun test`] `keep.ts`' returned exec/bun test with no error and stripped to 'x'. A trailing bracket has the same reach: 'x [verify: judged] and [1]' is an error, yet stripVerifyMarker returns 'x'.",
  "impact": "A criterion whose marker is not the last thing on the line is accepted as valid (the spec says it must be an error), and the prose after the marker, including backticked artefacts, is silently dropped from the text check-ac uses for token extraction and classification. Only reachable by hand-authored lines, none in the current corpus.",
  "suggested_fix": "Anchor on the unmasked text: require text.trimEnd() to end in ']' and the last '[verify:' to be the last marker (or compute end from the unmasked string and mask only to find marker starts); return the text unchanged from stripVerifyMarker when the marker is not valid.",
  "evidence": "Ran the exported functions from src/flow/ac-kinds.ts under bun on the three strings above; read scanMarkers.",
  "confidence": "high",
  "file": "src/flow/ac-kinds.ts",
  "line": 94,
  "quote": "const end = masked.trimEnd().length;",
  "class_scope": {
   "sites": [
    "src/flow/ac-kinds.ts:scanMarkers",
    "src/flow/ac-kinds.ts:stripVerifyMarker",
    "src/flow/ac-kinds.ts:parseAcKindText"
   ],
   "enumeration_method": "read the module in full and probed the exported parse and strip functions"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow361-pr792-review",
  "severity": "minor",
  "problem": "acReseal re-seals a stale checksum over a file that changed after freeze (the documented reseal case: file committed at HEAD, seal older) but does not re-derive acKinds. acKinds stays whatever the freeze or the last ac update parsed, so it can disagree with the file the new seal now covers. Spec AC6 says the derived field and the sealed file never disagree.",
  "impact": "governance report and the /flows AC tab read flow.acKinds, not the file, so after a reseal they show the old kinds (or 'not recorded' for a legacy flow whose file now carries markers). flow ac kinds reads the file and would say something different.",
  "suggested_fix": "Set flow.acKinds = await deriveAcKinds(cwd, dir, flow.id) next to flow.acChecksum = current in acReseal (it never voids confirmations, so nothing else changes).",
  "evidence": "service.ts acReseal writes flow.acChecksum = current and saves; acKinds is assigned only at freeze (line 532) and acUpdate (line 804). No test covers reseal with a changed marker.",
  "confidence": "high",
  "file": "src/flow/service.ts",
  "line": 854,
  "quote": "flow.acChecksum = current;",
  "class_scope": {
   "sites": [
    "src/flow/service.ts:acReseal",
    "src/flow/service.ts:freeze",
    "src/flow/service.ts:acUpdate"
   ],
   "enumeration_method": "searched every assignment to acChecksum and to acKinds under src (three checksum writes, two acKinds writes)"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow361-pr792-review",
  "severity": "minor",
  "problem": "The marker is stripped for token extraction and classification but not for the Jev question: questionFor sends criterion.text (with the trailing marker) to the model, and the same string sizes the batch. AC5 is therefore true of facts but a marked criterion still reaches Jev differently from its unmarked twin. verdict.text also carries the marker into the check-ac report and the AC cache.",
  "impact": "A `none — <reason>` or `exec <command>` marker becomes part of the noul question and can bias the likely-met score; an exec command is sent to a provider (redacted only by redactSensitiveText). Marked and unmarked twins can get different verdicts.",
  "suggested_fix": "Build the question from stripVerifyMarker(criterion.text) (keep the raw text for display if wanted), and add a test that the question string is identical for a marked and an unmarked twin.",
  "evidence": "check-ac.ts questionFor interpolates redactSensitiveText(criterion.text); parseAcceptanceCriteria keeps the marker in criterion.text; the PR strips only in computeAcFacts and classifyAcCriterionNotCheckable.",
  "confidence": "medium",
  "file": "src/flow/check-ac.ts",
  "line": 258,
  "quote": "Criterion ${criterion.id}: ${redactSensitiveText(criterion.text)}",
  "class_scope": {
   "sites": [
    "src/flow/check-ac.ts:questionFor",
    "src/flow/check-ac.ts:notCheckableVerdict",
    "src/flow/check-ac.ts:evaluatedVerdict"
   ],
   "enumeration_method": "searched criterion.text and parseAcceptanceCriteria/readAcCriteria consumers under src; other readers (goal-command, update.ts) only match phrases or count lines"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow361-pr792-review",
  "severity": "minor",
  "problem": "A flow with no acKinds is always labelled 'predates verification kinds' (governance) or 'frozen before kinds existed' (TUI), but the field is also absent on every flow that has simply not been frozen yet (acChecksum null). summarizeAcceptance never looks at acChecksum, and readAcCriteria counts the placeholder line of a fresh criteria file.",
  "impact": "A draft flow created today reports 'all N unclassified (predates verification kinds)', which is a false statement about its history, and the same wording appears in the AC tab.",
  "suggested_fix": "When flow.acChecksum is null report 'not frozen yet' in both surfaces; keep 'predates verification kinds' for a frozen flow with no acKinds.",
  "evidence": "governance/accountability.ts summarizeAcceptance branches only on readAcKindRecords(flow.acKinds); report.ts renderAcceptanceLine and tui/ac-kinds-surface.ts formatAcKindLines branch only on absence.",
  "confidence": "medium",
  "file": "src/governance/report.ts",
  "line": 124,
  "quote": "all ${total} unclassified (predates verification kinds)",
  "class_scope": {
   "sites": [
    "src/governance/accountability.ts:summarizeAcceptance",
    "src/governance/report.ts:renderAcceptanceLine",
    "src/tui/ac-kinds-surface.ts:formatAcKindLines"
   ],
   "enumeration_method": "searched every reader of flow.acKinds (accountability, aggregate, inspector-sources, ac-kinds-surface)"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow361-pr792-review",
  "severity": "minor",
  "problem": "The rule puts the per-requirement verification field in the Specification Contract ('every requirement in the specification'), while the spec of record says the PRD contract gains it (specification.md integration table: 'PRD contract gains a per-requirement verification field'; prd.md R4: 'The PRD contract ... gains a per-requirement verification field'). The package's own requirements (prd.md R1-R6) carry no Verification: line, so under the rule as written the Verify phase has no defined target and the package itself is not in its own format for requirements.",
  "impact": "The docpack Verify phase, which a model runs, is told to fail a package for a field whose location contradicts the spec; a package written to the spec (field in the PRD) can be failed, or the check run against the wrong file. AC8 is a judged criterion, so no test catches it.",
  "suggested_fix": "State the field once, in the PRD contract where the spec puts it (and name what 'requirement' means there), and make SKILL.md Phase 4 check the PRD, or amend the spec to say Specification Contract; keep both bundled copies identical.",
  "evidence": "Rule text at the quoted line and line 100; spec table and prd.md R4 read in full. Both rule/SKILL copies are byte-identical to their .metaproject twins (diff), and the docpack SKILL.md is at 172 lines against a ceiling of 172, so it passes.",
  "confidence": "medium",
  "file": "src/gdskills/bundled/rules/core/requirements-package-standard.mdc",
  "line": 96,
  "quote": "- a verification field on every requirement (see Verification Field below).",
  "class_scope": {
   "sites": [
    "src/gdskills/bundled/rules/core/requirements-package-standard.mdc",
    ".metaproject/rules/core/requirements-package-standard.mdc",
    "src/gdskills/bundled/skills/planning/docpack-orchestrator/SKILL.md"
   ],
   "enumeration_method": "read the rule diff and the spec integration table and PRD R3-R5; diffed both bundled copies against the .metaproject copies"
  }
 },
 {
  "id": "F-006",
  "reviewer": "flow361-pr792-review",
  "severity": "info",
  "problem": "Two assertions in the never-gates test can pass on nothing: the structural test skips a missing file silently (the list names machine.ts, which may not exist, so a rename of store/confirm-token/ac-reseal would also pass), and the malformed-marker freeze test asserts only that the output contains the string 'AC1'.",
  "impact": "The 'store, state machine and gates never read a kind' guarantee is weaker than its name; a moved gate file is no longer checked, and the freeze warning text is not pinned.",
  "suggested_fix": "Fail when a listed file is absent (or resolve the gate files by search), and assert the warning names AC1 with the malformed-marker message and the 'read as unclassified' note.",
  "evidence": "ac-kinds-never-gates.test.ts: readFile(...).catch(() => null) followed by continue; malformed test ends with toContain(\"AC1\").",
  "confidence": "high",
  "file": "src/flow/ac-kinds-never-gates.test.ts",
  "line": 177,
  "quote": "if (text === null) continue;",
  "class_scope": {
   "sites": [
    "src/flow/ac-kinds-never-gates.test.ts:the store, the state machine and the confirm/complete gates never read a kind",
    "src/flow/ac-kinds-never-gates.test.ts:freeze of a flow with a malformed marker still completes, and says so"
   ],
   "enumeration_method": "read the test file in full; also read the corpus, reseal, governance and TUI tests (those assert real values and fail on an empty corpus)"
  }
 }
]
```
