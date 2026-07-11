@harness @acceptance
Feature: Project-oriented Keryx agent harness
  Keryx owns provider-neutral execution primitives while the .metaproject
  workspace remains the durable project brain. Managed-flow state and
  completion remain owned by Task Manager.

  Background:
    Given the project has a .metaproject/metaproject.json manifest
    And the harness capability is disabled by default
    And contract identifiers resolve through the normative contract inventory

  @task-R0-01
  @SC_R01_OFFLINE_START @R1 @R14 @release-0 @positive
  Scenario: Start the offline harness without another coding-agent runtime
    Given a deterministic fake provider fixture is available
    When an explicitly enabled Release 0 run starts
    Then Keryx uses the harness runtime and fake provider only
    And no external coding-agent runtime is required
    And the normalized run and event contracts are persisted

  @task-R0-01
  @SC_R01_CAPABILITY_OFF_NO_LOAD @R1 @R14 @release-0 @negative
  Scenario: Preserve the deterministic floor when the harness is disabled
    Given no provider is configured
    When a deterministic Keryx command runs with the harness disabled
    Then no provider is loaded
    And no harness network socket is opened
    And command behavior is byte-identical to the baseline

  @task-R0-01
  @SC_R02_TRUSTED_STARTUP @R2 @R7 @release-0 @positive
  Scenario: Build trusted project context before the first model request
    Given the provider, model, credential reference, policy profile, and role are configured
    When a Release 0 run starts
    Then Keryx resolves the project root and manifest
    And loads trusted rules, skills, and orientation
    And writes a bounded context manifest with scope and fingerprints
    And persists the startup event before the first model request

  @task-R0-01
  @SC_R02_MISSING_PRECONDITION @R2 @R12 @release-0 @negative
  Scenario: Reject startup when a required provider precondition is missing
    Given the provider or credential reference is missing
    When an enabled run starts
    Then Keryx returns a typed environment_blocked result
    And no partial provider request is made

  @task-P-01
  @SC_R03_PROVIDER_NORMALIZATION @R3 @R14 @release-0 @positive
  Scenario: Normalize a fake-provider text and tool-call stream
    Given a fake provider emits text, a complete tool call, usage, and finish events
    When Keryx consumes the transcript
    Then provider-neutral events are persisted in sequence
    And provider-specific fields remain under a namespaced extension
    And no provider SDK type crosses the domain port

  @task-P-01
  @SC_R03_PROVIDER_TRANSIENT_FAILURE @R3 @R12 @release-0 @negative
  Scenario: Bound a retryable provider failure
    Given a fake provider returns an overload error and retry budget remains
    When the model attempt fails
    Then Keryx records a typed retry event with cancellable backoff
    And does not exceed the reserved run budget

  @task-P-01
  @SC_R03_PROVIDER_PERMANENT_FAILURE @R3 @R12 @release-0 @negative
  Scenario: Stop on a permanent provider failure
    Given a provider returns an authentication or invalid-request error
    When Keryx classifies the response
    Then the attempt becomes terminally failed
    And no invented retry is issued

  @task-P-01
  @SC_R03_MALFORMED_OR_PARTIAL_STREAM @R3 @R12 @release-0 @negative
  Scenario: Preserve a malformed or partial provider stream safely
    Given a transcript ends during a tool-input delta or contains an unknown malformed event
    When Keryx normalizes the stream
    Then it records the partial trail and typed provider error
    And the incomplete tool call is not executed or reused as a new attempt

  @task-P-02
  @SC_R04_READ_ONLY_TOOL @R4 @R11 @release-0 @positive
  Scenario: Execute one registered read-only tool
    Given a valid read-only tool definition and input fixture
    When the fake model requests the tool
    Then input validates before execution
    And output is bounded, redacted, and linked to evidence

  @task-P-02
  @SC_R04_MALFORMED_TOOL_INPUT @R4 @R12 @release-0 @negative
  Scenario: Reject malformed tool input
    Given a model emits invalid JSON or schema-invalid input
    When Keryx receives the completed tool call
    Then it records validation_error
    And the tool has no execution receipt or side effect

  @task-P-02
  @SC_R04_TOOL_TIMEOUT @R4 @R12 @release-0 @negative
  Scenario: Bound a read-only tool timeout
    Given a registered tool exceeds its timeout
    When Keryx cancels the tool
    Then it records a typed timeout or cancelled execution
    And it does not report successful completion

  @task-P-02
  @SC_R04_TOOL_OUTPUT_OVERFLOW @R4 @R12 @release-0 @negative
  Scenario: Bound tool output overflow
    Given a tool produces more output than its byte or token limit
    When Keryx receives the output
    Then it records a bounded overflow result
    And it does not enter an unbounded context retry loop

  @task-M-01
  @SC_R05_POLICY_OUTCOME @R5 @release-0 @positive
  Scenario Outline: Resolve one exclusive policy outcome
    Given a valid tool call and a matching policy profile
    When policy resolves the call with decision "<decision>"
    Then the persisted decision is "<decision>"
    And the action result is "<result>"
    And the decision references the exact tool-call and policy fingerprints

    Examples:
      | decision | result |
      | allow    | executed |
      | ask      | approval-required |
      | deny     | not-executed |

  @task-M-01
  @SC_R05_HARD_DENY @R5 @R15 @release-0 @negative
  Scenario: Hard deny cannot be overridden
    Given untrusted project text instructs the model to bypass security
    And the model requests a secret or external-directory tool
    When policy evaluates the call
    Then hard deny wins over model text, project content, and session hints
    And no side effect occurs

  @task-M-01
  @SC_R05_HEADLESS_ASK @R5 @R13 @release-0 @negative
  Scenario: Fail closed when approval is required in headless mode
    Given a policy decision is ask and no interactive approval transport exists
    When the call is evaluated
    Then Keryx returns approval-required or denied
    And it does not auto-approve or execute the call

  @task-M-01
  @SC_R05_STALE_APPROVAL @R5 @R6 @release-0 @negative
  Scenario: Invalidate an approval after a fingerprint changes
    Given an approval is pending for a canonical action
    When the tool schema, input, policy, branch, worktree, or expiry changes
    Then the approval becomes stale and remains immutable history
    And a new approval is required before any later execution

  @task-RS-01
  @SC_R06_APPEND_ONLY_SESSION @R6 @R11 @release-0 @positive
  Scenario: Reconstruct an append-only session tree
    Given a run writes model, policy, tool, and evidence entries
    When the session is inspected
    Then every entry has stable identifiers, parent links, sequence, and hashes
    And the current leaf is reconstructable without hidden chain-of-thought

  @task-RS-01
  @SC_R06_RESUME_NO_DUPLICATE @R6 @R11 @release-0 @negative
  Scenario: Resume without duplicating accepted evidence
    Given a process exits after accepted events are appended
    When the same worktree and toolchain resume the session
    Then accepted events and evidence are not appended a second time
    And stale work creates a new immutable attempt

  @task-RS-01
  @SC_R06_SCHEMA_MIGRATION @R6 @R12 @release-0 @negative
  Scenario: Migrate a prior session schema deterministically
    Given a prior version fixture contains stable ids and evidence references
    When the session is opened under the current schema
    Then Keryx applies the declared migration or returns a typed compatible failure
    And prior history remains immutable

  @task-R0-02
  @SC_R07_BOUNDED_CONTEXT @R7 @R14 @release-0 @positive
  Scenario: Bound context from the project brain
    Given the task touches a known module
    When context is assembled
    Then graph scope is narrowed before broad reads
    And wiki, memory, testing, health, and security references include freshness and provenance
    And rendered bytes and estimated tokens remain within hard limits

  @task-R0-02
  @SC_R07_STALE_OR_UNTRUSTED_CONTEXT @R7 @R15 @release-0 @negative
  Scenario: Keep stale or untrusted context from becoming policy
    Given a context source is stale, untrusted, or scan-failed
    When the manifest is built
    Then it records the source status and reason
    And the source cannot grant policy authority

  @task-CA-01
  @SC_R08_ROLE_CANNOT_ESCALATE @R8 @R15 @release-0 @negative
  Scenario: Prevent a role from granting itself authority
    Given the Release 0 role has read-only tools
    When it requests mutation, shell, network, credential, child-agent, or extension access
    Then policy denies the capability without an effect

  @task-FI-01
  @SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED @R9 @R15 @release-0 @negative
  Scenario: Prevent direct flow file mutation
    Given a harness run is associated with a managed-flow task
    When the run requests a direct flow.json edit
    Then the request is denied
    And Task Manager remains the only flow-state writer

  @task-R0-02
  @SC_R10_EVIDENCE_FREE_COMPLETION_REJECTED @R10 @R11 @release-0 @negative
  Scenario: Reject evidence-free completion
    Given the model emits a final completion message
    And a required gate or evidence reference is missing
    When the completion evaluator runs
    Then the run is rejected as incomplete
    And no successful completion output is emitted

  @task-R0-02
  @SC_R10_VERIFIED_COMPLETION @R10 @R11 @release-0 @positive
  Scenario: Produce evidence-linked verified completion
    Given required Release 0 gates pass and all required evidence references exist
    When the standalone completion evaluator finalizes the run
    Then it persists a completion-gate result and evidence-linked output

  @task-R0-02
  @SC_R10_UNDISPOSED_BLOCKER_REJECTED @R10 @R9 @release-0 @negative
  Scenario: Reject completion with an undisposed blocker
    Given a required review contains an undisposed blocker
    When completion gates run
    Then the gate fails even if the model emitted a final message

  @task-R0-02
  @SC_R11_REDACTION_BEFORE_PERSISTENCE @R11 @R15 @release-0 @negative
  Scenario: Redact protected content before persistence
    Given a tool or provider result contains a seeded secret or PII
    When the result is prepared for durable artifacts
    Then only a redacted preview, hash, category, and provenance are persisted
    And scan failure is a blocking state

  @task-R0-03
  @SC_R12_BUDGET_EXHAUSTION @R12 @R16 @release-0 @negative
  Scenario: Stop at a hard budget boundary
    Given the reserved token, time, or tool-call budget is exhausted
    When the next action is requested
    Then Keryx persists budget_exceeded
    And no further provider or tool action starts

  @task-R0-03
  @SC_R12_LOOP_DETECTION @R12 @release-0 @negative
  Scenario: Stop a repeated ineffective loop
    Given the same normalized action repeats beyond its loop threshold
    When the loop detector evaluates the action
    Then Keryx persists loop_detected
    And exposes a bounded next operator action

  @task-R0-03
  @SC_R12_REPLAY_MISMATCH @R12 @R17 @release-0 @negative
  Scenario: Report an offline replay mismatch
    Given recorded provider or tool fixtures have a changed input or hash
    When offline replay runs
    Then Keryx emits a typed replay mismatch
    And does not fall back to a live provider, network, or mutating tool

  @task-R0-03
  @SC_R13_CLI_RPC_PARITY @R13 @R14 @release-0 @positive
  Scenario: Preserve semantics across CLI and JSONL RPC
    Given the in-process fake-provider run succeeds
    When the same request is sent through CLI and JSONL/RPC
    Then normalized events, policy results, and gate output are semantically equivalent

  @task-R0-03
  @SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY @R13 @R5 @release-0 @negative
  Scenario: Prevent a transport from changing policy
    Given the in-process policy decision is deny
    When the same call is submitted through JSONL/RPC
    Then the transport preserves the deny decision
    And it cannot upgrade the call to allow or ask

  @task-R0-01
  @SC_R14_NETWORK_OR_PROVIDER_ACCESS_DENIED @R14 @R15 @release-0 @negative
  Scenario: Keep Release 0 offline
    Given a Release 0 run requests a live provider, network, or mutating tool
    When capability policy evaluates the request
    Then it is denied with no socket, request, or side effect

  @task-M-01
  @SC_R15_READ_WITHIN_ROOT @R15 @R4 @release-0 @positive
  Scenario: Allow a read within the approved worktree
    Given a read-only tool requests a canonical path inside the approved worktree
    When the read-only-review profile evaluates the request
    Then the request is allowed
    And the result is bounded, redacted as required, and evidence-linked

  @task-M-01
  @SC_R15_CREDENTIAL_REQUEST_DENIED @R15 @release-0 @negative
  Scenario: Deny direct credential access
    Given a tool requests a raw secret or unrestricted environment snapshot
    When policy evaluates the request
    Then it is denied and no credential value is persisted

  @task-R0-02
  @SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS @R16 @release-0 @positive
  Scenario: Preserve metric reliability
    Given a provider reports one exact value and omits another
    When metrics are persisted
    Then the reported value is exact
    And the omitted value is estimated or unknown with its source recorded

  @task-R0-02
  @SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT @R16 @release-0 @negative
  Scenario: Reject fabricated exact metrics
    Given a provider omits a token or latency value
    When the metrics record is produced
    Then the value is not labelled exact
    And the record includes an estimated, unknown, or unavailable reliability state

  @task-R0-03
  @SC_R17_OFFLINE_REPLAY_MATCHES @R17 @R14 @release-0 @positive
  Scenario: Replay recorded state without effects
    Given a recorded fake-provider run and hash-bound tool fixtures
    When validate-log or simulate-recorded-results replay runs
    Then policy and orchestration transitions match
    And no provider, network, credential, or mutating tool is invoked

  @task-H-02
  @SC_R18_UNREGISTERED_EXTENSION_DENIED @R18 @R15 @release-0 @negative
  Scenario: Deny an unregistered extension
    Given an extension attempts to register during discovery
    When the extension lacks a pinned manifest and capability grant
    Then it is rejected without discovery-time mutation or authority

  @task-H-02
  @SC_R18_REGISTERED_EXTENSION_PROVENANCE @R18 @R5 @release-2 @positive
  Scenario: Preserve provenance for a registered extension
    Given a later-release extension has a pinned manifest and explicit capability grant
    When it is registered
    Then its provenance and granted capabilities are persisted
    And registration does not widen authority beyond the grant

  @task-M-01
  @SC_R15_PATH_TRAVERSAL_DENIED @R15 @release-1 @negative
  Scenario: Deny path traversal and symlink escape
    Given a future guarded mutation targets a path outside the approved worktree
    When canonical path resolution runs
    Then traversal and symlink escape are denied before access

  @task-M-01
  @SC_R15_SHELL_INJECTION_DENIED @R15 @release-1 @negative
  Scenario: Deny shell injection
    Given a future command tool receives an untrusted argument
    When argv and command policy validation runs
    Then shell interpolation cannot inject a second command

  @task-M-01
  @SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED @R15 @release-1 @negative
  Scenario: Deny redirect and private-address egress
    Given a future network broker sees a redirect to a private, link-local, metadata, proxy, or Unix-socket destination
    When the broker resolves and revalidates the destination
    Then the request is denied at the connection boundary

  @task-M-01
  @SC_R15_FAIL_CLOSED_ISOLATION @R15 @release-1 @negative
  Scenario: Fail closed when required isolation is unavailable
    Given unattended-untrusted mutation is requested without OS/container/remote isolation
    When security capability detection runs
    Then the mutation is blocked and no permission prompt can bypass the boundary

  @task-FI-01
  @SC_R09_SINGLE_COORDINATOR @R9 @R10 @release-1 @positive
  Scenario: Advance managed flow only through Task Manager
    Given Task Manager has evolved task dependencies, attempts, dispositions, budgets, and evidence references
    When the harness emits a typed gate artifact
    Then flow-orchestrator/Task Manager alone advances task and completion state

  @task-CA-01
  @SC_R08_CHILD_DISPATCH_CANONICAL_RESULT @R8 @R9 @release-2 @positive
  Scenario: Adapt canonical child dispatch and result
    Given a managed coordinator has reserved child budget
    When it dispatches a child through the adapter
    Then the payload validates as canonical subagent-dispatch and subagent-result
    And STATUS framing is normalized before persistence

  @task-CA-01
  @SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY @R8 @R18 @R15 @release-2 @negative
  Scenario: Require policy for extension privilege escalation
    Given a registered extension requests broader tools or provider access
    When the capability grant is evaluated
    Then escalation requires explicit policy, provenance, and approval
    And no silent authority gain occurs

  @task-R0-01
  @SC_R02_CONTEXT_BOUND @R2 @R7 @release-0 @positive
  Scenario: Persist context scope and fingerprints
    Given project context selection has completed
    When the startup record is appended
    Then scope, project, policy, and schema fingerprints are present

  @task-R0-01
  @SC_R02_OPTIONAL_ARTIFACT_DEGRADES @R2 @R7 @release-0 @negative
  Scenario: Record an unavailable optional context artifact
    Given an optional wiki or health artifact is unavailable
    When context is built
    Then the manifest records an explicit skip reason
    And startup does not silently treat absence as trusted policy

  @task-P-01
  @SC_R03_REAL_ADAPTER_CAPABILITY @R3 @release-1 @positive
  Scenario: Gate a future provider adapter by capability
    Given a future provider advertises a pinned capability descriptor
    When the adapter is selected
    Then unsupported features are reported as explicit omissions
    And provider storage remains disabled unless separately permitted

  @task-M-01
  @SC_R04_GUARDED_MUTATION @R4 @R5 @release-1 @positive
  Scenario: Record a guarded mutation after approval
    Given a future monitored-trusted-local profile approves a canonical edit
    When the tool executes inside the approved worktree
    Then a receipt, redacted result, diff, and evidence record are persisted

  @task-M-01
  @SC_R04_SHELL_CONTAINMENT @R4 @R15 @release-1 @positive
  Scenario: Run a future command through containment
    Given a future shell tool has an approved argv and environment allowlist
    When the process-group command runs
    Then timeout, output, cwd, and cancellation controls are enforced

  @task-RS-01
  @SC_R05_APPROVAL_RESUME @R5 @R6 @release-1 @positive
  Scenario: Resume an unchanged pending approval
    Given a pending approval is persisted and all fingerprints remain equal
    When the same worktree resumes
    Then the approval can be consumed once
    And the model request is not repeated

  @task-B-01
  @SC_R06_BRANCH_TREE @R6 @release-1 @positive
  Scenario: Preserve branch ancestry
    Given a session forks at an immutable entry
    When the new branch becomes current
    Then branchId, forkEntryId, current leaf, and immutable ancestors are persisted
    And merge remains excluded from v1

  @task-B-02
  @SC_R06_TYPED_COMPACTION @R6 @R7 @release-1 @positive
  Scenario: Compact as a typed derived entry
    Given a session exceeds its context budget
    When compaction creates a derived entry
    Then source range, summary hash, active obligations, and evidence cursor are retained

  @task-B-02
  @SC_R07_COMPACTION_REBUILDS_REFERENCES @R7 @R11 @release-1 @positive
  Scenario: Rebuild bounded context after compaction
    Given a compacted session retains its project scope and evidence ids
    When context is rebuilt
    Then the same scope and evidence references are addressable

  @task-CA-01
  @SC_R08_NEEDS_CONTEXT_ADAPTER @R8 @R12 @release-2 @positive
  Scenario: Add only bounded context for NEEDS_CONTEXT
    Given a child result names one missing bounded artifact
    When the parent retries with the same dispatch id
    Then only that artifact is added
    And the prior attempt remains immutable

  @task-CA-01
  @SC_R08_BOUND_PARALLEL_WAVE @R8 @R12 @release-2 @positive
  Scenario: Bound a child-agent wave
    Given a future coordinator has reserved an aggregate budget and concurrency of two
    When three independent child tasks are ready
    Then no more than two run concurrently
    And each attempt has its own evidence history

  @task-FI-01
  @SC_R09_TASK_MANAGER_MIGRATION @R9 @R10 @release-1 @positive
  Scenario: Migrate Task Manager task state before flow integration
    Given an existing FlowTask has only legacy status fields
    When the additive Task Manager migration runs
    Then dependencies, attempts, dispositions, evidence, budgets, and run linkage are available
    And legacy status remains readable

  @task-R0-02
  @SC_R11_EVIDENCE_LINKAGE @R11 @R10 @release-0 @positive
  Scenario: Link every meaningful action to evidence
    Given a Release 0 run persists a model or read-only tool action
    When the event is finalized
    Then it references a redacted evidence record and artifact hash

  @task-RS-01
  @SC_R11_EVIDENCE_SURVIVES_RESUME @R11 @R6 @release-0 @positive
  Scenario: Preserve evidence across resume
    Given a session resumes with the same fingerprints
    When its current leaf is reconstructed
    Then prior evidence references remain reachable and immutable

  @task-R0-03
  @SC_R12_TRANSIENT_RETRY @R12 @R3 @release-0 @positive
  Scenario: Retry one transient provider error within budget
    Given a retryable provider error occurs and reservation remains
    When bounded backoff completes
    Then a new attempt is recorded without exceeding the reservation

  @task-RS-02
  @SC_R12_CRASH_CUT_PRE_EFFECT @R12 @R6 @release-1 @negative
  Scenario: Recover a crash before a side effect
    Given a prepared execution crashes before the effect starts
    When the session resumes
    Then the execution is not reported as succeeded
    And no duplicate effect is attempted automatically

  @task-RS-02
  @SC_R12_CRASH_CUT_POST_EFFECT @R12 @R6 @release-1 @negative
  Scenario: Reconcile a crash after a side effect
    Given a tool side effect occurs before its receipt is appended
    When the process resumes
    Then the state is outcome-unknown until reconciled
    And an unsafe duplicate retry is blocked

  @task-R0-03
  @SC_R13_TUI_DEFERRED @R13 @release-2 @positive
  Scenario: Defer the TUI without changing the runtime contract
    Given the CLI and JSONL/RPC transports are stable
    When TUI work is considered
    Then it remains a later adapter over the same runtime ports

  @task-R0-01
  @SC_R14_DETERMINISTIC_FLOOR @R14 @R1 @release-0 @positive
  Scenario: Keep deterministic commands independent of harness capability
    Given no harness capability is enabled
    When deterministic commands run
    Then no optional provider dependency is imported

  @task-R0-03
  @SC_R14_OFFLINE_REPLAY @R14 @R17 @release-0 @positive
  Scenario: Replay entirely offline
    Given a recorded fake-provider transcript and tool fixtures exist
    When validate-log replay runs
    Then no network or provider request is made

  @task-M-01
  @SC_R15_SYMLINK_ESCAPE_DENIED @R15 @R4 @release-1 @negative
  Scenario: Reject a symlink that escapes the worktree
    Given a future mutation path resolves through a symlink outside the approved root
    When canonicalization runs
    Then the tool is denied before opening the target

  @task-R0-02
  @SC_R16_BUDGET_RESERVATION @R16 @R12 @release-0 @positive
  Scenario: Reserve and reconcile a run budget
    Given a Release 0 run has a hard token and tool-call reservation
    When a provider attempt is persisted
    Then planned, reserved, consumed, remaining, and reliability values reconcile

  @task-RS-02
  @SC_R17_ISOLATED_REEXECUTE_DEFERRED @R17 @R15 @release-1 @positive
  Scenario: Keep isolated replay re-execution deferred
    Given a replay fixture requests isolated re-execute
    When Release 0 policy evaluates the mode
    Then it remains unavailable until containment and policy gates pass

  @task-R0-03
  @SC_R17_NO_LIVE_EFFECT_ON_REPLAY @R17 @R14 @release-0 @negative
  Scenario: Reject a live effect during replay
    Given replay reaches a mutating or network tool record
    When the recorded-result simulator handles it
    Then it rejects the effect and reports a mismatch or blocked transition

  @task-R0-03
  @SC_R17_REPLAY_MISMATCH_REPORTED @R17 @R12 @release-0 @negative
  Scenario: Persist replay mismatch details
    Given expected and actual hashes differ
    When replay comparison completes
    Then the mismatch report identifies the kind and both hashes

  @task-H-02
  @SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY @R18 @R5 @release-2 @negative
  Scenario: Require policy for extension escalation
    Given a registered extension requests a capability outside its grant
    When the capability evaluator runs
    Then the escalation is denied or asks for explicit approval
