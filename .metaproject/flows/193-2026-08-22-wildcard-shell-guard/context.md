# Context

Collected deterministically by `keryx flow init` at 2026-08-22T11:00:33.019Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Source Issue

https://github.com/MrCipherSmith/keryx/issues/390

### shell-permission validation lets a bare "keryx *" wildcard through — defeats per-call approval for the entire CLI surface

## Summary

A stored shell permission of exactly `"keryx *"` in `~/.local/share/keryx/permissions.json` passes `validateShellPattern` and loads successfully, silently auto-approving **every** future `shell_exec` invocation of the `keryx` binary — including highly consequential subcommands (`keryx wiki enrich` with content-mutation + auto-`accepted`, `keryx flow complete`, `keryx security redact`, `keryx workspace archive`, etc.) — with zero further prompting, forever, across every project and session.

## How this was found

While live-testing `keryx shell` (0.2.55, real DeepSeek session) on a documentation task, every `shell_exec(keryx ...)` call was labeled `✓ auto-approved shell`, even ones that mutate the wiki and flip a page's own `Status` to `accepted`. Tracing it: `evaluateShellApproval` → `isShellCommandAllowed(command, sessionAllow)` matched against a stored pattern loaded from `permissions.json`. The file (real, on this machine) contains, among many legitimate exact-command entries, one bare wildcard:

```json
"keryx *"
```

## Why this is surprising

- The "remember" UI (`[y/N/A=always]`, `rememberExactShellGrant` in `src/commands/shell-approval.ts`) only ever stores the **exact**, full trimmed command string (per `suggestShellPatterns`'s `exact` field) — it has no code path that generalizes to a bare `<word> *` wildcard. So this entry was not produced by the normal in-session "always approve" flow; it must have been hand-added to `permissions.json` (a file the code's own docstring treats as legitimately user-editable) or is a holdover from an older code path.
- Separately, `validateShellPattern` (`src/lib/shell-permissions.ts`) already has a specific guard against exactly this shape for other command words — the code has a check along the lines of `` `${word} *` would auto-approve modifying/deleting any path in the working directory; such a broad mutator can be approved once, never remembered `` for common destructive verbs. `keryx` itself never trips that guard, despite having a subcommand surface that spans trivial reads (`wiki --help`) all the way to non-idempotent, knowledge-base-mutating, or destructive actions (`wiki enrich --force`, `flow complete`, `security redact`, `workspace archive`, `memory ingest`) — arguably a wider and more consequential surface than most of the verbs the existing guard already protects against.

## Impact

Once this single pattern exists (however it got there), per-call approval is effectively disabled for the tool that is simultaneously the primary interface to *this very approval system* — a user reviewing "did I actually approve that?" has no way to tell from the approval flow alone, since nothing prompts. It also has a direct SAC consequence (filed separately): a mutating subcommand like `wiki enrich` can reach `Status: accepted` with zero SAC proposal, because the shell-level gate that would otherwise force a human decision point is already wide open.

## Suggested direction (not prescriptive)

- Treat the harness's own binary name (`keryx`, from `process.argv0`/package name, not hardcoded) as another word `validateShellPattern` refuses a bare `<word> *` wildcard for, alongside the existing destructive-verb guard — on the same rationale already given for those: too broad a surface to ever be a "remember once" grant.
- Consider auditing/warning (not silently trusting) any bare single-word wildcard already present in a loaded `permissions.json`, the same way `loadShellPermissionsWithAudit` already surfaces `rejected`/`tampered` patterns to the user before the first auto-approve of a session.

## Environment

- `keryx 0.2.55` (npm `@mrciphersmith/keryx`)
- `~/.local/share/keryx/permissions.json` (real, on this machine)

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

_(flow-init skill appends here)_
