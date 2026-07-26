# Flow Journal

- 2026-07-26T07:52:46.495Z - flow created
- 2026-07-26T07:56:27.565Z - frozen: 8 criteria; checksum recorded
- 2026-07-26T07:56:27.644Z - started
- 2026-07-26T08:05:50.672Z - ac-confirmed: AC1: mask-resolve.ts: projectPolicyTrusted() gate; resolveAllowedDomains + resolveMasksFromSandboxEnv ignore in-repo policy unless KERYX_SANDBOX_TRUST_PROJECT_POLICY set; tests F1 ignored-by-default + honoured-when-trusted (mask-resolve.test.ts)
- 2026-07-26T08:05:50.751Z - ac-confirmed: AC2: agent.ts:510 wraps tool output in redactSensitiveText before history.push; security/redact.ts new helper (detectSecrets+detectPii+applyRedaction); redact.test.ts asserts AWS/GH tokens masked
- 2026-07-26T08:05:50.832Z - ac-confirmed: AC3: profile.ts DEFAULT_SECRET_SUBPATHS broadened (kube/docker/npm/gcloud/git-credentials/...); shell-exec-tool.ts extraReadDenyRoots(KERYX_SANDBOX_READ_DENY); profile.test.ts + shell-exec-tool.test.ts cover both
- 2026-07-26T08:05:50.915Z - ac-confirmed: AC4: shell-permissions.ts PREFIX_BANNED_READERS + PREFIX_BANNED_MUTATORS; bannedPrefixGrant returns per-category reason; shell-permissions-hardening.test.ts F4/F5 refuse bare word*, allow narrowed
- 2026-07-26T08:05:51.000Z - ac-confirmed: AC5: agent.ts executeCall delegate branch now default-deny (false) when requestApproval undefined, mirroring shell; agent.test.ts F6 asserts spawn not invoked + not-approved result
- 2026-07-26T08:05:51.081Z - ac-confirmed: AC6: project-sandbox-policy.ts: removed empty dead loop; allowlist construction already excludes unknown keys; existing sanitizer tests green
- 2026-07-26T08:05:51.163Z - ac-confirmed: AC7: tsc --noEmit exit 0; full suite 2232 pass/0 fail/14 skip (255 files); keryx health run = PASS score 93
- 2026-07-26T08:05:55.490Z - task-done: T1: Collect remaining context
- 2026-07-26T08:05:55.574Z - task-done: T2: Implement per plan
- 2026-07-26T08:05:55.653Z - task-done: T3: Add/adjust tests and make them pass
