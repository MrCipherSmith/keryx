# Decisions

- R1-SEC-001: acted-on — Rewritten per-comment in 9950cbe9; the invocation itself was then found broken and fixed in 00f01b71, with an execution test. (valid_followup, standalone_review).
- R1-SEC-002: acted-on — Conditional added to both input schemas and both registered; validator now returns `$.operator_confirmed: Missing required property` (2907d530). (valid_followup, standalone_review).
- R1-SEC-003: acted-on — Stated in Step 3 and the two steps reconciled (9950cbe9). (valid_followup, standalone_review).
- R1-ARCH-001: acted-on — Wired into the Step 9 dispatch with the owner-side row (9950cbe9). (valid_followup, standalone_review).
- R1-ARCH-002: acted-on — Typed and registered (9950cbe9); the conditional that makes the refusal real added in fd726ef4; completion_outcome made required in 2907d530. (valid_followup, standalone_review).
- R1-LOGIC-001: acted-on — `rules()` helper added and all three re-anchored (fd726ef4); re-verified RED in round 2. (valid_followup, standalone_review).
- R1-LOGIC-002: acted-on — Fixed in fd726ef4; the canonical STATUS line it deleted was restored in 4a2b355f with both halves pinned. (valid_followup, standalone_review).
- R1-LOGIC-003: acted-on — Row added plus the late-arrival rule (fd726ef4). (valid_followup, standalone_review).
- R2-SEC-101: acted-on — Fixed in 00f01b71 with an execution test; mutation-checked three ways (broken invocation, missing guard, broken detector regex) — each fails one test. (valid_followup, standalone_review).
- R2-SEC-102: acted-on — All four required in 2907d530; the guard extended to walk nested required keys. (valid_followup, standalone_review).
- R2-ARCH-101: acted-on — Both fixed in 2907d530; mutation-checked by dropping the nested key. (valid_followup, standalone_review).
- R2-ARCH-102: acted-on — Row replaced with a refusal and completion_outcome made required (2907d530); the same payload now returns `$.completion_outcome: Missing required property`. (valid_followup, standalone_review).
- R2-LOGIC-R001: acted-on — if/then added to all three copies (fd726ef4); the payload is now refused. (valid_followup, standalone_review).
- R2-ARCH-108: dismissed-deprioritised — Deferred deliberately: this changes the flow package's durable record and its completion gate, which is not this branch's subject. Recorded for its own flow. (out_of_scope, standalone_review).
