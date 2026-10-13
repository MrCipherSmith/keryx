# PR917 P1 fix-round independent review

Verdict: PASS for the targeted P1 fix (static review), not whole-PR acceptance.
Reviewer: independent read-only subagent pr917-p1-security-rereview, sub:8caf2a9c-c0a5-4dd3-ace8-db82fd9c2c50.
Tree: HEAD 290591c7b plus uncommitted P1 source and new regression test; exact reviewed file hashes in tree-hashes.json.

Mandatory fresh external policy and provider/model block-list gate precede candidate ranking. Optional hooks can only restrict further. A null classifier sentinel prevents an unauthorized baseline fallback. Production shell omits optional hook and is now protected. Abort checks and stage error containment introduce no ungated second classifier.

Real provider factory with fake HTTP covers blocked credentialed providers/model patterns, omitted and permissive hooks, positive authorized requests, between-turn policy changes, restrictive hooks and project/user precedence.

No blocking finding in the targeted change.

Limitations: static reviewer did not execute tests. Tests disable JEV; existing JEV client independently checks policy, but alternate-root/config-dir consistency is not established because wrapper does not forward these options into JEV. Revocation during an in-flight call is not covered. Previous CI PASS belongs only to committed 290591c7b, not this working tree. AC11 remains OPEN. No merge/release authorization.
