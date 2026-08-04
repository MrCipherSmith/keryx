# Memory search: regex-guards-lose-to-spellings lesson

Results: 5

### 1. A fix round needs its own review: three consecutive rounds each introduced a blocker  (score 1.826)
- type: lesson | status: accepted | confidence: high
- matched 2/6 terms; status accepted; confidence high
- scopes: module:core, entity:project-registry
- provenance: review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133)
- summary: On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
- entry: lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md

### 2. A shell allowlist matched against the raw command string is not a security boundary  (score 1.8)
- type: lesson | status: accepted | confidence: high
- matched 2/6 terms; status accepted; confidence high
- scopes: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
- provenance: flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/`
- summary: A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
- entry: lessons/allowlist-not-a-boundary.md

### 3. The keryx on PATH is a stale build; the review pipeline does not exercise the code under review  (score 1.659)
- type: constraint | status: accepted | confidence: high
- matched 1/6 terms; status accepted; confidence high
- scopes: module:review, memory, entity:managed-review-package
- provenance: fix-round review of PR #220 (flow 133)
- summary: `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
- entry: constraints/stale-installed-keryx-binary.md

### 4. Flow ids are allocated per clone, not per checkout  (score 1.633)
- type: constraint | status: accepted | confidence: high
- matched 1/6 terms; status accepted; confidence high
- scopes: module:tasks, entity:flow
- provenance: flow 116 (fix duplicate flow ids)
- summary: `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
- entry: constraints/flow-ids-allocated-per-clone.md

### 5. OpenTUI: alignSelf on a transcript box collapses its intrinsic height  (score 1.631)
- type: lesson | status: accepted | confidence: high
- matched 1/6 terms; status accepted; confidence high
- scopes: module:tui, entity:transcript-blocks, shell-chrome
- provenance: flow 115
- summary: In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
- entry: lessons/tui-alignself-height-collapse.md
