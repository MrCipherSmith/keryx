# T41 CI test-runtime boundary

STATUS: DONE; two test paths frozen. No product/dependency changes.

Root Bun CI lacked i18next because a root test imported the browser adapter. Reproduced independently with UI dependency symlink held out:3PASS1FAIL. Moved browser handler→adapter assertion into UI Vitest; actual production createWorkHttp serializes incidentEvidence through a narrow in-memory repository port. Full equality/status checks retain and strengthen the moved assertion. The root realSQLite served Flow/Intent/Attention/schema/WorkClient/capabilities proofs remain unchanged.

GREEN with UI dependency symlink absent:root3tests6assertions. UI focusedcasePASS, full40files198testsPASS; UItypes/fullUIlint/rootfilelint/diffcheckPASS. Assets remain fresh, digest2bce6622c96196cbab25def45a5434d251a7b2121e05af5933278c70e9df799a. UI symlink restored in finally; no NODE_PATH or rootinstall workaround. A notified strict gate may resume.

Exact paths:src/hub/work/http.contract.test.ts and newapps/hub-web/tests/work-server-contract.case.ts. Exact logs/results in ci-boundary-results.json. No index/commit/push.
