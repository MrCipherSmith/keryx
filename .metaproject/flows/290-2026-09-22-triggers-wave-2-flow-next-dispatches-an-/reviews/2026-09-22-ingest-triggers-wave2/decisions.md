# Decisions

- F-001: acted-on — sandboxedHealthGate routes health run/gate through the sandbox wrap and env, and refuses to run the worktree's code with no sandbox; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-002: acted-on — the allow-list-built hardened sandbox profile in src/harness/process/sandbox/unattended.ts; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-003: acted-on — the floor's verb list gained sh -c/gh api/git-plumbing coverage and the plain omissions, and the docs now say the floor is defence in depth, not the boundary; the boundary moved to the sandbox (F-002, F-004); merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-004: acted-on — trust now live-probes the launcher and refuses (sandbox-unavailable, exit 0, reason recorded) on every gap; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-005: acted-on — reserveTriggerSpend under the project-wide spend lock, keryx trigger resolve for killed runs, usage-reporting-provider allowlist, and zero-rate rejection at load; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-006: acted-on — recoverStaleWorktree prunes dead registrations and conflict-refuses a live one outside the dispatcher's parent; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-007: acted-on — locks moved to .metaproject/data/.locks/ with a self-ignoring gitignore, writable inside the sandbox; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-008: acted-on — baseUrl loopback-only validation at config load; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-009: acted-on — the dispatcher's commit now runs with -c core.hooksPath=/dev/null --no-verify; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-010: acted-on — /run hidden wholesale behind an empty tmpfs, resolv.conf bound back only for network: true, the by-name Docker-socket mask removed as redundant; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-011: acted-on — NETWORK_ON_WARNING surfaced in trigger list, the run record and --help, plus the docs stating the model call never needs it; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
- F-012: acted-on — documented as an honest limit ('review the trigger branch before installing or building it') rather than a claimed guarantee; merged to main in 4752910c via PR #650. (valid_followup, post_flow_feedback).
