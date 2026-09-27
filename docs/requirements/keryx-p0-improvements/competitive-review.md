# Competitive review — keryx against ten coding agents, 2026-09-27

Version: 0.1.0

keryx 0.3.15. Method: a feature inventory of keryx from README, the docs
site, CHANGELOG (last ~30 releases), the wiki and ten live commands; a
research pass over official docs, changelogs and issue trackers for Claude
Code, Codex CLI, Gemini CLI, OpenCode, Aider, Goose, Cline, Amp, Cursor and
Kiro. Reliability caveats are in §7; read them before quoting a cell.

## 1. Summary

keryx occupies a niche none of the ten fills: **project knowledge committed to
git and read the same way by every agent** (code graph, generated wiki,
compressed command context, memory, health) plus **managed work** with
checksum-frozen acceptance criteria and multi-reviewer review with a verifier.
The nearest analogue for frozen criteria is Kiro, where the freeze is
prompt-enforced and documented to drift (kirodotdev/Kiro #5239, #6826). The
nearest analogue for the graph is Augment's Context Engine (a semantic index,
not a wiki). First-party delegation to other vendors' agents was not found
anywhere.

The weaknesses are proof and table stakes. The unique capability is, per
keryx's own docs, unrun against a real vendor. No file rewind, no PR review
action, no remote approval, a reduced Linux sandbox, no Windows.

## 2. Where keryx is ahead

| Capability | keryx | Nearest competitor |
|---|---|---|
| Project knowledge in git (graph, wiki, ctx, memory, health), shared by all agents | stable | none; Factory Droid "wikis", Augment Context Engine partial |
| Checksum-frozen AC, signed completion, flow state survives restart | stable | Kiro — prompt-enforced, drifts |
| Review: several reviewers, verifier, findings anchored to a quoted line, price per round | stable, local only | Cursor Bugbot — one reviewer, with a published metric |
| Delegation to Claude Code / Codex / Gemini CLI as children | exists, unproven live | none first-party |
| MCP client **and** server | stable | Claude Code, OpenCode, Goose only |
| OS sandbox + ask/trust/auto above a policy headless cannot bypass | stable | Claude Code, Codex comparable |
| Agent bus across worktrees with pause leases | stable | none |
| `/external` privacy switch | stable | none in this form |
| Published negative benchmarks of its own AI feature (Jev) | published | none |

## 3. 2026 table stakes keryx lacks or has weakly

| Expectation | Who has it | keryx |
|---|---|---|
| File rewind / per-turn snapshot | Claude Code, Gemini CLI, Kiro, OpenCode | transcript checkpoints only |
| PR review as a bot/Action | Claude Code, Cursor Bugbot, OpenCode, Kiro | local only |
| Remote approval | Cursor, Kiro, Codex Cloud, Claude Remote Control | `keryx serve` records a denial |
| Full sandbox on Linux | Claude Code, Codex | domain allowlist / credential masking / TLS macOS-only |
| Windows | Claude Code, Codex, Gemini, Kiro | none (flow 100 blocked) |
| Cross-session memory auto-extraction | Codex Memories, Cursor Projects | `learn` loop, TTY-gated per step |
| Semantic memory search by default | Cursor, Augment | opt-in (`memory index --embeddings`, `--semantic`) |
| Voice | Codex (default on), Aider | none in the CLI (helyx provides it) |
| Extension catalog | Gemini Extensions, Claude plugins, Cline marketplace | `bundle` + skill export, no public catalog |

## 4. Matrix

Y yes, P partial, N no, ? not found.

