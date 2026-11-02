# T39 UI/MCP normal-merge integration

STATUS: DONE; all owned paths frozen. Parent integrates/stages; no child index/commit/push.

Candidate33ef4c0f1 is the UI base. Kept its Evidence Overview/click lookup, full shared revision paging, submit-time membership filters, version-aware cache merges, refresh fallbacks, collapsed approval visibility and live boundary tests. Work schemas remain T37-owned.

Composed remote8dcb765f0 demo event log/result-only receipts with demo polling enablement. Added a RED→GREEN composition regression proving side effects arrive through events and exact-record reads after a result-only receipt, without a full cache export.

Retained remote meaningful WorkSequences, advanced/context/incremental cases; kept actual SDK→Hub limit1 revision pagination assertion alongside candidate bounded-argument test. Retained explicit HubFailure passthrough from MCP body parser, no internal admission bypass. Test adaptations preserve old behavior assertions while matching intentional metadata-only exactsummary and meaningful Evidence report labels/async navigation.

Discarded only equivalent alternative code and duplicate machine collapsed-test variant; candidate dedicatedcollapsed regression plus100row/3run assertions remain. Remote simple Deliveryline guard replaced withcandidate metadata/purpose check; native owner preserves exactsummary API.

Validation: UI39files197tests, UItypes, fullUIlint PASS. MCP14tests135asserts; MCP+actualTCP admission18tests142asserts onpinnedBun1.3.14 PASS. Generated24assets rebuilt and freshnesscheckPASS (input2bce6622c96196cbab25def45a5434d251a7b2121e05af5933278c70e9df799a). Roottypes remaininglegacy.test.ts71 argument mismatch belongsT37, reported. Exact paths and evidence inintegration-ui-results.json.
