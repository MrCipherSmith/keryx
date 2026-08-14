# Keryx Improvements 1 — AI handoff report

```yaml
artifact: analysis-report
status: complete
date: 2026-08-14
worktree: /Users/tsaitler.aleksandr/goodea/keryx-improvements-1
scope:
  - src/sac
  - src/ctx
  - src/flow
  - src/session
  - src/harness
  - src/mcp
  - src/security
  - src/memory
  - src/wiki
  - src/gdskills
  - docs/requirements/shared-agent-context
recommendation: preserve_fwk_and_owner_boundaries_fix_p0_before_expansion
```

## Objective

Evaluate SAC as an integrated agent-context, memory-promotion, and collaboration system; identify confirmed gaps; align it with current agent research; decompose improvements into independently deliverable requirement packages.

## Core model

```text
Facts     = task-local claims + evidence + revision + temporal validity
Work      = read-only projection owned by Flow
Know-how  = accepted/reviewed knowledge owned by Wiki/Memory/Skills
Workspace = role-aware references, not copied source-of-truth content
SAC       = entry/promotion/governance layer, not task tracker or knowledge owner
```

## Preserved invariants

```yaml
invariants:
  - sac_never_writes_flow_state
  - context_operations_owns_assembly_trace
  - wiki_memory_skills_own_durable_knowledge
  - no_automatic_promotion
  - no_http_without_verified_identity_or_capability
  - client_payload_cannot_mint_actor_or_role
  - owner_write_is_intended_to_be_idempotent_and_receipt_bound
  - candidate_policy_cannot_expand_authorized_baseline
  - candidate_policy_cannot_control_security_gates
```

## Verified runtime path

```text
workspace manifest
  -> WorkspaceService current-role check
  -> raw evidence / first Flow JSON / Wiki-Memory-Skill Markdown reads
  -> local FWK candidates
  -> Context Operations ordered bounded assembly
  -> FWK manifest
  -> synchronous hash-linked access receipt append
  -> CLI | stdio MCP | shell agent tool
```

```text
same-project shell session
  -> verbatim Markdown archive copied into workspace
  -> one-time wrap-up capability
  -> immutable proposal
  -> mutable optional note sidecar
  -> same local owner/editor review allowed
  -> owner mapping
       wiki-update  => wiki
       memory-entry => memory
       all others   => skill
  -> owner target write + owner receipt
  -> accepted transition
  -> target is NOT automatically linked into workspace
```

## Findings registry

| ID | Severity | Finding | Primary evidence | Falsifier/acceptance test |
|---|---|---|---|---|
| F-001 | P0 | Candidate policy metadata does not constrain actual FWK selected items | `src/sac/fwk-service.ts` | candidate strict subset must change manifest |
| F-002 | P0 | Runtime baseline IDs originate from candidate IDs | `fwk-service.ts`, `policy-experiment.ts` | independently computed baseline rejects extra candidate ID |
| F-003 | P0 | All public overview items default to required | `FwkReadService.resolve`; public adapters omit required/optional | 33 items / budget 32 returns partial, not overflow |
| F-004 | P0 | `read` returns filtered compact metadata, not useful detail | `FwkReadService.read/success` | one read yields bounded redacted excerpt/body |
| F-005 | P0 | Unpinned evidence is always fresh; expiry is year 9999 | local source adapter | edit source and observe changed/untracked/stale |
| F-006 | P0 | IDs are positional | local source adapter | reorder resources without changing IDs |
| F-007 | P0 | Work projection is first-Flow-only and lossy | local source adapter | multi-flow/status fidelity corpus |
| F-008 | P0 | Receipt tokens/time are fixed zero | `FwkReadService.receipt` | measured value or explicit unknown |
| F-009 | P0 | Local strict guard is a constant pass object | CLI/FWK/proposal/collaboration composition | live deny policy blocks every surface |
| F-010 | P0 | Full mutable session transcript persists before scan/minimization | `session-wrap-up.ts` | secret/PII never persisted by default |
| F-011 | P0 | Wrap-up requires message count, not sealed/completed state | session/wrap-up code | live/post-seal mutation rejected |
| F-012 | P0 | Note sidecar is outside proposal/review/intent digest | workspace CLI/MCP, `proposal-evidence.ts` | mutate note before accept; deny |
| F-013 | P0 | Self-review is allowed for normal local subject | `proposal-lifecycle.ts` | proposer subject cannot accept under independent mode |
| F-014 | P0 | Idempotency key can collide across proposals | owner receipt path and wrapper | same key/two proposals never recovers foreign receipt |
| F-015 | P0 | Retry correlation requirements conflict with new CLI/MCP correlation IDs | review/recovery path | restart after every crash boundary is exactly-once |
| F-016 | P0 | Owner target write and receipt persistence are not atomic | owner writers | fault injection proves no duplicate/stranded acceptance |
| F-017 | P0 | Proposal path and loaded workspace binding need explicit validation | review/load path | traversal and cross-workspace corpus denied |
| F-018 | P0 | Raw files/regexes can impersonate Flow or accepted knowledge | local source adapter | fake JSON/status file rejected by owner facade |
| F-019 | P0 | Accepted target is absent from next workspace overview | owner writers/manifest | accept then overview includes target ref |
| F-020 | P0 | Generic proposal kinds fall through to Skills | `ownerFor` | exhaustive target matrix; unsupported pair denied |
| F-021 | P0 | Collaboration and proposal lifecycle share incompatible `activity.jsonl` | both services | handoff→proposal→review→collaboration mixed test |
| F-022 | P1 | Collaboration nested payload is not schema-closed | `collaboration-service.ts` | property tests reject nested extras/content |
| F-023 | P1 | No public collaboration record/handoff writer | CLI/MCP callers | released surface completes handoff |
| F-024 | P1 | No proposal list/show/inbox/preview | CLI/MCP | reviewer completes flow without out-of-band ID/content |
| F-025 | P1 | No session/workspace/Flow binding | shell/session schema | bound session needs no repeated workspace ID |
| F-026 | P1 | Sibling worktrees cannot share checkout-rooted SAC state | containment/storage | explicit clone/worktree model test |
| F-027 | P1 | Every read performs a durable locked append; no surfaced retention | FWK ledger | 10k-read SLO, prune/repair tests |
| F-028 | P1 | Identity is user-scoped, not delegated-agent-scoped | local auth server | same UID agents have distinct attenuated capabilities |
| F-029 | P1 | HTTP denial is correct but duplicated per tool | MCP tool registry | central transport capability gate |
| F-030 | P1 | Enablement/naming/discovery differs across CLI/MCP/shell/docs | registrations/docs | one capability matrix and generated parity |
| F-031 | P1 | Public guide uses obsolete propose arguments | guide vs CLI | docs examples execute in CI |
| F-032 | P1 | Wiki write path lacks canonical body owner API | wiki owner writer | SAC uses owner port only |
| F-033 | P1 | Graph/wiki omit SAC dependencies | gdgraph/gdwiki output | affected query returns real consumers |
| F-034 | P1 | Historical test totals are presented as current evidence | SAC docs | evidence pinned to commit/tag/date |
| F-035 | P2 | Policy activation omits real receipt/outcome re-ingestion | Phase 6b docs | activation verifies primary evidence artifacts |

