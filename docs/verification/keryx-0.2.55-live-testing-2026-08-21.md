# keryx 0.2.55 — live-testing report (real shell, real provider, real MCP)

Date: 2026-08-21/22 · CLI: `keryx 0.2.55` (npm `@mrciphersmith/keryx`, globally installed
during this pass, previously `0.2.53`) · Provider: `deepseek/deepseek-chat` (real
`api.deepseek.com` calls, key from this machine's `~/.local/share/keryx/auth.json`)

This is the operator record for a live-testing pass that started as root-causing a
real production bug (session `8ad50700`) and expanded into hands-on verification of
the 0.2.50–0.2.55 release cycle's headline features. Every claim below is backed by a
session id, an on-disk artifact, or a command capture — no mocked providers, no
scripted fixtures. Session ids are the store's short id (first 8 hex chars shown in
`keryx sessions list`); full ids and on-disk paths are given where useful for re-check.

Session store root: `~/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx/`

**Important scope note:** every test below ran `keryx shell --no-tui`, the readline
fallback, piped from a non-interactive shell — never the real OpenTUI (mouse, modals,
arrow-key nav). Verified by reading source: `src/commands/shell.ts` (readline) and
`src/tui/tui-shell.ts` (OpenTUI) both call the *same* `AgentIO.onAutoApproved` /
`executeCall` / `runGoalCommand` engine in `src/commands/agent.ts` and
`src/commands/goal-command.ts` — only the rendering surface differs. So every finding
about Slate/Workspace/SAC/approval-gate/`/goal` behavior below is backend-engine
behavior, reproducible identically in the real TUI. TUI-only surfaces (Tools/MCP
modal, `/search-provider`, `/search-connect` pickers, VS Code/Cursor extension,
standalone binaries) were **not** exercised this pass — they need a real terminal or
GUI.

---

## 1. The bug that started this pass (fixed, released as 0.2.55)

Session `8ad50700` (full: `d764fca9-c1c2-4978-900e-1a2d8ad50700`), captured before the
fix, on `keryx 0.2.53`: a parallel-`tool_calls` assistant turn stalled with a real
DeepSeek 400 — `"An assistant message with 'tool_calls' must be followed by tool
messages responding to each 'tool_call_id'"` — and every following turn in that
session replayed the same broken history and failed identically.

Root cause: `runAgentTurnCore`'s per-tool-call loop (`src/commands/agent.ts`) pushed
the SLATE-2a Anchors-block (and the repeated-failure hint) into `history` **inside**
the loop over a batch of parallel `tool_calls`, splicing a `role:"user"` message
between two `tool` results that answer the same assistant turn.

