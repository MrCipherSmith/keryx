# Keryx Desktop Telegram Implementation Plan
Version: 0.4.0

**Status: spec ready.** This sequence starts after the package is accepted for implementation.

| Phase | Work | Exit evidence |
| --- | --- | --- |
| 1. Bootstrap, manage and pair | Add the app-level native supervisor and local, silent configuration/credential bootstrap using the existing CLI helpers. Implement authenticated readiness, external-instance discovery and Start/Stop/Restart in machine settings. Reuse channel status and test/disconnect. Add protected token entry, local QR and manual pairing, and a shared revisioned channel controller for Desktop and terminal. Implement candidate readiness, same-bot handoff, isolated different-bot pairing and conditional rollback. Migrate existing Telegram policy and rendering to the same record and preserve the disconnected revision across restarts. | V1, V9 |
| 2. Bind the ACP session | Introduce a per-held-session bridge adapter behind the explicit Desktop capability. Add versioned exact-owner registration in serve. Wire attach, detach, machine revocation, topic link, heartbeat, state updates, shutdown and generation invalidation. | V2, V7 |
| 3. Drive a live turn | Route Desktop and Telegram messages through the shared admission slot. Propagate verified sender identity to admission before execution. Add source-labelled updates, busy refusal, dedupe, reply/progress mirroring and scoped cancellation. | V3, V4, V6 |
| 4. Mirror operator decisions | Share the decision record with both projections. Apply the delegated Ask ceiling, callback matching, eligibility and redaction. | V5, V6 |
| 5. Accept and document | Run controlled GitHub CI and the disposable-bot macOS scenario. Document how to set up and manage serve from Desktop, connect, select a chat, recover and detach. | V1–V9 and release help |

The service supervisor and versioned session binding work can proceed in parallel. Channel replacement can be developed against fake bindings in phase 1. Active-binding cutover evidence requires phase 2 and must be rerun once the ACP adapter is wired. Phase 3 depends on a live binding and phase 4 depends on trusted turn provenance. Keep the capability unavailable to production Desktop users until turn authority and approval handling are verified. Leave the terminal entry points compatible.

## Separate later milestones

- Background session ownership and explicit reattaching after Desktop exits. Evaluate Team Hub's machine session host before deciding what to share.
- Project-level intake, new sessions from the phone and wider command coverage. Reconcile with the [future Telegram Transport package](../keryx-telegram-transport/README.md) before expanding context or permissions.
