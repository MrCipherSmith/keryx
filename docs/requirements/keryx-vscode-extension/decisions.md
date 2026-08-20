# Keryx VS Code Extension — Decisions
Version: 0.2.0

The four open questions the original discovery pass (`a0ebce1`) deferred,
each resolved through a structured brainstorm (Pragmatist/Innovator/Critic
— full records in brainstorm.md) plus an interview round with the operator.

## D-01: UI shape

**Question.** Terminal-embed, webview dashboard, full webview, or a
lighter native-VS-Code-API combination?

**Options from brainstorm (full detail: brainstorm.md §1):**
- A — status bar + tree view + output channel, no webview (Pragmatist, S)
- B — MCP registration + one narrow "Turn Monitor" webview (Pragmatist, M)
- C — full multi-panel dashboard webview (Pragmatist, L)
- D — blast-radius/health CodeLens + gutter decorations (Innovator, L)
- E — SCM-style "SAC Review" panel (Innovator, L)
- F — ambient status bar + wiki hover cards (Innovator, M)

**Decision.** A + MCP registration (the config part of B, not its webview)
+ F. C rejected outright. D deferred to v1.1, gated on real v1 usage. E
folded into v1's tree view as the "Needs Your Attention" node (see D-02)
rather than a separate SCM-style panel — a cheaper realization of the same
idea within the already-decided no-webview shape.

**Reasoning.** The critic round's central question — "what does a
persistent surface give you that a Copilot Chat turn doesn't?" — is best
answered by A+F (ambient signals, ready before you ask) and worst answered
by C (a static mirror of chat-accessible tools at much higher webview/CSP/
daemon-lifecycle cost). E's core idea (governance review as a first-class
surface) survived, its webview-heavy execution did not.

**Premise check (interview round 1, Q1).** Before committing to any shape:
the original request was for a UI "ideally with its own TUI," and Finding
4 confirms that's impossible. Operator confirmed the visual-UI goal stands
independent of the TUI-embedding idea — not a reason to abandon the
extension.

## D-02: v1 capability scope

**Question.** Given the D-01 shape, which specific tree nodes/commands/
hover sources are must-have for v1 vs. deferred?

**Options from brainstorm (full detail: brainstorm.md §2):**
- P1 — Status+Projects only, minimal (S)
- P2 — +Turns, +SSE output, +security signal (M)
- P3 — everything in the D-01 shape at once, 4 nodes + hover (L)
- I1 — "Needs Your Attention" node merging `flow.status`+`sac.*` (M–L)
- I2 — ambient security signal + mandatory audit-log (S–M)
- I3 — hover extended to `gdgraph.affected`/`memory.search` (M)

**Decision.** v1 = MCP registration + polished init-flow (explicit confirm,
auto-reveal on success) + P2's tree shape + I1 (**overriding the initial
brainstorm recommendation** — see below) + I2 in full (audit-log mandatory,
not optional) + wiki-only hover (I3 deferred to v1.1).

**Reasoning — and one explicit override.** The critic round's sharpest
finding: for an uninitialized project, nothing in v1 shows anything
meaningful except the init-flow itself — which is why D-02 also elevates
the init→auto-reveal transition to a named requirement (PRD Requirement 2),
not an implementation afterthought. The brainstorm's own synthesis
initially recommended DEFERRING I1 (SAC/flow-inbox) as speculative for a
day-one audience that may not have those modules configured (Critic Q2).
**The operator overrode this explicitly** in the interview round, choosing
to ship I1 in v1 regardless. Per the interviewer protocol, this
contradiction was surfaced once and the operator's call stands as final —
recorded here, not re-litigated. The accepted mitigation is a required
legible empty state (specification.md §2.4), not removing the feature.

## D-03: MCP-client sequencing vs. the dashboard

**Question (original framing).** Should VS Code's native MCP client
integration (Finding 3) be pursued in parallel with a webview dashboard, or
should one come first?

**Decision.** Question dissolved, not answered as originally framed. D-01
already rejected the full dashboard (C) outright, and folded MCP
registration into v1 as a near-zero-cost prerequisite from the start — so
there is no "parallel vs. sequential" tradeoff left to make. Confirmed
explicitly with the operator rather than silently assumed (the interviewer
protocol's Step 2 filter — "keep a question only if different answers lead
to different work" — applies retroactively here once D-01/D-02 had already
settled it).

## D-04: Distribution

**Question.** VS Code Marketplace (public) or private/internal-only?

**Decision.** Marketplace, public. Resolved during D-01's interview round
(not a separate round) — see brainstorm.md §1's interview report for the
verbatim exchange. Consequence: PRD Requirement 9 and specification.md
AC9 (Marketplace publish validation) exist because of this choice; a
private-only path would not have needed them.
