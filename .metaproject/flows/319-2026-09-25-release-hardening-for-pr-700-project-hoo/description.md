# Release hardening for PR 700: project hook trust, security-gate override, observer containment, help and upgrade polish

Status: formalized
Source: integration review of PR #700 (feat/agent-platform-expansion -> main), ingested as review round 0 (findings R700-01..R700-18).

## Problem

The integration review of the agent-platform-expansion branch found one blocker, two majors and eleven minors that block the release:

- R700-01 (blocker): a cloned repository's `.metaproject/hooks.json` runs arbitrary commands, unsandboxed, the moment `keryx shell` starts (and in ACP/serve sessions). There is no trust decision. On main the same repository runs nothing.
- R700-02 (major): a project `hooks.json` can switch off the built-in security gates (`keryx.security-check-output` etc.) with a disable override.
- R700-03 (major): the default-on learning observer (and impact-evidence state) append through a committed symlink to a path outside the project.
- R700-04..14 (minor): contained-write ratchet gaps, `hooks disable` agent-callable, `keryx update` timestamp churn, help/usage gaps, internal labels in user-facing files, imported learned-pattern provenance, team-scope sharing, a stale message, an indexOf/lastIndexOf mismatch.

## Expected Outcome

- Project hook configs run only after the operator trusts the exact file content (`keryx hooks trust`); non-interactive surfaces never auto-trust.
- Project scope can only tighten built-in hooks; user scope can loosen a gate only with an explicit acknowledgement.
- Learning observer and impact-evidence writes are contained and refuse symlink escapes.
- Every minor finding is fixed or explicitly deferred with a reason.
- The review's 12-step manual test plan passes in a scratch repo, including the blocker probe (step 12).

## Out of Scope

- Making team-scope learned patterns shareable through git (R700-12): documented as local-only and deferred.
- Info findings R700-16/17 (OpenCode plugin PATH lookup, package size): no change.
- PR #700 itself is not touched; this flow merges into feat/agent-platform-expansion.