Fix: PR [#387](https://github.com/MrCipherSmith/keryx/pull/387) — both injections
deferred to run once, after the whole batch's `tool` results are recorded. Release
prep: PR [#388](https://github.com/MrCipherSmith/keryx/pull/388) — version bump +
CHANGELOG. Tagged `v0.2.55`, `Release` workflow green (npm publish + GitHub Release),
run [32519915315](https://github.com/MrCipherSmith/keryx/actions/runs/32519915315).

**Re-confirmed live** on `0.2.55` in session `2b5b444f`
(`dd3b546b-22a9-4864-a466-ca822b5b444f`): a real assistant turn issued 2 parallel
`tool_calls` (transcript indices 7–9); both `tool` results landed contiguously, no
`user` message spliced between them, no provider error. Fix holds under real DeepSeek
traffic, including later in this same pass under a heavier 3-way-parallel
`spawn_subagent` batch (§4) — no interleaving regression anywhere in this whole
testing pass.

---

## 2. Slate v3 MCP tools + `skills_catalog`/`skill_load` (0.2.53/0.2.51)

Not tested through this Claude Code session's own MCP connection (frozen at session
start, predates the 0.2.55 upgrade). Instead: a standalone script
(`@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`) spawned a **fresh**
`keryx mcp serve --cwd <repo>` process and drove the real protocol.

- `tools/list` → 39 tools.
- `slate.open` → `slate.writeSeed` → `slate.close` — full real lifecycle, all three
  calls succeeded, returned real JSON (anchors/seeds/`closed:true`).
- `skills_catalog` → real catalog data, 45 skills returned.
- `skill_load` present and reachable (name confirmed in `tools/list`; not separately
  invoked).

No findings here — both features work exactly as advertised.

## 3. Native OpenAI/Gemini provider recognition (0.2.50/0.2.51)

No `OPENAI_API_KEY`/`GEMINI_API_KEY` on this machine, so only the fail-closed path was
exercised: `keryx harness run --provider openai ...` and `--provider gemini ...` both
fail closed immediately with a clear, correct message, no network attempt. Matches the
CHANGELOG claim. Real live success-path testing needs a key this machine doesn't have.

## 4. `/goal --auto [N]` (SLATE-27) — works end-to-end; two real reliability gaps

### 4a. Syntax note (not a bug, a real gotcha)

`--auto [N]` is recognized **only when it trails** the `/goal` text (by design —
`parseGoalArgs`'s own docstring, `src/commands/goal-command.ts:54-105`, protects
against a goal that merely mentions "--auto" mid-sentence). A first attempt
(`/goal --auto 1 <text>`, flag *first*) silently failed to arm anything — no error, the
whole string including `--auto 1` was just sent as goal text (session `263da4a5`,
`c390c024-6b6a-4c1d-8b50-4b6c263da4a5`). Corrected syntax (`/goal <text> --auto 1`,
flag *trailing*) worked immediately (session `df8710d6` below).

### 4b. Round-loop + flow auto-provisioning — confirmed real

Session `df8710d6` (`4f3b7eb5-a514-476e-8732-6087df8710d6`), goal: count `.ts` files
in `src/harness/provider`, `--auto 1`. Real, on-disk evidence:
- `.metaproject/flows/188-*` — Flow 188 auto-provisioned by `autoProvisionFlow`
  (`goal-command.ts:257`), title = the goal text, generic T1–T4 scaffold + one AC.
- Round 2/2 continuation fired (`systemLine`: `/goal --auto: round 2/2 — continuing
  toward the goal.`), read `flow_status`/`slate_read`, correctly reasoned the generic
  T1–T4 template didn't apply to a read-only counting task, and called
  `workspace_propose` (kind `memory-entry`) recording the finding.
- **Verifier ran silently** — no `⚙ spawn_subagent` line, nothing in
  `transcript.jsonl` names a `spawn_subagent` call anywhere in this session, yet the
  loop terminated normally with no extra round (consistent with an `achieved: true` or
  an `undefined` verdict — both are silent per source, see #389).

Session `1be94528` (`4d71504a-fdd3-47aa-b91a-88231be94528`, resumed across two runs),
goal: parallel 3-module investigation via `spawn_subagent`, `--auto 2`, run under
`/mode trust`:
- Flow 189 auto-provisioned.
- Round 1: **3 real parallel `spawn_subagent` dispatches in one batch**, auto-approved
  under `trust` mode (`◇ auto-approved (trust) spawn_subagent` ×3) — three distinct
  real child sessions (`sub:8c89e565…`, `sub:4d2300fd…`, `sub:bfbe23da…`), all
  completed, fed a genuine comparative summary of `src/wiki`/`src/gdgraph`/`src/health`.
  (Under headless `ask` mode with no `/mode trust`, the same 3-way batch correctly
  required approval and was denied twice with no human present — agent gracefully
  fell back to manual `list_dir`/`read_file` and disclosed the fallback to the user.)
- Round 2/3, round 3/3 fired correctly; 3 `workspace_propose` calls recorded.
- **Verifier ran and was visible this time** (`!achieved` branch prints a
  `systemLine` — see #389) — but its stated reasoning was factually wrong (see #392
  below).

### 4c. Finding: verifier is silent on success/unavailable — issue [#389](https://github.com/MrCipherSmith/keryx/issues/389)

`runGoalVerifier` (`goal-command.ts:379`) calls `tool.invoke()` on the
`spawn_subagent` tool **directly**, bypassing `executeCall`/`io.onToolCall` entirely —
so its dispatch and verdict never appear in the CLI output nor in `history`/
`transcript.jsonl`, *except* when `verdict.achieved === false` (the only branch with a
`systemLine`). Session `df8710d6` above is a live instance of the silent case: no
observable way to tell "verifier ran and approved" from "verifier tool absent, never
ran at all."

### 4d. Finding: verifier's verdict contradicted real evidence in the same session — issue [#392](https://github.com/MrCipherSmith/keryx/issues/392)

In session `1be94528`, after real, evidenced work (3 real subagent dispatches, 3 real
`workspace_propose` records), the verifier reported:

> "there is no evidence in the repo that the three spawn_subagent read_only subagents
> were actually dispatched in a single batch, nor that the comparative summary was
> produced."

Both claims are false — directly falsified by the same session's own transcript and
proposal records. The one true part ("flow 189 shows 0/4 tasks completed") is real
only because nothing in `/goal --auto`'s loop ever calls flow-task-completion — the
generic T1–T4 scaffold is structurally guaranteed to stay `in-progress` forever by
design (`autoProvisionFlow`'s own AC text says completion is judged by the verifier,
not the checkboxes) — but the verifier apparently leaned on that always-incomplete
signal instead of the real evidence trail sitting right next to it.

## 5. SAC workspace/slate/proposal pipeline — works, but is optional, not enforced

Session `53609f7a` (`d3d97ce6-12a3-4722-8a98-677953609f7a`), task: write real wiki
documentation for `src/sac` (open-ended, not scripted).

- **Slate**: opened (action-request heuristic), tracked `touched`, archived at turn
  end — `slate-archive/2026-08-21T20-27-00.235Z-1.json` on disk.
- **Workspace**: resolved via SLATE-16 resolve-or-create → reused pre-existing
  `workspace-e1b704272f124ba7`.
- **Proposal**: **none created.** The agent used `keryx wiki new` (draft) then
  `keryx wiki enrich --prompt "..."` (rewrites prose **and flips `Status: accepted`**)
  via `shell_exec` — never `workspace_propose`/`sac.review`. Confirmed on disk:
  `.metaproject/wiki/components/src-sac.md` has `Status: accepted`, zero human review.
  `keryx workspace list-proposals workspace-e1b704272f124ba7` → `[]`.
  `keryx workspace catch-up` files this session under **"Unknown (no resolution
  recorded)"** — SAC's own catch-up surface has no idea a real, durable mutation
  happened.
- An `apply_patch` correction attempt (fixing the first enrich pass's hallucinated
  content) **was** correctly approval-gated and denied (headless, no human) — the
  agent's response was to re-achieve the identical content change via
  `shell_exec keryx wiki enrich --prompt "<same intent>"` instead, which succeeded,
  because that shell command was already auto-approved.

Root cause traced to this machine's own `~/.local/share/keryx/permissions.json`,
which contains a bare `"keryx *"` allow pattern — auto-approving *every* future
`shell_exec keryx ...` invocation, forever, across every project. Confirmed this was
not produced by the normal `[A=always]` remember flow (`rememberExactShellGrant`
only ever stores the *exact* full command string, never a wildcard) — it must have
been added some other way (hand-edited, or an older code path), and
`validateShellPattern` (`src/lib/shell-permissions.ts`) does not special-case the
harness's own binary name the way it already special-cases other broad
destructive-verb wildcards (e.g. `rm *`).

Two issues filed:

- [#390](https://github.com/MrCipherSmith/keryx/issues/390) — shell-permission
  validation lets a bare `keryx *` wildcard through, silently defeating per-call
  approval for the entire CLI surface.
- [#391](https://github.com/MrCipherSmith/keryx/issues/391) — mutating `keryx` CLI
  subcommands (`wiki enrich`, etc.) are not structurally coupled to SAC review; an
  agent can reach the identical durable outcome (`Status: accepted`) via the CLI
  equivalent of a denied `apply_patch`, with zero proposal, invisible to
  `workspace catch-up`.

**Not touched:** `~/.local/share/keryx/permissions.json` itself — that's this
machine's own trust store; left for the user to decide whether to narrow it.

## 6. Open observation — not filed as an issue (needs a clean re-run to confirm)

In session `1be94528` (test in §4b/§4d), the `workspace_propose` calls for Flow 189's
work landed in `workspace-e1b704272f124ba7` — whose own manifest says it belongs to a
**different, unrelated, already-completed Flow 153** ("wiki-graph-SAC proof").
SLATE-16's workspace binding is deliberately "sticky" for a slate's whole lifetime
(AC-25: "never re-resolved once bound"), so a session that already had a workspace
bound from earlier activity will file *every* later `/goal`'s proposals into that same
workspace regardless of topical relevance. This test accidentally resumed an older
session (`keryx shell -r` with no id resumes the last one) rather than starting fresh,
so the mismatch may be partly an artifact of that — worth a clean re-run (fresh
session, no prior workspace binding) before filing.

---

## Issues filed this pass

| # | Title | Theme |
|---|---|---|
| [#389](https://github.com/MrCipherSmith/keryx/issues/389) | T10 verifier pass is silent on success | `/goal --auto` observability |
| [#390](https://github.com/MrCipherSmith/keryx/issues/390) | bare `"keryx *"` wildcard passes shell-permission validation | approval-gate hardening |
| [#391](https://github.com/MrCipherSmith/keryx/issues/391) | mutating CLI subcommands bypass SAC review structurally | SAC design gap |
| [#392](https://github.com/MrCipherSmith/keryx/issues/392) | verifier verdict contradicts observable evidence | `/goal --auto` reliability |

## Not tested this pass (needs GUI, real terminal, or credentials this machine lacks)

- VS Code/Cursor extension one-command install (`bun run install:vscode`).
- TUI Tools/MCP inspector modal, `/search-provider`, `/search-connect` interactive
  pickers — mouse/arrow-key nav, not reproducible headless.
- Standalone binaries + Homebrew tap.
- Native OpenAI/Gemini adapters' actual success path (no key on this machine).
