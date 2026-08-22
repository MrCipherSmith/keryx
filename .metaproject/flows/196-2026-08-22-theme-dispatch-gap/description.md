# agent-mode readline: /help advertises /theme but it has no dispatch branch

Status: formalized
Source: https://github.com/MrCipherSmith/keryx/issues/393

## Problem

`READLINE_AGENT_COMMANDS` (what `/help` advertises in agent-mode readline)
and the actual agent-mode dispatch chain in `shell.ts` have drifted apart for
`/theme`: it is listed by `/help`, but its only dispatch branch lives in the
separate CHAT-mode block. Typing `/theme` in agent-mode readline falls
through to the generic "Unknown command: /theme. Type /help." handler — a
self-contradicting UX confirmed live (session `01b43d57`).

Correction already applied to the original catalog/issue: `/status` and
`/flows` were initially suspected of the same gap; live re-testing during the
campaign disproved that (they dispatch correctly via `isSessionInfoCommand`/
`isFlowsCommand` helper predicates that a static grep-only trace missed).
Only `/theme` is genuinely affected — issue #393 was retitled accordingly.

## Expected Outcome

Pick one direction and implement it (recommendation: (b), a readline-degraded
theme picker is more useful than silently hiding a documented command):

(a) Remove `/theme` from `READLINE_AGENT_COMMANDS` if it is meant to stay
    TUI-only, so `/help` no longer advertises something agent-mode readline
    can't run; or
(b) Add an agent-mode readline dispatch branch for `/theme` (degraded UX vs.
    the TUI picker — e.g. list available themes and accept `/theme <name>` —
    same pattern as `/mode`/`/search-provider` already use in readline).

## Out of Scope

The TUI theme picker itself (already works correctly). Any other
slash-command registry gaps beyond `/theme`.