| Dimension | keryx | Claude Code | Codex CLI | Gemini CLI | OpenCode | Aider | Goose | Cline | Amp | Cursor | Kiro |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Providers / subscriptions / local | Y | P | P | P | P | P | Y | Y | P | P | P |
| 2 Persistent project knowledge | Y | P | P | P | P | P | P | P | N/P | P | P |
| 3 Context economy | P (unmeasured) | P | N | Y | P | Y | N | ? | ? | ? | P |
| 4 Sub-agents / worktrees / other vendors | Y (vendors unproven) | Y/N | Y/N | Y/? | Y | N | P | P | P | Y | P |
| 5 Plan, frozen requirements, durable task state | Y (checksum) | P | P | P | P | N | P | P | N | P | Y (prompt) |
| 6 Review | Y (local) | Y (Action) | P | N | P | P | N | N | N | Y (Bugbot) | P |
| 7 Safety | Y macOS / P Linux | Y | Y | P | P | N | P | P | P | P | P (CVEs) |
| 8 Extensibility | Y | Y | P | Y | Y | N | Y | P | P | P | Y |
| 9 Team / enterprise | P | Y | Y | P | N | N | P | Y | Y | Y | Y |
| 10 UX | P (no rewind, no voice) | Y | Y | Y | Y | P | Y | P | Y | Y | Y |
| 11 Openness | Y | P | Y | Y | Y | Y | Y | Y | N/P | N | N |
| 12 Momentum | Y | Y | Y | P | Y | N | Y | P | Y | Y | Y |

Column notes: Aider has no tagged release since August 2025 (community fork
cecli); OpenCode lost Claude-subscription OAuth on 2026-03-19 after spoofing
Claude Code's client headers; Gemini CLI's consumer audience moved to
"Antigravity CLI" mid-2026; Kiro had CVE-2026-10591 and two injection
disclosures in 2026.

## 5. Live friction log (keryx 0.3.15)

1. `keryx doctor` → "Unknown command" plus ~100 lines of usage; `mcp doctor`,
   `integrations doctor`, `standard doctor` exist. No did-you-mean.
2. `keryx mcp list` → the listing prints, exit code 1 because
   `~/.cursor/mcp.json` is malformed.
3. `keryx memory search "release"` → 0 results (lexical, no stemming;
   `--semantic` not suggested; the store has 21 entries).
4. `keryx health status` on keryx → `tests` and `coverage` sources `missing`
   although `bun test` exists.
5. `keryx gdgraph affected` → reports the graph predates HEAD by 1 632 files;
   honest, and a sign the graph goes stale within hours here.
6. Bare `keryx providers` prints usage where `health`/`security` print status.
7. `wiki ask` returns cited snippets in 0.5 s — correct, but the README example
   suggests a composed answer.
8. keryx's own wiki: architecture pages and one business rule; zero
   domain-model, user-scenario, service and integration pages.
9. From the audit: 8 import cycles, `tui-shell.ts` at 8 838 lines, the secret
   scan stops at its 8 MiB limit on the repository.

## 6. Improvements

P0 — this package: W1 external agents live, W2 `/rewind`, W3 review as a
GitHub Action, W4 remote approval, W5 first hour.

P1 and P2 — [backlog.md](backlog.md).

## 7. Reliability

- The keryx inventory came from docs and live commands without running `keryx
  shell` interactively; its claim "no semantic memory search" was wrong and is
  corrected above (opt-in exists).
- The web-search quota ran out mid-research; later competitor cells rely on
  direct reads of official docs. Complaint coverage is deepest for Claude
  Code, Aider, Goose and Kiro; thinner for Cline, Amp and Cursor.
- Moderate confidence: Codex CLI voice-by-default (v0.156) and the Codex model
  family names — check release notes before citing externally.
- Cline "?" cells are research gaps, not confirmed absences.
- Gemini CLI rows describe the open-source line, not the consumer successor.

## 8. Sources

docs.claude.com (changelog, memory, sandboxing, github-actions);
github.com/anthropics/claude-code/issues/34556; learn.chatgpt.com/docs;
developers.openai.com/codex/security; github.com/openai/codex;
github.com/google-gemini/gemini-cli; geminicli.com/docs; opencode.ai/docs;
agent.space; aider.chat/HISTORY.html; github.com/Aider-AI/aider/issues/4506;
goose-docs.ai; github.com/aaif-goose/goose (issues 8735, 10765, 11164);
agent-safehouse.dev; cline.bot; docs.cline.bot; ampcode.com (manual, news,
pricing); cursor.com (cli, changelog, bugbot, docs/agent/planning); kiro.dev
(docs/specs, hooks, mcp, enterprise, changelog); github.com/kirodotdev/Kiro
(issues 5239, 6826, 609, 3830, 950); kodemsecurity.com; thehackernews.com;
augmentcode.com; factory.com/news; warp.dev/blog.
