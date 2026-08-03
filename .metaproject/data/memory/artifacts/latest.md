# Memory search: stale installed binary

Results: 2

### 1. The keryx on PATH is a stale build; the review pipeline does not exercise the code under review  (score 2.329)
- type: constraint | status: accepted | confidence: high
- matched 2/3 terms; status accepted; confidence high
- scopes: module:review, memory, entity:managed-review-package
- provenance: fix-round review of PR #220 (flow 133)
- summary: `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
- entry: constraints/stale-installed-keryx-binary.md

### 2. A fix round needs its own review: three consecutive rounds each introduced a blocker  (score 1.829)
- type: lesson | status: accepted | confidence: high
- matched 1/3 terms; status accepted; confidence high
- scopes: module:core, entity:project-registry
- provenance: review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133)
- summary: On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
- entry: lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
