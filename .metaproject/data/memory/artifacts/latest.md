# Memory search: code blanks string literals guard

Results: 4

### 1. The keryx on PATH is a stale build; the review pipeline does not exercise the code under review  (score 1.998)
- type: constraint | status: accepted | confidence: high
- matched 2/5 terms; status accepted; confidence high
- scopes: module:review, memory, entity:managed-review-package
- provenance: fix-round review of PR #220 (flow 133)
- summary: `/home/altsay/.local/bin/keryx` is an installed build reporting version `0.1.0`. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
- entry: constraints/stale-installed-keryx-binary.md

### 2. `code()` blanks string literals, so a guard that matches one can never fire  (score 1.785)
- type: constraint | status: draft | confidence: medium
- matched 5/5 terms; status draft; confidence medium
- summary: (none)
- entry: constraints/code-blanks-string-literals.md

### 3. A shell allowlist matched against the raw command string is not a security boundary  (score 1.772)
- type: lesson | status: accepted | confidence: high
- matched 1/5 terms; status accepted; confidence high
- scopes: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
- provenance: flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/`
- summary: A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
- entry: lessons/allowlist-not-a-boundary.md

### 4. A source guard written as a regex loses, one spelling per round  (score 1.085)
- type: lesson | status: draft | confidence: medium
- matched 1/5 terms; status draft; confidence medium
- summary: (none)
- entry: lessons/regex-guards-lose-to-spellings.md
