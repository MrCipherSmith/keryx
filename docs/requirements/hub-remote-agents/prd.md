# Remote agents product requirements
Version: 0.1.0

Status: planned; no Hub-to-machine control plane is claimed to exist.

## Problem and goal

Project context and review live in Hub, while developer code, containers, models and credentials remain on individual machines. The owner needs to launch and observe coding work from the web without SSHing into each machine, exposing local listeners, or moving application environments to Hub.

Users: human operators launch/control work, reviewers inspect results, machine owners explicitly enroll and limit their own serve instances, and agents execute under local authority. First usable outcome: from a phone, choose one of two online machines and a registered clean checkout, launch a native Keryx coding task, answer a tool approval, observe progress/cancel, then inspect its Code Revision/Evidence in Hub.

## Requirements

- R1: Enroll each machine explicitly with a separate revocable, project-scoped machine credential and locally authorized mappings. Verification: judged.
- R2: List machine connectivity, checkout availability and truthful agent readiness; remote authority never exceeds local policy. Verification: judged.
- R3: A human operator launches an exact in-progress Flow/spec/checkout/profile through an idempotent web operation; dirty or busy checkouts are refused in MVP. Verification: judged.
- R4: Native Keryx execution has real tools, live progress and bounded local supervision, rather than a placeholder prompt/result call. Verification: judged.
- R5: Reconnect, duplicate messages and ambiguous process crashes do not silently launch a second run. Unknown is a first-class state. Verification: judged.
- R6: Remote approval is human-only, exact-action-bound, expiring, one-time and subordinate to local policy. Verification: judged.
- R7: Cancellation distinguishes request, acknowledgement and confirmed executor stop, including descendants. Verification: judged.
- R8: Shared wiki/spec invalidations use the same machine channel and existing safe incremental cache synchronization. Verification: judged.
- R9: Results remain immutable review-only artifacts with honest Evidence provenance and human acceptance. Verification: judged.
- R10: Auth revocation, bounded buffers/logs, migration/recovery, tests and local/public transport verification have explicit release gates. Verification: judged.

## Release criteria

- All sixteen acceptance criteria are evidenced for the exact implementation candidate.
- Two independent local serve processes are controlled through actual Hub HTTP/WebSockets; a native coding/approval/cancel test uses the actual runtime with a deterministic provider.
- Public Cloudflare machine routing is either explicitly verified under operator authorization or visibly unavailable; no local test is labeled a public deployment.

## Outcome criteria

- Owner completes the phone-driven two-machine trial above without SSH for individual launches. Observation: selected machine/checkout, durable run events, applied approval/cancel receipts and matching result revision during an owner trial.
- Context becomes current after a Hub wiki change without 15-second polling while connected. Observation: context revision/digest before/after event and after reconnect.
- Team-wide time saved and adoption: not measured — no production telemetry or longitudinal study in this prototype.

## Non-goals and recommendation

No Windows support, browser terminal, arbitrary shell API, automatic package installation, new model subscription, vendor credential extraction, permission-mode escalation, standing approval grants or Git/npm publication. Existing Codex/Claude integrations are not advertised as remotely runnable until an adapter passes its own capabilities and cancellation/approval tests. Implement one supported native adapter end to end, then add other adapters in separate Flows.

## Risks

Existing serve does not assemble coding tools, has finite event replay rather than live subscriptions, and lacks remote cancellation. These are implementation work, not transport-only glue. A network acknowledgement cannot prove that a process started or stopped. Encrypted transport cannot revoke already downloaded data. A locally authorized agent can have side effects before cancellation; the UI must show partial changes and uncertain outcomes accurately.
