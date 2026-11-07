# Keryx under herdr: no agent approves a dialog by accident; hc delegation is a conscious choice

Status: formalized
Source: operator's research session, 2026-11-06/07 (live runs of herdr-core `hc` against keryx, Claude Code, Codex and OpenCode)

## Problem

Under herdr-core a child agent's report is typed into its parent's terminal. In keryx 0.4.11, `hc send --force` with an unrelated report, and `hc keys enter`, approved an open permission dialog: the report text vanished and the transcript said `approved (once)`. A keryx child refused to press Enter itself, yet a test script it ran did. The approval dialog's input guard counts only single key presses, so a paste does not hold back the Enter after it.

`buildHerdrCoreSection` (flow 481) tells the model to delegate with `hc run`, with no comparison to `spawn_subagent` or the external runtime, no ban on answering another terminal's dialog and no cleanup. In a live session keryx started Claude Code unasked, spending the operator's subscription outside every keryx limit, and left finished children running. A Claude child's plain `hc send` carries no `<hc>` tag, because herdr tags only when both sides report status, so keryx took the report for the operator's words.

## Expected Outcome

- A paste into an open dialog never approves it and is not lost.
- An agent's own `hc keys`, `hc send --force` or forged `HC_TERMINAL_ID` always reaches a person, in every permission mode, and cannot be saved as always-allow.
- The first `hc run` of each agent in a session asks a person, in every permission mode.
- The prompt states when to use native subagents, the external runtime or `hc`, forbids answering another terminal's dialog, and covers cleanup. It names a keryx path that resolves.
- keryx children report over the bus; Claude and Codex children report with `keryx report`, which reaches the parent as an external agent's data, never as the user's words.
- External runtime children do not inherit herdr's terminal identity.
- A terminal approval under herdr is marked in the transcript as unverified by author.

## Outcome criteria

- The live stand from the research: `hc send --force` with a report no longer approves a dialog in keryx, and a Claude child's `keryx report` shows as an external agent's message.
- not measured beyond that: how often the accident happens in real sessions was never counted.

## Out of Scope

- A hard boundary against a script running `hc keys` (remote-only approvals, a sandbox profile without the hc socket): separate decision, recorded as still open.
- External agents as long-lived bus peers: the next program; this flow only makes the new event origin reusable by it.
- Claude, Codex or OpenCode dialogs: not keryx's code. Authenticating senders in herdr-core: upstream.
- The `spawn_subagent model_class requires active routing v2` error: owned by PRs #1139 and #1133.
