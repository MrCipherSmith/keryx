Feature: Managed code review through Flow Reviewer
  Flow Reviewer provides a durable Task Manager lifecycle above the stateless
  Review Orchestrator without duplicating reviewer selection or consolidation.

  Background:
    Given Task Manager is enabled
    And the Review Orchestrator supports plan-only and consolidate-only modes
    And Flow Reviewer validates all messages against the configured schemas

  Scenario: Create a dedicated managed review flow
    Given no matching active review flow exists for the target
    When the user requests a managed review of the target
    Then Flow Reviewer creates a dedicated review flow through the Keryx flow API
    And the flow links to a related implementation flow when one is known
    And Flow Reviewer never edits flow.json directly

  Scenario: Keep embedded implementation review lightweight
    Given Flow Orchestrator reaches its review phase
    When it invokes Review Orchestrator with a reviewer subset and token budget
    Then Review Orchestrator completes the review without creating a nested review flow
    And Flow Orchestrator records the review result in its existing flow

  Scenario: Create one task per selected reviewer
    Given Review Orchestrator returns a valid execution plan
    When Flow Reviewer materializes the review plan
    Then every selected reviewer has exactly one review flow task
    And every skipped reviewer has a coverage reason
    And no skipped reviewer has a flow task

  Scenario: Use compact shared context
    Given the target contains changes across multiple domains
    When Flow Reviewer builds reviewer context
    Then gdgraph narrows affected files and dependencies
    And gdctx creates compact diff and read artifacts
    And wiki, memory, testing, and health artifacts are included only when relevant
    And reviewer tasks reference a shared context manifest by path and hash
    And the full raw diff is not duplicated into every reviewer task

  Scenario: Assign cheaper models to bounded review work
    Given the model strategy is adaptive
    And the runtime supports per-agent model assignment
    When Flow Reviewer plans style and clean-code reviewer tasks
    Then it prefers an economy model class for those tasks
    And it records the actual model assignment in task history

  Scenario: Preserve stronger review for high-risk work
    Given the target changes authentication and authorization code
    And the model strategy is adaptive
    When Flow Reviewer creates logic and security reviewer tasks
    Then it assigns the strong model class unless the caller explicitly overrides it
    And it reserves budget for strict synthesis

  Scenario: Fall back when model assignment is unavailable
    Given the runtime cannot assign models per reviewer
    When Flow Reviewer dispatches reviewer tasks
    Then it uses the current session model
    And it records assignmentStatus as fallback-current-session
    And it does not claim that an economy model ran

  Scenario: Accept a schema-valid reviewer result
    Given a reviewer task is in progress
    When the reviewer returns a schema-valid DONE result
    Then Flow Reviewer stores the immutable attempt artifacts
    And it records the completion event
    And it marks the flow task done through Task Manager

  Scenario: Reject an invalid reviewer result
    Given a reviewer task is in progress
    When the reviewer result does not validate against subagent-result
    Then Flow Reviewer records a validation failure event
    And it does not mark the flow task done
    And it requests one corrected result within the retry policy

  Scenario: Enrich only missing context
    Given a reviewer returns NEEDS_CONTEXT with a specific missing evidence request
    When Flow Reviewer prepares the next attempt
    Then it adds only the requested bounded context references
    And it preserves the task id and earlier attempt
    And it does not resend unrelated repository context

  Scenario: Resume and reuse an unchanged reviewer task
    Given a reviewer task has an accepted result
    And target, scope, context, skill version, model policy, and schema fingerprints are unchanged
    When Flow Reviewer resumes the review flow
    Then it reuses the accepted result
    And it consumes no new reviewer model tokens
    And it records which attempt was reused

  Scenario: Invalidate a stale reviewer result
    Given a reviewer task has an accepted result
    And the target scope fingerprint has changed
    When Flow Reviewer resumes the review flow
    Then it does not reuse the accepted result as current evidence
    And it creates a new task attempt
    And it preserves the previous attempt for audit

  Scenario: Consolidate accepted reviewer results
    Given all required reviewer tasks have accepted terminal results
    When Flow Reviewer requests consolidation
    Then Review Orchestrator deduplicates findings in consolidate-only mode
    And Flow Reviewer stores coverage, report, findings, decisions, learning, and output artifacts

  Scenario: Block completion for unresolved major findings
    Given consolidation contains a blocker or major finding
    And no decision is recorded for that finding
    When Flow Reviewer attempts to complete the flow
    Then the completion gate fails
    And the review flow remains open

  Scenario: Complete an auditable review flow
    Given every selected reviewer task has an accepted terminal result or an allowed explicit disposition
    And every skipped reviewer has a reason
    And all blocker and major findings have decisions
    And all required artifacts and acceptance evidence validate
    When Flow Reviewer completes the review
    Then Task Manager transitions the flow through the supported completion path
    And the final output reports reviewer coverage, models, budgets, tokens, retries, findings, and artifacts

  Scenario: Complete a review flow without creating another pull request
    Given the managed flow kind is review
    And the review target is an existing pull request
    And all review completion gates pass
    When Flow Reviewer completes the review flow
    Then Task Manager does not require a new implementation pull request
    And existing implementation flow pull-request gates remain unchanged

  Scenario: Route managed review requests correctly
    Given Flow Reviewer is installed in the Keryx skill catalog
    When the user asks for flow review or managed review
    Then the skill router selects Flow Reviewer
    And it does not select Review Frontend solely because the request contains the word flow