## Research mapping

```yaml
research:
  context_engineering:
    sources:
      - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
      - https://openai.github.io/openai-agents-python/context/
    implication: deterministic_high_signal_plan_then_progressive_detail
  sessions:
    sources:
      - https://openai.github.io/openai-agents-python/sessions/
    implication: session_history_is_not_durable_knowledge
  multi_agent:
    sources:
      - https://www.anthropic.com/engineering/multi-agent-research-system
      - https://arxiv.org/abs/2503.01935
      - https://arxiv.org/abs/2503.13657
      - https://arxiv.org/abs/2512.08296
    implication: topology_and_verification_before_more_agents
  identity_and_transport:
    sources:
      - https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
      - https://www.nist.gov/news-events/news/2026/02/new-concept-paper-identity-and-authority-software-agents
      - https://github.com/a2aproject/A2A/blob/main/docs/specification.md
    implication: scoped_workflow_bound_capabilities_before_remote_sac
  provenance:
    sources:
      - https://www.w3.org/TR/prov-o/
    implication: entity_activity_agent_capsules_and_derivation
  security:
    sources:
      - https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/
    implication: untrusted_context_must_not_enter_memory_without_scan_and_provenance
  memory_evaluation:
    sources:
      - https://arxiv.org/abs/2410.10813
      - https://arxiv.org/abs/2507.05257
    implication: evaluate_retrieval_temporal_update_contradiction_forgetting_abstention_separately
```

## Requirement package dependency map

```text
RP-12 Truth Sync
   |
   +--> RP-01 Runtime Truth --------> RP-10 Receipts/Capsules ----+
   |              |                                             |
   |              +--> RP-02 Owner Projections                  |
   |                             |                               |
   +--> RP-04 Promotion Integrity+--> RP-03 Lifecycle Binding   +--> RP-11 Evals/Topology
   |              |                     |                       |
   +--> RP-05 Secure Evidence ----------+--> RP-07 Memory -------+
   |                                    |
   +--> RP-06 Identity/Capabilities ----+--> RP-08 Collaboration/Worktrees
                                        |
                                        +--> RP-09 Unified UX
```

## Package contracts

### RP-01 Runtime Truth

```yaml
priority: P0
size: M
requires:
  - independently_computed_baseline
  - executable_retrieval_plan
  - mandatory_core_and_ranked_optional_items
  - stable_ids
  - real_progressive_detail
  - measured_or_unknown_cost
  - changed_untracked_freshness
excludes: learned_ranking_model
```

### RP-02 Owner-resolved FWK

