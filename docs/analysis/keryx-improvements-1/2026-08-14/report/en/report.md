# Keryx Improvements 1 — Shared Agent Context, memory, and orchestration

**Status:** research complete, packages proposed

**Date:** 2026-08-14

**Worktree:** `keryx-improvements-1`

## Executive conclusion

Shared Agent Context (SAC) is timely and conceptually sound. Its Facts–Work–Know-how split, local-first references, progressive retrieval, trusted actor boundary, and reviewed promotion solve real agent problems: noisy context, stale state, memory poisoning, repeated research, and unsafe transcript-to-memory promotion. The current implementation is nevertheless much stronger as a safety-contract and mechanism suite than as a coherent product workflow. The largest risks are at integration seams, not inside one module.

Verified gaps include:

- the optional candidate policy changes receipt attribution but not the actual selected FWK manifest;
- every overview item is mandatory by default, making small budgets overflow rather than produce useful partial context;
- Flow and durable knowledge are projected from raw files/regexes instead of owner APIs;
- evidence freshness is optimistic, IDs are positional, and `read` does not expose useful detail;
- full session archives are persisted verbatim before security minimisation and without a sealed-session state;
- proposal notes are mutable sidecars outside the reviewed digest;
- idempotency/recovery binding is insufficient across proposals and process retries;
- four of six proposal kinds fall through to Skills;
- accepted target knowledge is not linked back to the workspace;
- proposal review can be performed by the same local subject that proposed it;
- collaboration has no public write surface and shares an incompatible ledger with proposal lifecycle records;
- sessions, workspaces, Flow, and sibling worktrees are not bound into one lifecycle;
- CLI, MCP, and shell adapters duplicate registration and have inconsistent opt-in/discovery semantics;
- project graph/wiki coverage and public documentation lag behind runtime code.

Recommendation: preserve FWK, local-first containment, source ownership, no automatic promotion, and the HTTP identity denial. Pause learned-policy expansion, fix P0 semantics/security, make the local lifecycle coherent and measurable, then add memory and multi-agent coordination only when the deterministic workflow demonstrates benefit.

## Actual integration map

| Area | Current integration | Gap |
|---|---|---|
| Workspace | Local manifest, typed resources, ACL, atomic writes | Manual registry; no session/current workspace/archive/member UX |
| Context Operations | Canonical assembly trace and hash-linked access receipts | Candidate selection not executed; costs are hard-coded zero |
| Flow | First linked JSON file projected read-only | Raw parsing, one Flow only, lossy task-state mapping |
| Facts | Evidence files hashed and referenced | Positional IDs, year-9999 expiry, unpinned changes remain fresh |
| Know-how | Wiki/Memory/Skill Markdown accepted by status regex | No owner authenticity/applicability API |
| CLI | Full `workspace` operator commands | Documentation drift and weak command discovery |
| MCP | `sac.*`, stdio allowed and HTTP denied | Repeated transport checks; no remote principal/capability |
| Shell/Harness | Native `workspace_overview/read` agent tools | Read-only, explicit ID on every call, list through shell execution |
| Session | Complete archive exported as proposal evidence | Verbatim persistence, no scan/TTL cleanup/sealed state |
| Promotion | Immutable proposals, intent, review, owner receipts | Mutable note, self-review, surprising target mapping, no link-back |
| Memory | Canonical writer | Produces draft pointer-heavy note |
| Wiki | Security guard plus direct atomic body write | No canonical owner body-write port |
| Skills | Canonical project-skill creation | Generic decisions/risks/follow-ups pollute Skills |
| Collaboration | Metadata references and service-level record method | No public writer; incompatible mixed `activity.jsonl` schemas |
| Security | Trusted actors, containment, schema validation | Local strict decision is a constant pass object |
| Worktrees | References exist in schema | Storage and containment are checkout-local |
| Policy experiment | Pins, sandbox, corpus, readiness, kill switch | No output-changing runtime selection; self-referential baseline set |
| Graph/Wiki | Project navigation system | SAC component/edges missing or stale |

## Strengths to retain

