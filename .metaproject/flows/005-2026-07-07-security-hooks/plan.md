# Implementation Plan

Status: ready

## Approach

Two hooks, both offered at `init` behind confirm prompts + `--no-*` flags, both
managed (idempotent, merge-safe), both no-ops when security is disabled. Hook 1
reuses the existing git-hook machinery (exact analog of testing's pre-push). Hook
3 introduces a small, general merge-safe `.claude/settings.json` writer. No
engine/guard/detector changes.

## Steps

1. **T2 — Hook 1 (git pre-push).** Add `renderSecurityPrePushHook()` in
   `templates.ts` (managed block; body runs `gd-metapro security scan`/gate over
   changed+committable content and, per config mode, exits non-zero in
   enforced/ci, warns in advisory). Wire into `init.ts`: `enableSecurityPrePushHook`
   flag + confirm prompt + `--no-security-hook`; write to `.git/hooks/pre-push`
   merging with the existing testing pre-push managed block (both can coexist).
   Record in manifest `security.hooks.prePush`. Refresh in `update.ts`.
2. **T5 — Hook 3 (.claude agent hook).** Add `renderSecurityAgentHooks()` →
   the security hook entries, and a merge-safe installer that reads
   `.claude/settings.json` (or creates it), inserts the security `UserPromptSubmit`
   + `PreToolUse(Write|Edit)` command hooks under a managed marker, preserving all
   user content, and can be re-run idempotently. Wire into `init.ts`:
   `enableSecurityAgentHook` flag + confirm prompt + `--no-security-agent-hook`;
   record in manifest (e.g. `security.hooks.agent`). Refresh in `update.ts`.
3. **T6 — Registration polish.** Ensure both prompts appear only when security is
   enabled; update init module-flag help text; ensure `standard validate` still
   passes; update the security module manifest doc + `.metaproject/modules/security.md`.
4. **T3 — Tests.** git hook: install writes a managed pre-push block, coexists with
   testing pre-push, no-op when disabled, `--no-security-hook` skips. agent hook:
   merge-safe install into an empty AND a pre-populated `.claude/settings.json`
   (user entries preserved), idempotent re-install, `--no-security-agent-hook`
   skips, disabled = not installed. `bun run check` green (142 existing unchanged).
5. **T7 — Docs.** security spec/README (agent-protocol + hooks), roadmap, docs/docs
   (modules/cli-reference/workspace-and-lifecycle: the two new hooks + flags).
6. **T4 — Review + PR.** Review focus: merge-safety (never clobber user
   `.git/hooks/*` or `.claude/settings.json`), correct blocking only in
   enforced/ci, no-op when disabled, JSON well-formedness. Then draft PR → CI →
   complete.

## Risks

- **Clobbering user config (top risk):** `.claude/settings.json` and
  `.git/hooks/pre-push` may already contain user content. Must merge via managed
  markers only; back out cleanly. Mitigation: explicit merge-safe tests with
  pre-populated files.
- **Pre-push hook UX:** blocking must be gated on enforced/ci mode; advisory must
  never block a push (or users will disable it). Default config is advisory.
- **Claude Code hook schema drift:** use the documented `hooks` shape
  (UserPromptSubmit array; PreToolUse matcher+hooks). Keep it minimal and valid.
- **Interactive prompts in tests:** drive init non-interactively (`--yes` + flags).
- **Scope creep:** no engine changes; no non-Claude runtimes; no Phase 4.
