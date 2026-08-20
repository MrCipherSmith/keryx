# Keryx VS Code Extension — Brainstorm Records
Version: 0.2.0

Full Pragmatist/Innovator/Critic outputs and interview exchanges for the
two rounds that needed them (UI shape, v1 capability scope). Referenced
from decisions.md D-01/D-02.

## §1 — UI shape

### Ideas Map

**A. Status bar + Tree view + Output channel** (Pragmatist, S) — status bar
polls `/v1/status`; tree view from `/v1/projects`/turns; output channel for
SSE stream + CLI shell-out stdout. Zero webview.

**B. MCP registration + narrow "Turn Monitor" webview** (Pragmatist, M) —
`keryx mcp serve` registered for Copilot Chat (near-zero cost) + one small
webview for live turn-stream viewing only.

**C. Full multi-panel dashboard webview** (Pragmatist, L) — status+projects+
turns+actions in one tabbed webview, OpenTUI-dashboard-styled.

**D. Blast-radius/health CodeLens + gutter decorations** (Innovator, L) —
inline "N callers · blast radius: M files" via `gdgraph.affected`, health
hotspot gutter icons.

**E. SCM-style "SAC Review" panel** (Innovator, L) — Activity Bar tree of
pending SAC proposals, diff-like evidence view, Approve/Reject inline.

**F. Ambient status bar + wiki hover cards** (Innovator, M) — ESLint-style
status icon + editor hover cards from `wiki.query`/`wiki.ask`.

### Critical Questions (Critic)

1. Copilot Chat already calls all 21 MCP tools conversationally — what
   specific workflow does a persistent panel enable that a chat turn
   doesn't?
2. Who starts `keryx serve` before a webview can render anything — silent
   auto-spawn, or explicit consent?
3. Reads via HTTP+SSE/MCP, writes via CLI shell-out — how does one UI
   present a coherent loading/error model across two failure modes?
4. Where does the bearer token live for webview HTTP calls, and does CSP
   prevent it leaking to untrusted rendered content?
5. What is the actual ongoing cost of a second full UI for a single-author
   project already maintaining a TUI?
6. Could the dashboard be scoped read-only, deferring the two-mechanism
   straddle entirely — and is there still enough value if so?
7. What does VS Code Marketplace review/security posture look like for a
   webview talking to a local loopback server?

### Comparison Matrix

| | A (S) | B (M) | C (L) | D (L) | E (L) | F (M) |
|---|---|---|---|---|---|---|
| Duplicates Copilot Chat? | No | No (chat stays primary for 21 tools) | Yes, largely | No, unique | Partially | No |
| Daemon-lifecycle risk (Q2) | Some (tree/status) | Some (Turn Monitor part) | Yes | No (own MCP client) | No (own MCP client) | No (own MCP client) |
| Two-mechanism straddle (Q3) | Only action buttons | Minimal | Full | None (read-only) | Yes (approve/reject = mutation) | None (read-only) |
| Token/CSP risk (Q4) | No webview | Narrow | Wide | No webview | No webview | No webview |
| Novelty/value | Low-medium | Medium | Low (duplicative) | High | High | Medium-high |
| Fit for TUI-literate user | Good | Good | Poor | Excellent (in-flow) | Good (familiar pattern) | Excellent (ambient) |

### Recommendation (pre-interview)

A as the cheap, safe foundation (no webview, no CSP risk, no daemon-
lifecycle problem for most cases). MCP registration from B (config only,
not the webview) as a near-free prerequisite regardless of other choices.
F as A's natural extension — answers Q1 honestly (an ambient signal chat-
mode doesn't provide). D is the most substantive new idea (best answer to
Q1: warns *before* a risky edit, not after) but Effort L and needs the
extension to hold its own MCP client — phase 2, gated on real v1 usage. E
deferred — its mutation (approve/reject) drags in the full two-mechanism
straddle, and SAC review is a low-traffic workflow on a single-author
project today. C rejected outright.

### Interview (round 1)

- Q: Given TUI-in-webview is confirmed impossible, is the VS Code
  extension still wanted? → **A: Yes, in any case** (recommended option).
- Q: Agree with the A+MCP+F → D-later → E/C-dropped ordering? →
  **Yes, agreed** (recommended option).
