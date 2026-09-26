# Jev EDIT GUARD: PostToolUse hook for rule-violation feedback

Status: implemented
Source: user description

## Problem

Rule violations a coding agent introduces are caught only at the next review
round, after the agent has already moved on and the violation has to be
re-discovered and re-explained. There is no fast, cheap, in-the-moment check
that reads the project's own written rules and tells the agent "this edit
likely violates rule X" while it is still working on that file.

## Expected Outcome

A Claude Code `PostToolUse` hook (`keryx review jev-edit-guard --hook
claude`) diffs the file an `Edit`/`Write`/`MultiEdit` just touched against
`HEAD`, checks the changed region against every applicable project rule
clause using Jev (reusing `review jev-rules`'s discovery/tagging/pair-
selection/batching/threshold machinery unchanged), and feeds violations
above threshold straight back to the agent through the hook's own
`additionalContext` channel. It is silent when nothing is flagged, and it
fails open (silent, exit 0) on any error, timeout, or missing credential —
never blocking a tool call. Opt-in per project
(`review.jev.edit_guard`/`edit_guard_threshold`/`edit_guard_max_calls` in
`.metaproject/tasks.config.json`), with a merge-safe
`install`/`uninstall`/`status` CLI and a TUI `/editguard` modal + sidebar
indicator, mirroring the existing `/guard`/`/route` opt-in features.

Threshold default is `0.5`, chosen for precision over recall per the
measured numbers (a real project, 10 tasks × 2 runs, a large production
React/MobX frontend): violations reaching the first review round fell 27 →
10 (−63%), review rounds 31 → 24, at the same total cost; at 0.2 the guard
flagged almost everything and the agent ignored it.

## Out of Scope

- Any runtime other than Claude Code (`--hook claude` is the only codec).
- Blocking a tool call — this hook is advisory-only, by construction.
- A new violation-scoring model or threshold-tuning UI — reuses
  `review jev-rules`'s existing scoring exactly.
