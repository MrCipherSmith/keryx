# Memory search: fix round review config-dir

Results: 3

### 1. A fix round needs its own review: three consecutive rounds each introduced a blocker  (score 2.398)
- type: lesson | status: accepted | confidence: high
- matched 3/5 terms; status accepted; confidence high
- scopes: module:core, entity:project-registry
- provenance: review rounds on PR #215 (flow 127) and PR #216 (flow 128)
- summary: On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
- entry: lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md

### 2. Flow ids are allocated per clone, not per checkout  (score 1.674)
- type: constraint | status: accepted | confidence: high
- matched 1/5 terms; status accepted; confidence high
- scopes: module:tasks, entity:flow
- provenance: flow 116 (fix duplicate flow ids)
- summary: `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
- entry: constraints/flow-ids-allocated-per-clone.md

### 3. A shell allowlist matched against the raw command string is not a security boundary  (score 1.674)
- type: lesson | status: accepted | confidence: high
- matched 1/5 terms; status accepted; confidence high
- scopes: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
- provenance: flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/`
- summary: A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
- entry: lessons/allowlist-not-a-boundary.md
