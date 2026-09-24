# W6: lifecycle hooks in keryx shell that can only tighten the policy engine

Status: formalized
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W6-shell-hooks.md (v0.1.2), schemas/hook-config.schema.json, implementation-plan.md Wave 1

## Problem

Keryx's own agent runtime has a deterministic tool-call gate (the policy engine,
`src/harness/policy/engine.ts`) but no pluggable, config-driven hook system: no
lifecycle events exist in `src/harness`, and no file lets a project or a person
register a command against a lifecycle point. The guards Keryx installs into host
harnesses (ctx guard, security check-input/output) therefore do not run when Keryx
itself is the agent, and W3 (learning observer) and W8 (impact evidence) have no
delivery mechanism.

## Expected Outcome

- A hook runtime (`src/harness/hooks/`) with the ten lifecycle events, config from
  `.metaproject/hooks.json` + `~/.keryx/hooks.json` validated against
  `hook-config.schema.json` and merged over built-ins (built-in < user < project;
  `keryx.*` collisions rejected; disable-only overrides honoured).
- A stdin-JSON / exit-code / stdout-JSON contract shaped like the Claude Code hooks
  convention; `updatedInput` never applied (recorded as an anomaly).
- Tighten-only composition with `decide()`: hooks can add `ask`/`deny`/context,
  never turn `deny` (incl. hard deny) or `ask` into `allow`; headless ask→deny after
  composition.
- Failure semantics per class (gate / gate-advisory / observe / context) × profile.
- Sandboxed, env-allowlisted, time-bounded, deterministically ordered execution.
- SubagentStart/SubagentStop at both the external (`deps.runExternal`) and the
  internal (`spawnChild()`) spawn paths, with explicit inherited hook ids.
- Built-ins `keryx.ctx-guard`, `keryx.security-check-input`,
  `keryx.security-check-output`, and stubs `keryx.learning-observer` (W3) and
  `keryx.impact-evidence` (W8) with clean extension points.
- `keryx hooks list|test|validate|enable|disable [--user]`.
- `hook_invocation` session records for every invocation.

## Out of Scope

- W8's evidence computation (gdgraph affected / test related content, strict mode).
- W3's observation storage, schema, retention and redaction.
- Installing hooks into host harnesses (W5).
- Input rewriting (`updatedInput`), in-process/prompt/HTTP user hooks, circuit breaker.
- Changing `engine.ts`/`types.ts` precedence or profiles.
