# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx agents external enable` sets user-global `externalAgents.enabled=true` and, when `.metaproject/metaproject.json` exists, the `gdskills.external-agents` entry to `enabled: true`; it changes no other key of either file and leaves every other tracked file untouched. A manifest that is not valid JSON is refused, not overwritten.
- AC2: `keryx agents external disable` reverses exactly what `enable` wrote; both are idempotent and print what they changed or that nothing changed.
- AC3: `claude`, `codex` and `agy` (case-insensitive) resolve to `claude-cli`, `codex-cli` and `antigravity-cli` in `/delegate`, in every `keryx agents external <subcommand> <id>`, and in a `spawn_subagent` `runtime.agent`. An unknown name is still refused with the list of known agents.
- AC4: an alias never weakens a per-agent setting: with `externalAgents.agents["claude-cli"].enabled=false`, `/delegate claude`, `keryx agents external run claude` and a `spawn_subagent` with `agent: "claude"` are all refused exactly as their canonical forms are; the consent and vendor gates also key on the canonical id (tests).
- AC5: every capability refusal (user-global layer and project layer) names `keryx agents external enable` as the fix; the `/delegate` refusal in the shell shows it.
- AC6: TUI: the shell offers the same action from the composer (a documented slash command) and the `/delegate` refusal names it; the sidebar external-agent rows and modals are unaffected (test or a stated reason in the journal).
- AC7: README or docs site, `keryx agents external --help`, commands-by-task and CHANGELOG describe `enable`, `disable` and the short names; version bumped to 0.3.44.
- AC8: live smoke with the installed release: in a scratch project, `keryx agents external enable` then `keryx agents external run claude --task <read-only task>` reaches claude-cli and returns a result; the operator's keryx repo working tree gains no generated files.