- SAC never writes Flow state.
- Context Operations owns assembly traces.
- Wiki, Memory, and Skills retain durable-knowledge ownership.
- Client payloads cannot mint actor roles.
- Workspace paths use lexical and realpath containment and FD-safe reads.
- HTTP SAC is denied without verified identity.
- Owner mutations are intended to be receipt-bound and idempotent.
- Promotion is reviewed, not automatic.
- Learned candidates cannot expand authorization or control security gates.

## Highest-priority findings

### Correctness

1. `resolvePolicySelection` returns policy metadata only; its selected IDs do not constrain `assembleAndRecordContext`.
2. Runtime baseline IDs are constructed from evaluation candidate IDs, weakening the subset gate.
3. Public adapters expose no required/optional distinction, so all items become mandatory.
4. Progressive `read` filters the compact manifest instead of returning bounded owner-sanitized content.
5. Unpinned content is compared with its newly computed hash and receives an effectively infinite TTL.
6. `fact-0` and `knowhow-0` can silently change meaning after manifest edits.
7. Flow projection chooses one Flow and maps every non-done task to next.
8. Access cost data is not measured.

### Security and governance

1. Constant strict-pass composition is not an evaluated live policy.
2. Full session transcripts persist before scan/minimisation; capability expiry does not delete them.
3. Session wrap-up requires message count, not terminal/sealed state.
4. Mutable note bytes are not bound to proposal/review/write intent.
5. Same-subject proposal acceptance is allowed in the normal local path.
6. Reusing an idempotency key across proposals can recover an unrelated owner receipt; restart recovery also conflicts with new correlation IDs.
7. Target write and owner-receipt persistence are not one atomic transaction.
8. Proposal IDs and loaded workspace ownership need explicit path/cross-workspace negative tests.
9. Collaboration validation is shallow and its ledger is incompatible with proposal records.
10. Local actor identity distinguishes users, not agents or delegated sessions.

### Product and operability

1. Accepted target knowledge does not appear in the next overview without manual linking.
2. Generic proposal semantics secretly choose a destination owner.
3. No proposal inbox/show/preview exists.
4. No session-to-workspace binding or current workspace tool exists.
5. Sibling worktrees cannot share the checkout-rooted registry.
6. Every read performs a durable locked append with no surfaced retention/pruning policy.
7. SAC enablement and naming differ among CLI, MCP, shell, docs, and command discovery.
8. Phase 4 was a contract walkthrough, not an executable public handoff workflow.

## External-practice alignment

