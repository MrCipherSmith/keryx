# Managed work and native execution binding
Version: 0.2.0

Status: implemented candidate, independent review and final integrated verification in progress. Existing machine wire protocol remains v2.

A native session message can include X-Keryx-Work-Attempt (opaque Attempt ID) and X-Keryx-Work-Version (current positive Attempt version). Both headers are required together. They are an additive HTTP sidecar, not extra fields inside frozen MessageSubmit/FlowAssociation JSON. The original authenticated human operator must still own the native session controller and satisfy every existing v2 authority, configuration, ad-hoc-consent and admission check.

The Hub resolves approved requirement/context pins itself and reserves original project/actor/session/operation/Attempt/pins inside the same SQLite transaction as original admission. Queued requests retain that reservation across restart. Actual run allocation binds the run and original command to that reservation; knowing a run ID alone is insufficient. Replays retain the original operation and run identity. Unknown allocation or execution must block replacement allocation, including delayed queue admission. A bound reservation never changes its run ID.

ExecutionLink records the actual machine/checkout/session/turn/run and original reservation pins. It confers no new controller lease, permission or acceptance authority. Existing runtime context consumption remains explicitly unverified: pinning approved work metadata does not prove a model read every referenced document. Required approved specification content is automatically included in a ContextSnapshot; exact archived versions remain the source, never silently latest.

Active/unknown executions and unresolved reservations block submission and work cancellation. Physical cancellation continues through existing native v2 operator actions. Work state changes never release physical leases. Terminal observations refresh from original run/command/machine facts; a successful native turn alone never accepts product work. An Attempt can contain several runs; manual work can contain zero.

Machine result ingestion is not automatic in this candidate. Agents or humans explicitly report progress, exact Git/document/result subjects and Evidence through work API/CLI/MCP. Such reports remain contributor-report; transport through Hub does not promote them into trusted CI Evidence. Git/CI observations are separately configured metadata. Conservative known-refusal queue recovery retains the immutable original allocation and can require an explicit successor operation/Attempt; it never silently replaces an ambiguous run.
