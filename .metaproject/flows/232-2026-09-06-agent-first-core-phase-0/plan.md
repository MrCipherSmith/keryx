# Phase 0 implementation plan
Version: 0.1.0

## Approach
Two independent TDD lanes: M01 routing writer and M10 script/budget correctness. Separate test creators first; then task-implementer per lane; both integrate on the same feature branch with exclusive ownership. Parent serializes shared package/config edits and all flow state. Reuse existing public entrypoints and owner writers.

Chosen: shared pure render + shared writer for the two routing files; additive real tool-call limit or explicitly supported round budget with honest terminal outcome. Rejected: copy another renderer into rules (drift), remove ignored options and claim cap works (false guarantee), run paid models for deterministic budget validation (unnecessary).

## Verification tasks
Each lane has a tracked RED task and implementation task. Separate tracked integration verification covers focused regression, root and scripts typecheck, lifecycle sequences and offline stub report. A tracked independent review follows; discovered fixes get tasks/attempt records. Documentation/handoff is tracked too.

## Coverage
M01 and M10 are owned here. Contributions to AFC-16/21 stay partial until full phase 3/6 adapter and lifecycle gates. Shared first-phase completion does not close all 49 requirements.

## Tracking
Use flow CLI tasks as executable state. Root controls cross-flow dependency gates and writes the program map. No completion, PR or merge until work is verified and user completion choice is resolved.