- Anthropic context-engineering guidance supports small, high-signal, just-in-time context, compaction, and specialised subagents. SAC matches the intent but needs real ranked optional retrieval and detail reads: [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- OpenAI's Agents SDK separates application-local context from model-visible context and treats sessions as a separate history lifecycle. A session/workspace binding should therefore carry identifiers and capabilities, not dump all workspace/session data into the model: [Context](https://openai.github.io/openai-agents-python/context/), [Sessions](https://openai.github.io/openai-agents-python/sessions/).
- MCP authorization requires resource/audience-bound credentials and rejects token passthrough. Keryx is right to keep HTTP denied until scoped identity exists: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
- NIST and OWASP agent-security work supports workflow-bound identity, continuous authorization, provenance, and preventing untrusted context from entering memory: [NIST agent identity](https://www.nist.gov/news-events/news/2026/02/new-concept-paper-identity-and-authority-software-agents), [OWASP agentic threats](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/).
- W3C PROV supplies a suitable Entity/Activity/Agent vocabulary for context capsules and promotion chains: [PROV-O](https://www.w3.org/TR/prov-o/).
- LongMemEval and MemoryAgentBench show that retrieval, temporal updates, contradiction handling, learning, and forgetting must be evaluated separately: [LongMemEval](https://arxiv.org/abs/2410.10813), [MemoryAgentBench](https://arxiv.org/abs/2507.05257).
- MultiAgentBench and agent-system scaling/failure studies show that more agents are not automatically better; task topology, verification, termination, and coordination overhead matter: [MultiAgentBench](https://arxiv.org/abs/2503.01935), [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657), [Scaling Agent Systems](https://arxiv.org/abs/2512.08296).

## Proposed requirement packages

### RP-01 — Runtime Truth (P0, M)

Execute an independently computed deterministic retrieval plan; apply selected IDs; introduce explicit mandatory core and ranked optional items; stable IDs; honest measured/unknown costs; real bounded detail; correct changed/untracked freshness.

Key acceptance: output-changing candidate/baseline E2E test, 33/32 partial case, reorder-stable IDs, changed-source freshness test.

### RP-02 — Source-owned FWK Projections (P0/P1, M–L)

Add read-only owner ports for Flow, evidence, Wiki, Memory, and Skills; canonical Flow status/evidence mapping; owner-derived trust/applicability; canonical Wiki decision/body writer.

### RP-03 — Session–Workspace–Flow Binding (P1, M)

Persist optional session binding; add `shell --workspace`, `--session current`, agent-native current/list tools, Flow/worktree workspace preview, and accepted-target link-back.

### RP-04 — Promotion Semantics and Integrity (P0, M–L)

Use exhaustive target intent, owner-rendered review preview, content-address every render input, enforce configurable independent review, scope idempotency by proposal/revision/owner, make recovery restart-safe, validate IDs before paths, and include target link receipt in terminal acceptance.

### RP-05 — Secure Minimal Evidence (P0, M–L)

Require sealed sessions, create a schema-closed structured wrap-up, scan/minimise before persistence, default to selected evidence rather than full transcript, and provide TTL/delete/restricted-storage behavior.

### RP-06 — Identity, Capabilities, and Live Policy (P1 before remote, L)

Replace constant-pass guards, define local-single-user/local-multi-agent/remote modes, add action/resource-bound capabilities and delegated agent identity, centralise HTTP denial, and keep remote disabled until abuse tests pass.

### RP-07 — Generational Memory (P1/P2, L)

Separate ephemeral observations, TTL workspace working memory, and accepted durable knowledge. Add temporal validity, contradiction sets, abstention, tombstones, selective forgetting, applicability, and evidence diversity.

### RP-08 — Causal Collaboration and Worktree Overlays (P2, L)

Fix/split ledgers first; expose a real handoff writer; add causal events and TTL reservations; define clone identity and a read-only shared base with private worktree overlays or portable handoff bundles.

### RP-09 — Unified Operations and UX (P1, M)

Describe operations once and derive CLI/MCP/Harness/help/docs. Add consistent enablement, workspace current/list, proposal inbox/preview, doctor/status, and actionable error recovery.

### RP-10 — Receipt Operability and Context Capsules (P1, M–L)

Record plan/source/policy revisions in replayable capsules; add drift explanations, retention, prune/verify/repair/quota, and benchmark or sample durable receipt writes.

### RP-11 — Evaluation and Topology-aware Orchestration (P1/P2, M–L)

Compare SAC-off, deterministic SAC, and candidate SAC with independent verification; measure duplicate research and handoff loss; run causal ablations; choose single/sequential/parallel topology from dependency structure.

### RP-12 — Documentation and Graph Truth Sync (P0, S–M)

Refresh SAC graph/wiki coverage, generate or execute documentation examples, distinguish contract/mechanism/usable/production status, and pin evidence to commits.

## Recommended order

1. Truth correction: docs, graph/wiki, capability matrix, characterize current defects.
2. P0 core: RP-01, RP-04, RP-05, live local guard from RP-06.
3. Useful local product: RP-02, RP-03, RP-09, RP-10.
4. Memory and coordination: RP-07, RP-08, RP-11.
5. Only after measured benefit: real policy tournament, remote identity/A2A, TUI/IDE, cross-project federation.

## Explicit deferrals

- Do not expand learned-policy activation until it changes output and wins against a deterministic baseline.
- Do not create a shared transcript memory or global vector database by default.
- Do not build UI before the CLI create→read→review→reuse loop closes.
- Do not map generic decisions/risks/follow-ups to Skills.
- Do not claim cross-worktree sharing before a clone/worktree ownership model exists.

## Routing audit

- `graph_used`: yes; SAC edges were missing/stale.
- `wiki_used`: yes; Context, Flow, Memory, MCP, Security, Agents, and Skills pages.
- `ctx_used`: yes; scoped compact reads and searches.
- `raw_rg_used`: no.
- Narrow `sed` windows were used only when compact output hid critical surrounding code.