- Q: Marketplace or private/internal? → **Marketplace, public.**
- Q: Commit to A+MCP+F+D as one plan, or stop at MVP and evaluate first? →
  **Start with MVP (S/M), evaluate real usage, decide on D after**
  (recommended option).

## §2 — v1 capability scope

### Ideas Map

**P1. Status+Projects only** (Pragmatist, S) — two tree nodes, two
commands (`Run Status Check`, `Initialize Project`). No hover, no SSE
streaming.

**P2. +Turns, +SSE output, +security signal** (Pragmatist, M) — adds
"Recent Turns" node, turn-submission command with SSE piped to the output
channel, status bar upgraded with a `security.check`-derived glyph.

**P3. Everything at once** (Pragmatist, L) — four tree nodes (incl.
per-project expandable turn children), five commands, hover provider —
the full D-01 shape realized immediately.

**I1. "Needs Your Attention" merged inbox** (Innovator, M–L) — one tree
section merging `flow.status`'s active task/AC and `sac.*`'s pending
proposals/reviews into one actionable worklist.

**I2. Ambient security signal + mutating-action audit log** (Innovator,
S–M) — auto `security.check` reflected on the status bar; every mutating
action logged as a structured line in the (already-existing) output
channel.

**I3. Hover extended to `gdgraph.affected`/`memory.search`** (Innovator,
M) — same hover surface, two more data sources (blast-radius count,
decision-memory snippet) layered onto the wiki snippet.

### Critical Questions (Critic)

1. Version-coupling: if `keryx` renames/changes a surfaced tool, who
   notices first — a silent editor failure, or a Marketplace GitHub issue?
2. Does a real day-one user need SAC+flow.status in their tree view, or
   are these included because they exist in the CLI, not because the
   audience will touch them?
3. Should `keryx init` be one click for a user who opened a folder they
   don't fully control (monorepo subpath, client repo, CI checkout)?
4. What happens the first time a hover card shows stale/wrong wiki info —
   does it poison trust in every other signal?
5. Are mutating shell-outs tested against real environment diversity, or
   only "works on the maintainer's machine"?
6. Does an unexplained red health/security signal just train users to
   ignore the status bar or uninstall?
7. **For a brand-new, uninitialized project, does v1 show anything
   meaningful at all** — or does everything (tree, hover, MCP) only light
   up for an already-established power-user setup, leaving the exact
   audience most likely to review/abandon with an empty first five
   minutes?

### Comparison Matrix

| | P1 (S) | P2 (M) | P3 (L) | I1 (M-L) | I2 (S-M) | I3 (M) |
|---|---|---|---|---|---|---|
| Answers Q7 (empty day 1)? | No | Partial | Partial | Worse (needs flow/SAC configured) | Yes (works immediately) | Yes (works on any code) |
| Answers Q2 (speculative)? | — | — | Carries SAC/flow | Directly hits the risk | No risk | No risk |
| New infrastructure | None | SSE stream | Hover provider | Merges two data shapes | Near-none (reuses output channel) | Hover provider (wiki's already there) |
| Version-coupling risk (Q1) | Low | Medium | High | High (2 sources) | Low | Medium |

### Recommendation (pre-interview)

v1 = MCP registration + polished init/offer-init flow (explicit confirm —
answers Q3) + P2's shape + I2 in full (answers Q1/Q5 via transparency) +
wiki-only hover. **I1 initially recommended DEFERRED** (direct hit on
Q2's speculative-relevance risk). I3 deferred to v1.1 (real answer to Q7,
but adds crowding/reliability risk on top of unshipped wiki-hover). P3 and
its full surface rejected as excessive for a single maintainer (Q1 risk
scales with surface).

### Interview (round 2)

- Q: Agree with the v1 set as recommended (I1 deferred)? →
  **No — bring I1 (SAC/flow-inbox) into v1.** Contradiction with the
  brainstorm's Q2-driven recommendation noted once per the interviewer
  protocol; operator's call treated as final (see decisions.md D-02).
- Q: Is I2's audit-log mandatory in v1, or can it be deferred as overhead? →
  **Mandatory in v1** (recommended option).
- Q: Should the "first five minutes" moment be extended (e.g. auto-reveal
  tree view right after init)? → **Yes, add auto-reveal** (recommended
  option) — became PRD Requirement 2.
