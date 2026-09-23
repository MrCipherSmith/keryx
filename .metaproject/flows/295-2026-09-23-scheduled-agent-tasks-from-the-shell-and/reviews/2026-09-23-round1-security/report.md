# Review — flow 295, scheduled agent tasks (PR #664), round 1 — security

Security review of the initial T5–T10 implementation of `agent-task` triggers and the
`keryx schedule` feature, run against commit `9c9557f9` before the fixes below landed.
Eight findings were raised, one critical (a forged/committed schedule store running code
outside the sandbox), two high (bypassing the confirmation card via `shell_exec`; the agent
patching the store file directly), one medium, and four low. All eight were acted on in the
fix commit that follows `9c9557f9` in the flow-295 journal, and are re-verified below against
the code that actually merged to `main` as `89dbea8dc25d80639ead9f7497287767138a040c` (PR #664,
squash-merged from head `4be4004daf96599ec3f2e28b1e6e4e8ab94a1c9d`; the two trees are identical
— `git diff 4be4004d 89dbea8d --stat` is empty).

```json keryx:findings
[
  {
    "id": "F1",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "blocker",
    "file": "src/trigger/config.ts",
    "quote": "schedule store",
    "problem": "A forged or git-committed schedule store entry could run code outside the hardened sandbox: the confirmation/content hash was a plain, unkeyed digest (forgeable), a store file could be tracked by git and shipped with the repo, a store entry could masquerade as a git-hook-triggered entry, and a granted tool's `bins` path was not pinned to a verified, out-of-project binary.",
    "impact": "An attacker who could write to the schedule store (or a git-committed trigger file crafted to look like one) could get keryx to execute arbitrary commands, either unattended on a timer or by having them treated as pre-confirmed, entirely outside the sandbox that every other unattended code path runs inside.",
    "suggested_fix": "Key the confirmation hash with a per-machine secret (HMAC), refuse any store tracked by git, restrict store/agent-task entries to `on.kind: \"schedule\"` only, and pin every granted binary's basename/realpath/sha256 at draft time, re-verified before every exec, refusing anything inside the project.",
    "evidence": "Pre-fix, the content hash was a plain sha256 with no keying, `isHookableTriggerEntry` did not exclude store-sourced entries, and a granted tool's `bins` path was accepted from inside the project with no realpath/sha pin.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/schedule-key.ts (HMAC key generation/read)",
        "src/trigger/config.ts (store load, git-tracked refusal, on.kind restriction, bins basename check)",
        "src/trigger/hooks.ts (isHookableTriggerEntry)",
        "src/trigger/granted-binary.ts (pin/verify realpath+sha256, project-root refusal)"
      ],
      "enumeration_method": "walked every way a schedule store entry reaches execution: (a) the content hash that gates re-use of a confirmed entry, (b) whether the store file itself can be committed to git, (c) whether a store entry can be dispatched through the git-hook trigger path instead of the schedule timer, (d) whether the binary a granted tool executes is the one that was verified. All four are distinct trust boundaries around the same store."
    }
  },
  {
    "id": "F2",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "major",
    "file": "src/lib/command-risk.ts",
    "quote": "touchesHumanConfirmation",
    "problem": "`shell_exec` of `keryx schedule add --yes`, or of `crontab`/`systemctl`/`launchctl` directly, or a remembered/allowlisted grant, could install or modify a schedule without ever showing the operator the confirmation card.",
    "impact": "An agent in `auto` or `trust` mode (or one abusing a saved shell allowlist) could install a persistent background timer with arbitrary grants without any human ever seeing what was being installed — defeating the entire point of the always-ask confirmation card.",
    "suggested_fix": "Add a dedicated scheduler-control matcher used at every approval site (shell, patch, agent tool-call, ACP, supervised MCP), and refuse `keryx schedule add|remove|pause|resume|run` outright when running inside an agent's own tool call (`KERYX_TOOL_CALL=1`).",
    "evidence": "Pre-fix, `touchesHumanConfirmation` had no scheduler-specific matcher, so `shell_exec keryx schedule add --yes` and direct `systemctl`/`crontab`/`launchctl` invocations reached execution without the always-ask floor.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/command-risk.ts (touchesSchedulerControl / touchesHumanConfirmation)",
        "src/lib/shell-permissions.ts (validate/allowed/suggest)",
        "src/commands/shell-approval.ts",
        "src/commands/agent.ts (executeCall)",
        "src/harness/external/acp-permission.ts",
        "src/harness/external/supervise-mcp.ts",
        "src/commands/schedule.ts (KERYX_TOOL_CALL refusal on add/remove/pause/resume/run)"
      ],
      "enumeration_method": "enumerated every place a shell command or tool call is approved before running: shell approval, shell permission validation, the agent's own executeCall, ACP's permission bridge, and supervised MCP — every one of them needed the same scheduler-control check, plus a floor inside `keryx schedule` itself for when the agent shells out directly."
    }
  },
  {
    "id": "F3",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "major",
    "file": "src/lib/command-risk.ts",
    "quote": "touchesAgentCredentials",
    "problem": "The agent could write to the schedule store file directly with a file-patch tool, bypassing the confirmation flow that only gated `keryx schedule add`.",
    "impact": "A patch tool call editing `.metaproject/data/trigger/schedules.json` (or the signing key, or the OS scheduler's unit directories) directly would install or alter a schedule with no confirmation card at all, since the gate that mattered was on the CLI subcommand, not on the file.",
    "suggested_fix": "Mark the store file, the HMAC key, and the systemd/launchd unit directories as credentials-class paths, gated the same way as the agent's own saved credentials, for both shell writes and file-patch writes.",
    "evidence": "Pre-fix, `CREDENTIAL_MARKERS` did not include the schedule store, key or unit directories, so a patch tool call targeting them was treated as an ordinary file write.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/command-risk.ts (CREDENTIAL_MARKERS, touchesAgentCredentials)",
        "src/lib/patch-risk.ts (file-patch write gating)",
        "src/lib/shell-permissions.ts (shell write gating)",
        "src/harness/external/acp-permission.ts / acp-fs.ts"
      ],
      "enumeration_method": "enumerated the two ways a tool can write a file (shell redirection/command, and the dedicated patch tool) and both ACP write paths; the store, key and unit directories needed the same credentials-class marker on all four."
    }
  },
  {
    "id": "F4",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "minor",
    "file": "src/commands/trigger.ts",
    "quote": "trigger run --schedule",
    "problem": "A committed (non-store) trigger entry sharing a schedule's name could hijack the schedule's installed timer, since the timer's invocation resolved against the general trigger set rather than the schedule store specifically.",
    "impact": "A git-committed trigger crafted with the same name as an operator's local schedule could run under that schedule's timer identity, executing unreviewed, committed logic on a background cadence the operator believed was running their confirmed schedule.",
    "suggested_fix": "Have the installed timer invoke `trigger run --schedule <name>`, resolving ONLY against the per-machine schedule store, and refuse a committed trigger whose name clashes with a store entry, keeping the store entry authoritative.",
    "evidence": "Pre-fix, the installed unit ran `trigger run <name>` with no `--schedule` flag, resolving against the full trigger set (store plus `triggers.json`) with no name-clash refusal.",
    "confidence": "medium"
  },
  {
    "id": "F5",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "info",
    "file": "src/commands/trigger-agent-task.ts",
    "quote": "scrubGrantedOutput",
    "problem": "Granted-tool output was capped before it was scrubbed, so a secret could be left dangling across the truncation boundary; and the scrub did not cover GitHub token shapes or the live `gh auth token` value.",
    "impact": "A secret split across the cap boundary, or a GitHub token/`gh auth token` value, could reach the model or the report unredacted.",
    "suggested_fix": "Scrub before capping, drop the trailing partial line on truncation, and add patterns for GitHub token shapes, `Authorization:` headers, `*_AUTH`-shaped env values, and the literal `gh auth token` output.",
    "evidence": "Pre-fix, output was capped first and scrubbed second, and the pattern set did not include GitHub token shapes or the live `gh auth token` value.",
    "confidence": "medium"
  },
  {
    "id": "F6",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "info",
    "file": "src/trigger/granted-binary.ts",
    "quote": "resolves inside this project",
    "problem": "A granted tool's `bins` path could point inside the project itself, letting the project supply the binary that will execute with the agent's own credentials.",
    "impact": "If the project were untrusted (a cloned repo, a compromised dependency), it could plant a binary at the granted path and have it run with the operator's granted tool identity.",
    "suggested_fix": "Refuse any granted binary path that resolves inside the project, at both draft and run time.",
    "evidence": "Same defect as F1's fourth sub-claim — pre-fix, no project-root check existed on a granted tool's resolved binary path.",
    "confidence": "medium"
  },
  {
    "id": "F7",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "info",
    "file": "src/trigger/schedules.ts",
    "quote": "cardSafe",
    "problem": "The confirmation card had no defence against terminal control characters or ANSI escapes in a schedule's name or prompt, which could visually spoof the card's contents.",
    "impact": "A crafted schedule name/prompt containing ANSI escapes or embedded newlines could make the confirmation card display different information than what was actually being installed, misleading the operator's approval.",
    "suggested_fix": "Strip ANSI/control characters and render literal newlines as a visible glyph on every card line.",
    "evidence": "Pre-fix, card lines were rendered with no sanitisation of control characters or embedded newlines.",
    "confidence": "medium"
  },
  {
    "id": "F8",
    "reviewer": "security-reviewer (flow 295)",
    "severity": "info",
    "file": "src/commands/schedule-tools.ts",
    "quote": "confirmationToken",
    "problem": "A declined or never-confirmed draft schedule from `schedule_create` had no mechanism preventing it from later being installed on a replay or a race.",
    "impact": "A draft that the operator declined, or that was denied by an unattended/read-only run, could still end up invoked if the tool were called again with the same request.",
    "suggested_fix": "Require a one-time confirmation token, issued only after the operator's explicit yes, and drop the draft entirely on decline.",
    "evidence": "Pre-fix, `schedule_create`'s invoke step required no token distinguishing a confirmed draft from an unconfirmed one.",
    "confidence": "medium"
  }
]
```

## Coverage

Reviewed: `src/trigger/config.ts` (store load, validation, hashing), `src/trigger/schedule-key.ts`,
`src/trigger/hooks.ts`, `src/trigger/granted-binary.ts`, `src/lib/command-risk.ts`,
`src/lib/shell-permissions.ts`, `src/lib/patch-risk.ts`, `src/commands/schedule.ts`,
`src/commands/schedule-tools.ts`, `src/commands/trigger.ts`, `src/commands/trigger-agent-task.ts`,
`src/trigger/schedules.ts`. Not reviewed: the rest of the repository, unchanged by this flow.

## Outcome

Eight findings recorded: one blocker, two major, one minor, four info. All eight were acted on
in the fix that followed commit `9c9557f9`, and are independently re-verified below against
`89dbea8dc25d80639ead9f7497287767138a040c` (== worktree HEAD `4be4004daf96599ec3f2e28b1e6e4e8ab94a1c9d`,
identical trees), each against its own named regression test in
`src/commands/schedule-security.test.ts` or `src/trigger/config.test.ts`.
