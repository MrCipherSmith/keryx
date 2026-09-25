# Implementation Plan
Version: 0.1.0
Date: 2026-09-26
Agent: flow-orchestrator

## Approach
Keep `openai` as native Platform API identity and introduce `openai-codex` for subscription access. Prefer existing device-code protocol (browser verification, no localhost callback required) rather than advertising an unimplemented PKCE-loopback option. Research the primary OpenAI Codex protocol before implementing transport. Reuse native Responses parsing where its contracts fit, but isolate subscription request shaping, authentication and refresh. Keep tokens out of environment and child processes. Maintain compatibility for legacy stored `openai` grants.

## Alternatives
- API-token substitution: rejected because a ChatGPT token is not a Platform API key.
- Codex app-server sidecar: documented integration option, but adds an external executable and a second agent loop; evaluate only if native protocol cannot support Keryx tools safely.
- Browser loopback plus device-code: defer second login UX unless needed; device-code is browser-completed and works locally/headlessly.

## Tasks and verification
1. Freeze behavior and verify upstream auth/transport contracts.
2. Write regression tests before implementation; record RED.
3. Implement bounded OAuth lifecycle and native subscription provider.
4. Integrate provider selection/connection management and document usage.
5. Run focused tests, typecheck, lint, build, health and independent review; repair findings.
6. Commit verified work and provide handoff; release and live personal login follow separately.

## Risks
Upstream subscription protocol may evolve. Offline fixtures prove request/stream contracts, not the user's entitlement or live service availability. No real credential is read or sent during implementation tests.
