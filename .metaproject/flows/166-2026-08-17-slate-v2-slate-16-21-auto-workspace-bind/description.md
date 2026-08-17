# Slate v2 (SLATE-16..21)

## Problem

Source of truth: `docs/requirements/slate/prd.md` (v2.0.0, Problem "v2 addendum")
and `docs/requirements/slate/specification.md` (v2.0.0). Do not re-derive —
read those files.

Slate v1 (SLATE-1..15) is implemented but two gaps survived: (1) workspace
binding stayed 100% manual (only `/goal --workspace <id>`, never the default
action-intent path, never re-checked mid-session) despite v1's own design
intent to make this easier; (2) SLATE-7's wrap-up composer never actually
switched off raw-transcript evidence — `resolveSessionWrapUp`
(`src/sac/session-wrap-up.ts`) still exports the whole session transcript
verbatim. Separately, `sac.review`/`workspace review --decision accepted`
have a known, previously-deferred self-accept gap (`interactive: true` is a
hardcoded trust flag, not a real check), and keryx-shell's own interactive
agent lacks `propose`/`create`/`list` tools that MCP clients already have.

## Expected outcome

SLATE-16..21 implemented exactly as specified in specification.md's
Functional surface table and Acceptance criteria (AC-24..AC-33). Four
phases, strictly sequential (each phase's tools are used by the next):

1. SLATE-20 (review confirm-token) + SLATE-21 (finish SLATE-7 machine evidence)
2. SLATE-19 (cross-runtime agent-tool parity: workspace_create/list/show/propose)
3. SLATE-16 (workspace resolve-or-create) + SLATE-17 (mid-session re-evaluation)
4. SLATE-18 (autonomous wrap-up dispatch)

## Out of scope

- RP-03's remaining scope (`keryx shell --workspace <id>`, `--session current`,
  Flow/worktree derivation preview, accepted-target link-back) — untouched.
- `workspace_review`/accept as any agent-native tool — never added, on any
  runtime (CLI/MCP/keryx-shell). This is a hard invariant (AC-29), not a
  deferred nice-to-have.
- Subagent access to workspace resolve/create/propose — subagents keep their
  existing SLATE-6 ephemeral-slate-only scope (AC-32).
