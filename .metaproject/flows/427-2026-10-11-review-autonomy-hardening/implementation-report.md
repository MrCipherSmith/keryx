# Flow 427 — Implementation report

Model: openai-codex/gpt-6.1-sol. Baseline: 00879558256cef065f5e22fb0df66d227253a180.

1. Baseline isolated from dirty main checkout. Eight findings have regression coverage; only four were directly reproduced in the original audit. Eight archived pre-fix RED runs are not claimed.
2. Ledger restricted to concrete dispatch; ambiguous implicit assignment gives no union coverage. Manifest/content identity invalidates stale/legacy retry coverage and counters.
3. Write/delegate refusal checked before auto-approval across untrusted-origin changes. Review-auto safety floors fall back to human host.
4. Shared parser handles bare/fenced/marked JSON and fails closed on malformed explicit blocks. DONE with open needs_context drives context handling/redispatch.
5. Arbiter cache includes current option IDs. Watchdog recursively hashes artifacts, detecting nested and same-size changes.
6. Typecheck PASS; 1639 tests PASS, 0 FAIL, 76 files; git diff --check PASS. Deterministic lifecycle passes without model calls. Independent audit was partial; parent inspection covered remaining agent gates and retry-plan changes.

Log: .metaproject/data/review/flow427-final-tests.log. No live review, a work project run, commit, push, PR, CI or release performed. PR/CI and owner confirmation remain outstanding; Flow is not closed. Local tests are not CI evidence.
Separate dispatch-wave and original live acceptance criteria remain outside this hardening scope.