```yaml
priority: P0-P1
size: M-L
requires:
  - FlowContextProjection
  - EvidenceResolver
  - KnowledgeProjection
  - canonical_Wiki_decision_writer
  - owner_contract_tests
excludes:
  - duplicate_flow_tracker
  - sac_owned_knowledge_store
```

### RP-03 Lifecycle Binding

```yaml
priority: P1
size: M
requires:
  - optional_immutable_session_workspace_flow_binding
  - shell_workspace_flag
  - session_current
  - workspace_current_and_list_agent_tools
  - flow_worktree_workspace_preview
  - accepted_target_link_back
excludes: automatic_promotion
```

### RP-04 Promotion Integrity

```yaml
priority: P0
size: M-L
requires:
  - exhaustive_target_intent
  - owner_rendered_preview
  - digest_of_all_render_inputs
  - configurable_reviewer_independence
  - idempotency_scope_owner_workspace_proposal_revision
  - restart_safe_operation_id
  - crash_fault_injection
  - validated_ids_and_workspace_binding
  - terminal_target_and_link_receipts
excludes:
  - catch_all_skill_mapping
  - auto_accept
```

### RP-05 Secure Evidence

```yaml
priority: P0-security
size: M-L
requires:
  - sealed_session
  - schema_closed_wrap_up
  - pre_persistence_scan_and_minimization
  - no_full_transcript_by_default
  - ttl_delete_restricted_storage
  - sensitivity_and_trust_propagation
```

### RP-06 Identity and Live Policy

```yaml
priority: P1-before-remote
size: L
requires:
  - explicit_local_single_user_local_multi_agent_remote_modes
  - live_strict_policy_provider
  - action_resource_audience_bound_capabilities
  - delegated_agent_identity
  - continuous_role_revision_check
  - centralized_http_denial
excludes:
  - remote_http_before_abuse_suite
  - multi_tenant_admin_v1
```

### RP-07 Memory Lifecycle

```yaml
priority: P1-P2
size: L
requires:
  - ephemeral_working_durable_generations
  - temporal_validity_and_supersession
  - contradiction_sets
  - abstention
  - tombstones_and_selective_forgetting
  - applicability_and_evidence_diversity
  - LongMemEval_style_corpus
```

### RP-08 Collaboration and Worktrees

```yaml
priority: P2
size: L
requires:
  - separated_or_tagged_union_ledgers
  - public_handoff_writer
  - causal_event_spine
  - ttl_reservations_not_locks
  - project_clone_checkout_identity
  - portable_bundle_or_base_plus_overlay_model
excludes:
  - shared_raw_transcript_bus
  - filesystem_proximity_as_authority
```

### RP-09 Unified Operations

```yaml
priority: P1
size: M
requires:
  - single_operation_registry
  - derived_cli_mcp_harness_help_docs
  - consistent_enablement
  - proposal_inbox_preview
  - workspace_doctor_status
  - actionable_safe_errors
```

### RP-10 Receipts and Capsules

```yaml
priority: P1
size: M-L
requires:
  - workspace_plan_source_policy_revision_capsule
  - metadata_only_replay_and_drift
  - retention_rotation_prune_verify_repair_quota
  - benchmark_and_durability_policy
  - protected_checkpoint_only_if_security_evidence
```

### RP-11 Evaluation and Topology

```yaml
priority: P1-P2
size: M-L
requires:
  - no_sac_deterministic_candidate_baselines
  - independent_verifier
  - duplicate_work_handoff_loss_coordination_overhead_metrics
  - causal_ablations
  - single_sequential_parallel_topology_selection
  - shadow_only_policy_tournament
```

### RP-12 Truth Sync

```yaml
priority: P0
size: S-M
requires:
  - sac_graph_and_wiki_edges
  - executable_docs_examples
  - contract_mechanism_usable_production_status_taxonomy
  - commit_pinned_evidence
```

## Recommended execution waves

```yaml
wave_0:
  - RP-12
  - failing_characterization_tests
  - disable_or_label_metadata_only_candidate_activation
wave_1:
  - RP-01
  - RP-04
  - RP-05
  - local_live_guard_slice_of_RP-06
wave_2:
  - RP-02
  - RP-03
  - RP-09
  - RP-10
wave_3:
  - RP-07
  - RP-08
  - RP-11
wave_4_only_after_measured_benefit:
  - real_policy_tournament
  - remote_MCP_A2A_identity
  - TUI_IDE
  - cross_project_federation
```

## Stop conditions

```yaml
stop_if:
  - raw_secret_or_pii_persisted_in_evidence
  - candidate_attribution_without_output_change
  - accepted_knowledge_without_review_bound_digest_and_owner_receipt
  - remote_workspace_discovery_without_scoped_verified_principal
  - coordination_store_duplicates_flow_state
  - idempotency_retry_can_bind_foreign_receipt
```

## Routing audit

```yaml
graph_used: true
graph_result: sac_edges_missing_or_stale
wiki_used: true
ctx_used: true
raw_rg_used: false
exact_line_fallback: narrow_sed_only_after_compaction_hid_required_context
```
