# Review report — flow 129, review pipeline

Round: 1 (first pass)
Scope: merge-base(main)..HEAD on fix/review-pipeline-metaproject-context

## Findings

### [F-001] The class_scope rule was enforced in a schema no real path validated against
- **Severity**: major
- **Problem**: the requirement landed only in the two finding schemas. Reviewer skills emit markdown, and `keryx review ingest` accepted a non-conforming major finding at exit 0 — verified by executing it. The only path applying the schema was `keryx skills contracts validate` on a hand-written JSON file, which nothing runs automatically.
- **Impact**: the flow's central rule would have been prose, exactly like the guidance it replaced.
- **class_scope**:
  - sites: ["src/review/managed.ts ingest path", "src/gdskills/contracts/review-finding.schema.json", "src/gdskills/bundled/skills/review/review-orchestrator/reviewer-finding.schema.json", "15 reviewer SKILL.md finding formats"]
  - enumeration_method: "traced every path a finding travels — markdown report, ingest parser, contracts validator — and executed ingest against a non-conforming report"
- **Fix**: applied; classScopeViolations refuses before the package is written.
- **Confidence**: high

### [F-002] normalizeFindings read severity from the heading line only
- **Severity**: major
- **Problem**: severity came from the F-NNN line, but every reviewer format puts it on the line below, so those findings were recorded as the default regardless of what they said — which also made the class-scope rule unreachable for the findings it governs.
- **Impact**: silently wrong severity in every ingested package, and a guard that could not fire.
- **class_scope**:
  - sites: ["src/review/managed.ts severityFromLine call site"]
  - enumeration_method: "read every caller of severityFromLine — one site — and checked all 15 reviewer finding formats to confirm each places severity below the heading"
- **Fix**: applied, then corrected again after a live run: an explicit declaration now outranks a keyword in the prose.
- **Confidence**: high

### [F-003] A comment claimed a uniqueness test that did not exist
- **Severity**: minor
- **Problem**: the sibling-ref resolver's comment said a named test fails if two schema roots ever hold the same basename. No such test had been written.
- **Impact**: none today, the names are unique — but it is the exact failure the lesson behind this flow names, committed inside the flow.
- **Fix**: applied; the test exists and asserts non-vacuously.
- **Confidence**: high

### [F-004] The reviewer detector is a substring match
- **Severity**: minor
- **Problem**: reportsFindings treats any SKILL.md containing the word as a finding-reporting reviewer.
- **Impact**: the denominator is approximate. All 20 skills were checked by hand and the classification is currently correct for every one.
- **Fix**: not applied; recorded as a known limit rather than claimed correct.
- **Confidence**: high

### [F-005] Procedure guards over SKILL.md match on prose
- **Severity**: info
- **Problem**: the orchestrator-procedure assertions match markdown text, so a reworded-but-correct instruction turns them red and a reworded-but-wrong one can stay green.
- **Impact**: weaker than the schema guards; stated in the test header rather than implied.
- **Fix**: none. The enforcement that bites is reviewer-input.schema.json.
- **Confidence**: high
