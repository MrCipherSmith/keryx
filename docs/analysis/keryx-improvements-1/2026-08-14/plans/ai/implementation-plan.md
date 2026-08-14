# Keryx Improvements 1 — AI implementation plan

```yaml
status: proposed
source: ../../report/ai/report.md
delivery_unit: one_requirements_package_and_flow_per_item
```

## Plan

```yaml
gate_0_characterization:
  deliverables:
    - failing_candidate_output_test
    - budget_33_of_32_test
    - stable_id_reorder_test
    - changed_unpinned_source_test
    - note_mutation_test
    - self_review_test
    - cross_proposal_idempotency_test
    - crash_boundary_recovery_matrix
    - accepted_target_link_back_test
    - mixed_activity_ledger_test
    - sibling_worktree_contract_test
  exit: every_finding_reproduced_or_recorded_as_product_decision

flow_01_truth_sync:
  package: RP-12
  size: S
  exit:
    - executable_docs_green
    - sac_graph_edges_present
    - capability_matrix_published

flow_02_runtime_truth:
  package: RP-01
  size: M
  depends_on: [flow_01_truth_sync]
  exit:
    - candidate_changes_manifest
    - independent_baseline
    - correct_partial_semantics
    - stable_ids
    - useful_detail_read
    - honest_cost_and_freshness

flow_03_promotion_integrity:
  package: RP-04
  size: M-L
  exit:
    - exhaustive_target_matrix
    - review_preview_digest
    - independent_review_policy
    - exact_intent_receipt_binding
    - restart_safe_exactly_once_recovery
    - path_and_workspace_negative_suite
    - accepted_target_visible_in_next_overview

flow_04_secure_evidence:
  package: RP-05
  size: M-L
  exit:
    - sealed_session_required
    - structured_wrap_up_default
    - zero_raw_secret_pii_persistence
    - ttl_delete_recovery_verified

flow_05_live_local_guard:
  package: RP-06-local-slice
  size: M
  exit:
    - no_constant_pass_composition
    - local_single_user_semantics_explicit
    - centralized_transport_gate
    - revoke_and_cross_workspace_tests_green

milestone_1:
  contains: [flow_01_truth_sync, flow_02_runtime_truth, flow_03_promotion_integrity, flow_04_secure_evidence, flow_05_live_local_guard]
  gate: independently_verified_real_task_benefit_and_no_security_regression

flow_06_owner_projections:
  package: RP-02
  size: M-L
  depends_on: [milestone_1]

flow_07_lifecycle_binding:
  package: RP-03
  size: M
  depends_on: [flow_03_promotion_integrity, flow_06_owner_projections]

flow_08_unified_surface:
  package: RP-09
  size: M
  depends_on: [flow_07_lifecycle_binding]

flow_09_receipt_operability:
  package: RP-10
  size: M-L
  depends_on: [flow_02_runtime_truth]

flow_10_memory_lifecycle:
  package: RP-07
  size: L
  depends_on: [flow_04_secure_evidence, flow_06_owner_projections]

flow_11_collaboration_worktrees:
  package: RP-08
  size: L
  depends_on: [flow_05_live_local_guard, flow_07_lifecycle_binding]

flow_12_evaluation_policy_decision:
  package: RP-11
  size: M-L
  depends_on: [flow_09_receipt_operability, flow_10_memory_lifecycle, flow_11_collaboration_worktrees]
  exit:
    - causal_ablations_complete
    - topology_selection_evaluated
    - real_shadow_tournament_complete
    - learned_runtime_retained_or_removed_by_evidence

deferred_until_flow_12:
  - remote_MCP_A2A
  - TUI_IDE
  - cross_project_federation
  - online_learning
```

## Global stop conditions

```yaml
stop_if:
  - secret_or_pii_persisted
  - candidate_attribution_without_output_change
  - foreign_receipt_rebound_by_idempotency_collision
  - accepted_write_without_review_bound_digest
  - remote_discovery_without_scoped_principal
  - flow_state_duplicated
```
