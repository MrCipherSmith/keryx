# `keryx shell` / TUI — formalized live test-case catalog

Date: 2026-08-21/22 · Basis: `docs/docs/{harness.md,guides/*.md}` cross-referenced
against source (`src/commands/agent-commands.ts` — the single slash-command
registry; `src/harness/tool/{builtin,metaproject-operations.ts}` — the tool
registry; `src/commands/shell.ts` — the CLI flag parser).

**Purpose.** Every row is a *formalized, agent-runnable* test case: a real
`keryx shell` invocation, a concrete expected result, and how to check it —
not a description of intended behavior. This catalog is the input to a
follow-up execution + fix-planning pass; it does not itself claim any row
below has been run (rows already exercised during the prior live-testing pass
are marked accordingly and cite `keryx-0.2.55-live-testing-2026-08-21.md`).

**Execution methods, referenced by short name in every row:**

| Method | What it means | Limits |
|---|---|---|
| **readline** | `echo "<line1>\n<line2>..." \| keryx shell --no-tui --provider <p>`, optionally `DEEPSEEK_API_KEY=... env`. Each line = one turn/command in sequence. Real provider, real tools, real approval gate. | No mouse, no arrow-key nav, no modals — anything requiring those falls through to a "not available here" message (by design; see `agent-commands.ts` `/workspace`, `/review`, `/mcp`). Approval prompts default-deny on EOF unless `/mode trust`/`/mode auto` was sent as an earlier line. |
| **TUI** | Real OpenTUI inside a PTY (`script`/`expect`/manual). | Not exercised in the prior pass; needs a genuine terminal or a PTY-automation tool this environment does not currently have wired up. |
| **CLI** | A non-interactive `keryx <verb>` command, no shell session at all. | Useful to independently verify on-disk state a shell test produced. |
| **inspect** | Read a file/directory the shell test should have produced or changed. | Always paired with a `readline`/`TUI` row — never standalone evidence. |

**Session hygiene for execution:** unless a row says otherwise, start a
**fresh** session (no `-c`/`-r`) — a resumed session inherits prior Slate/
workspace binding and will confound the result (see the prior pass's own
"open observation" about workspace stickiness in a resumed session).

---

## Index

| Area | Test IDs | Count |
|---|---|---|
| [Session lifecycle](#1-session-lifecycle) | SESS-01…09 | 9 |
| [Slash commands (full registry sweep)](#2-slash-commands-full-registry-sweep) | SLASH-01…27 | 27 |
| [Permission modes](#3-permission-modes) | PERM-01…07 | 7 |
| [Approval gate & shell-permission remember](#4-approval-gate--shell-permission-remember) | APPR-01…06 | 6 |
| [Built-in agent tools](#5-built-in-agent-tools) | TOOL-01…14 | 14 |
| [`/goal` — one-shot and `--auto`](#6-goal--one-shot-and---auto) | GOAL-01…10 | 10 |
| [Slate (internal lifecycle)](#7-slate-internal-lifecycle) | SLATE-01…06 | 6 |
| [SAC: workspace / proposal / review](#8-sac-workspace--proposal--review) | SAC-01…09 | 9 |
| [Slate v3 — external MCP surface](#9-slate-v3--external-mcp-surface) | MCPSLATE-01…05 | 5 |
| [Provider / model switching](#10-provider--model-switching) | PROV-01…05 | 5 |
| [Background shell jobs](#11-background-shell-jobs) | BGJOB-01…04 | 4 |
| [Queue and interrupt](#12-queue-and-interrupt) | QUEUE-01…04 | 4 |
| [External delegation (`/delegate`)](#13-external-delegation-delegate) | DELEG-00…05 | 6 |
| [Compaction](#14-compaction) | COMP-01…03 | 3 |
| [Sessions CLI (cross-check surface)](#15-sessions-cli-cross-check-surface) | SESSCLI-01…04 | 4 |

**Total: 118 formalized test cases.**

---

## 1. Session lifecycle

| ID | Test | Command(s) | Expected | Verify |
|---|---|---|---|---|
| SESS-01 | Fresh session creates a new per-project store entry | `keryx shell --no-tui --provider deepseek` (single line, any prompt) | New session id printed; header shows `Session <id> · per-project` | `keryx sessions list` shows it, newest first |
| SESS-02 | `-c` continues the most recent session | Run SESS-01, then `keryx shell -c --no-tui --provider deepseek` (new line) | Header says `Resumed session <same id>` | Same session id as SESS-01; `context` count grew |
| SESS-03 | `-r <id>` resumes a specific session by short id | `keryx shell -r <short-id> --no-tui --provider deepseek` | Resumes the named session, not the latest | Compare against `keryx sessions list` |
| SESS-04 | `-r` with no id resumes the **last** session (undocumented-by-flag-shape gotcha, confirmed live) | `keryx shell -r --no-tui --provider deepseek` | Resumes last session silently — same as `-c` | *(Already confirmed live — prior pass session `1be94528`, accidental.)* |
| SESS-05 | `/new` starts a fresh session mid-shell, old kept on disk | readline: `hello` then `/new` then `hello again` | Two distinct session ids exist after one invocation | `keryx sessions list` shows both |
| SESS-06 | `/clear` is an alias of `/new` | readline: `hello` then `/clear` | Identical behavior to SESS-05 | Same |
| SESS-07 | `keryx sessions fork <id>` branches without touching the source | `keryx sessions fork <id>`, then diverge the fork | Fork has `parentSessionId` set; source session's `archive.jsonl` byte-identical before/after | `keryx sessions list` shows `↳`; diff source's `archive.jsonl` pre/post |
| SESS-08 | `keryx sessions export <id>` produces a readable Markdown transcript | `keryx sessions export <id>` | Well-formed Markdown, matches `transcript.jsonl` content | Manual diff against raw JSONL |
| SESS-09 | Interrupted turn stays resumable with partial answer | Start a long turn, kill the process mid-stream (`SIGTERM`), then `-c` | Last partial assistant text is present on resume, not lost | Inspect `context.jsonl` for a partial entry; resume shows it |

## 2. Slash commands (full registry sweep)

One row per entry in `AGENT_SLASH_COMMANDS` (`src/commands/agent-commands.ts`),
cross-checked against every actual `command === "/…"` dispatch branch traced
in `shell.ts`'s agent-mode REPL (offsets 49149–58219). The **confirmed**
agent-mode readline dispatch set is exactly: `/exit`/`/quit`, `/help`,
`/expand`, `/new`/`/clear`, `/compact`, `/mode`, `/search-provider`,
`/search-connect`, `/goal` — nine commands, full stop. Everything else in the
registry — including three (`/status`, `/flows`, `/theme`) that `/help`
itself advertises via `READLINE_AGENT_COMMANDS` — falls to the generic
`Unknown command: <cmd>. Type /help.` (`shell.ts:1482-1489`).
`describeUnavailableCommand` never fires for any of these: it only produces a
message for a command whose registry `modes` excludes the *current shell
mode* (chat-vs-agent), and every command below is `agent`-mode, same as
readline itself — the registry has no TUI-vs-readline dimension, so a
readline-only gap is structurally indistinguishable from a typo.

| ID | Command | readline dispatch? | Expected in readline | TUI-only real behavior to check separately |
|---|---|---|---|---|
| SLASH-01 | `/help` | confirmed real (`shell.ts:49440`) | `renderCommandHelp("agent", READLINE_AGENT_COMMANDS)` — the 13-name list, not all 26 | n/a |
| SLASH-02 | `/model` | **confirmed absent from the agent-mode chain** (only dispatched in the separate CHAT-mode block, `shell.ts:14259`) | `Unknown command: /model. Type /help.` | TUI: opens an interactive model picker |
| SLASH-03 | `/models` | n/a | `CHAT_ONLY` — not offered in agent mode at all, in either surface | chat-mode-only numbered menu |
| SLASH-04 | `/connect` | **confirmed absent from the agent-mode chain** (chat-mode-only handler, `shell.ts:15403`) | `Unknown command: /connect. Type /help.` | TUI: provider/API-key picker |
| SLASH-05 | `/search-provider` | confirmed real (`shell.ts:55167`) | Configure/test a web search provider — runs in readline | Same in TUI, richer picker |
| SLASH-06 | `/search-connect` | confirmed real (`shell.ts:56646`) | Select a connected search provider | Same |
| SLASH-07 | `/provider` | **confirmed absent from the agent-mode chain** (chat-mode-only handler, `shell.ts:14784`) — registered `BOTH` in the registry, but agent-mode readline never dispatches it | `Unknown command: /provider. Type /help.` | TUI: interactive picker |
| SLASH-08 | `/think` | **confirmed absent** — zero occurrences of the literal string anywhere in `shell.ts` | `Unknown command: /think. Type /help.` | Expands last reasoning block |
| SLASH-09 | `/expand` | confirmed real (`shell.ts:50682`) | Expands last tool output block | Same, click-driven in TUI |
| SLASH-10 | `/copy` | **confirmed absent** — zero occurrences anywhere in `shell.ts` | `Unknown command: /copy. Type /help.` | Copies newest block to clipboard |
| SLASH-11 | `/new` | confirmed real (grouped with `/clear`, `shell.ts:50989`) | New session | Same |
| SLASH-12 | `/goal` | confirmed real (`shell.ts:58219`) | Deterministic Slate open — see §6 for full coverage | Same engine |
| SLASH-13 | `/resume` | no dispatch branch exists | `Unknown command: /resume. Type /help.` (generic fallback, `shell.ts:1482-1489`) | TUI: session list picker |
| SLASH-14 | `/sessions` | no dispatch branch exists | Same generic fallback | TUI picker |
| SLASH-15 | `/status` | **CORRECTED after live re-test (see note below): works.** Dispatched via `isSessionInfoCommand(command)` — a helper-function check my original grep-based trace (literal `command === "/…"` only) missed entirely. | Real session identity/context/workspace/flow info | Same, richer rendering |
| SLASH-16 | `/flows` | **CORRECTED after live re-test: works.** Dispatched via `isFlowsCommand(command)` (`src/tui/flow-inspector.ts:35`) — same class of missed indirect dispatch as `/status`. | Real project flow list (verified live: 190 flows rendered) | Same |
| SLASH-17 | `/workspace` | no dispatch branch; also not `describeUnavailableCommand`-eligible (that only fires for a WRONG-MODE command, and `/workspace` is `agent`-mode same as readline itself) | `Unknown command: /workspace. Type /help.` — **not** a "TUI-only" explanation despite the registry comment saying this is deliberately TUI-only | Sidebar + 3-tab modal |
| SLASH-18 | `/review` | same as SLASH-17 | `Unknown command: /review. Type /help.` | Sidebar badge + list/detail modal, `[a]`/`[d]`-then-`[y]` |
| SLASH-19 | `/mcp` | same as SLASH-17 | `Unknown command: /mcp. Type /help.` | Tools/MCP inspector modal, `[c]`/`[d]`-then-`[y]` |
| SLASH-20 | `/compact` | **confirmed real dispatch branch exists** (`shell.ts:52047`) | Runs for real — see §14 | Same |
| SLASH-21 | `/theme` | **advertised by `/help` but the only `/theme` dispatch branch found is in the CHAT-mode block (`shell.ts:12517`), not the agent-mode block** — same confirmed gap as `/status`/`/flows` | `Unknown command: /theme. Type /help.` in agent-mode readline | TUI: visual theme picker |
| SLASH-22 | `/mode` | confirmed real dispatch branch (`shell.ts:52913`) | See §3 — fully exercised live already | Same engine, TUI picker when called with no args |
| SLASH-23 | `/clear` | confirmed real dispatch branch (grouped with `/new`, `shell.ts:50989`) | Alias of `/new` | Same |
| SLASH-24 | `/interrupt` | no dispatch branch exists; also needs a genuinely in-flight turn, hard via piped stdin regardless | `Unknown command: /interrupt. Type /help.` | TUI: raw keyboard interrupt of a live turn |
| SLASH-25 | `/queue` | no dispatch branch exists | `Unknown command: /queue. Type /help.` | Same |
| SLASH-26 | `/delegate` | no dispatch branch exists (confirmed: zero occurrences of the literal string `/delegate` anywhere in `shell.ts`) | `Unknown command: /delegate. Type /help.` — §13's DELEG-01/02/03 rows below are **TUI-only in practice**, not readline-testable as written; revise those rows before running them | Sidebar `⤳` marker, 3-tab modal (Work/Meta/Command) |
| SLASH-27 | `/exit` (and `/quit` alias) | confirmed real dispatch branch, both spellings (`shell.ts:49149`) | Leaves the shell | `/quit` maps to `/exit` via `commandToken` |

**CORRECTION (2026-08-22, after live re-testing found the original claim
wrong for 2 of 3 commands — see GitHub issue #393's own correction
comment):** the original static trace here (grepping `shell.ts` for literal
`command === "/…"` comparisons, offsets 49149–58219) is an **incomplete
methodology** — it misses dispatch performed through a helper predicate
function rather than a literal string comparison. Live-tested against the
real `keryx 0.2.55` binary:

- **`/status` works** — dispatched via `isSessionInfoCommand(command)`.
- **`/flows` works** — dispatched via `isFlowsCommand(command)`
  (`src/tui/flow-inspector.ts:35`, imported into `shell.ts`), confirmed live:
  a real `/flows` call rendered all 190 project flows correctly.
- **`/theme` is genuinely broken** — confirmed live:
  `Unknown command: /theme. Type /help.` `/help` still advertises it
  (`READLINE_AGENT_COMMANDS`, `shell.ts:143-157`); its only actual
  `command === "/theme"` handler lives in the separate CHAT-mode dispatch
  block, never reached from agent-mode readline. **This is the one real bug
  in this family** — issue #393 has been corrected and re-titled to cover
  only `/theme`.

Lesson for any future audit of this dispatch chain: check for indirect
dispatch (`isFlowsCommand`, `isSessionInfoCommand`, and any sibling of that
shape) in addition to literal `command === "/…"` comparisons — a
grep-only trace will produce false positives exactly like this one did.

Separately (unaffected by the above correction — these genuinely have no
dispatch of any kind, literal or indirect): `/resume`, `/sessions`,
`/workspace`, `/review`, `/mcp`, `/interrupt`, `/queue`, and `/delegate` fall
through to the generic `Unknown command: <cmd>. Type /help.` rather than a
more informative TUI-only explanation, because `describeUnavailableCommand`
only encodes a chat-vs-agent `modes` dimension, never a TUI-vs-readline one.

## 3. Permission modes

*(Rows 01, 03, 05 already exercised live — see prior report §"Parallel
`spawn_subagent`".)*

| ID | Test | Command(s) | Expected | Verify |
|---|---|---|---|---|
| PERM-01 | Default mode is `ask` | Fresh session, `/mode` with no args | `Permission mode: ask (no project default set)` | Output text |
| PERM-02 | `--trust` CLI flag sets it for the session | `keryx shell --trust --no-tui ...` | Same as sending `/mode trust` as line 1 | `/mode` on the next line reports `trust` |
| PERM-03 | `/mode trust` mid-session, spawn_subagent auto-approved | *(done — prior pass session `1be94528`)* | `◇ auto-approved (trust) spawn_subagent`, non-dimmed | transcript line present |
| PERM-04 | `/mode auto` requires explicit `yes` confirmation | readline: `/mode auto` then **not** `yes` (e.g. `no`) | `Cancelled — mode unchanged.` — mode stays `ask` | next `/mode` shows unchanged |
| PERM-05 | `/mode auto` + `yes` — destructive commands also auto-approve | readline: `/mode auto`, `yes`, then a prompt that would trigger a destructive `shell_exec` | `◇ auto-approved (auto) [destructive] ...` | transcript line, `[destructive]` tag present |
| PERM-06 | `/mode <mode> save` persists a per-project default | readline: `/mode trust save` | `permission-mode.json` gets an entry for this project's resolved path | inspect `~/.local/share/keryx/permission-mode.json` |
| PERM-07 | `/mode clear` removes the stored default without changing the live session | readline: `/mode trust save` then `/mode clear` | File entry removed; `/mode` still reports `trust` for *this* session | inspect file + `/mode` output |

## 4. Approval gate & shell-permission remember

*(Rows 02, 04 already exercised live — see prior pass §5 and issues #390/#391.)*

| ID | Test | Command(s) | Expected | Verify |
|---|---|---|---|---|
| APPR-01 | `ask` mode: an ordinary `shell_exec` prompts, denies on EOF (headless) | readline, single line, a prompt that triggers `shell_exec`, no `/mode` line first | `[y/N/A=always]` prompt printed, `denied` (EOF), tool result `not approved` | transcript |
| APPR-02 | `[A=always]` remembers the **exact** command string only | *(confirmed live via code read — `rememberExactShellGrant`)* — construct: readline two lines, first with an interactive TTY answering `A` to command X, second line asking for command X again with a **different** trailing argument | Second, different command still prompts — no generalization | transcript |
| APPR-03 | A stored bare wildcard (`"<word> *"`) for a non-harness command IS refused by `validateShellPattern` | Hand-edit a scratch `permissions.json` (test config dir, not the real one) with `"rm *"`, load a session against it | `rejected` list surfaces it with a reason at first auto-approve attempt | `⚠ N saved shell permission(s) are no longer honoured` line |
| APPR-04 | The real, already-present `"keryx *"` grant auto-approves *every* `keryx` subcommand, including mutating ones | *(confirmed live — issue #390)* | n/a — already evidenced | `~/.local/share/keryx/permissions.json` |
| APPR-05 | `apply_patch` (risk `write`) is always approval-gated regardless of any shell-permission grant | *(confirmed live — prior pass §5, denied twice)* | n/a — already evidenced | transcript |
| APPR-06 | Credential/permission-file-touching commands are **never** auto-approved, even under `/mode auto` | readline: `/mode auto`, `yes`, then a prompt whose `shell_exec` command contains `auth.json` or `.local/share/keryx` | Still prompts, no `◇ auto-approved` line, even in `auto` | transcript |

## 5. Built-in agent tools

One smoke-test row per tool in the registry (§ "Index" tools grouped by
theme; each row is "does the model calling this tool, for real, in a real
turn, produce the documented shape").

| ID | Tool(s) | Test | Expected |
|---|---|---|---|
| TOOL-01 | `get_cwd`, `list_dir`, `read_file` | Ask a question that requires reading a real file | Real file content returned, redacted if secret-shaped |
| TOOL-02 | `search_code` | Ask to find a symbol | Real ripgrep-backed hits, or a clear "ripgrep not on PATH" degrade |
| TOOL-03 | `graph_affected`, `graph_query`, `graph_path`, `graph_symbol` | Ask a blast-radius / structural question | Real graph data, matching `keryx gdgraph affected <file>` CLI output |
| TOOL-04 | `memory_search` | Ask about a known past decision | Real accepted-memory hits |
| TOOL-05 | `read_wiki`, `wiki_ask`, `wiki_backlinks` | Ask a wiki-answerable question | Real wiki content / lexical-search answer |
| TOOL-06 | `health_status` | Ask about code quality state | Matches `keryx health status` CLI |
| TOOL-07 | `test_related` | Ask which tests cover a file | Matches `keryx test` analysis |
| TOOL-08 | `flow_status` | Ask about current work state | Matches `keryx flow status <id>` CLI |
| TOOL-09 | `repomap` | Ask for a repo overview | Matches `keryx gdgraph query`-style repomap artifact |
| TOOL-10 | `skills_catalog`, `skill_load` | Ask what skills are available | *(confirmed live via MCP — §2 of prior report; not yet confirmed via the shell's OWN agent loop specifically, only via a standalone MCP client)* |
| TOOL-11 | `shell_exec` (+ `shell_job_output`/`shell_job_kill`) | A long-running background command | `background: true` input returns a `job_id` immediately; `shell_job_output` polls incrementally; `shell_job_kill` stops it — TUI sidebar "Background Jobs N" panel (TUI-only visual, see §11) |
| TOOL-12 | `apply_patch` | A real, approved (via `/mode trust`) file edit | File on disk actually changes; classifier (`classifyPatchRisk`) escalates correctly for a destructive-looking target |
| TOOL-13 | `spawn_subagent` | Single + parallel-batch dispatch | *(confirmed live both ways — denied under `ask`/headless, real parallel execution under `trust`)* |
| TOOL-14 | `web_fetch`, `web_search` | A real external question (needs `/search-provider`/`/search-connect` configured first) | Real result, or a clear "no provider configured" refusal |

## 6. `/goal` — one-shot and `--auto`

*(Rows 02–08 already exercised live — see prior report §4. Listed here for
completeness of the catalog and to name the ones still open.)*

| ID | Test | Expected / status |
|---|---|---|
| GOAL-01 | `--auto`/`--workspace` recognized **only when trailing** | Confirmed live (a leading `--auto 1` silently no-ops) |
| GOAL-02 | One-shot `/goal <text>` opens Slate + injects Anchors, runs exactly one turn | Confirmed live |
| GOAL-03 | `--auto [N]` auto-provisions a Flow when none bound | Confirmed live (Flow 188, Flow 189) |
| GOAL-04 | Round loop continues while Flow isn't done and rounds remain | Confirmed live (`round 2/2`, `round 2/3`, `round 3/3`) |
| GOAL-05 | Verifier runs before final stop | Confirmed live — but see #389 (silent on success) / #392 (verdict can contradict evidence) |
| GOAL-06 | A disagreeing verifier grants exactly one extra round, never a re-verify loop | **Not yet directly confirmed** — GOAL-05's live run hit round budget exhaustion (`roundsLeft == 0`) at the same moment the verifier disagreed, so the "one more round" branch (`goal-command.ts:626`) never actually fired. Needs a run with `roundsLeft > 0` remaining when the verifier says `achieved: false`. |
| GOAL-07 | An explicit non-integer after `--auto` falls through as ordinary text, not a parse error | **Not yet tested** — e.g. `/goal explain how --auto mode differs` |
| GOAL-08 | Armed `--auto` budget does not survive fork/resume | **Not yet tested** — arm `--auto N` mid-turn is impossible to catch mid-flight via readline, but: run `/goal ... --auto 3`, then immediately `keryx sessions fork <id>` on the SAME session before the loop finishes, and confirm the fork's `SlateSessionRef` has no `autoGoalRounds` |
| GOAL-09 | `/goal --workspace <id>` fail-closed validation | **Not yet tested** — pass a bogus/rejected `--workspace` id, confirm no Slate opens and no turn runs |
| GOAL-10 | `keryx harness run --goal ...` (non-interactive CLI form) | **Not yet tested** — the doc mentions this exists (`harness run --goal ... [--workspace <id>]`) but it was never exercised; confirm it behaves like the one-shot shell form |

## 7. Slate (internal lifecycle)

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| SLATE-01 | Action-intent heuristic opens a Slate without `/goal` | *(confirmed live — every prior test)* | n/a |
| SLATE-02 | Slate closes automatically when course is done | *(confirmed live — archived `slate-archive/*.json` after several sessions)* | n/a |
| SLATE-03 | `touched` accumulates append-only, no duplicates across calls | *(confirmed live — indirectly, via the fix's own regression test)* | Compare `touched` array length vs. distinct paths read |
| SLATE-04 | `slate_read` tool returns the live slate to the model mid-turn | *(confirmed live — `⚙ slate_read()` call in prior pass)* | n/a |
| SLATE-05 | `slate_write_seed` tool appends a Seed the model chooses to record | *(confirmed live — multiple times)* | n/a |
| SLATE-06 | A Slate untouched past the stale-lock window auto-closes on next touch, no background timer | **Not yet tested** — needs a deliberately stale `slate.json` (backdated `lastWriteAt`) and a subsequent real call |

## 8. SAC: workspace / proposal / review

*(Rows 01, 05, 06, 07 already exercised live — see prior report §5, issues
#390/#391.)*

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| SAC-01 | `workspace_propose` from a wrap-up-driven Seed produces a real, catch-up-visible proposal | Confirmed live (Flow 188's proposal, still pending review right now) | n/a |
| SAC-02 | `keryx workspace review <ws> <proposal> --decision accepted` requires `--confirm-token` | **Not yet tested end-to-end** — mint one via `keryx workspace confirm-review <ws> <proposal>` (a real, approval-gated shell command run by a human) and complete a real accept | Owner writer lands the content; proposal status flips |
| SAC-03 | `--decision accepted` without a confirm-token is refused | **Not yet tested** | Typed refusal, no state change |
| SAC-04 | `DedupHint` fires on an accept that duplicates existing accepted content | **Not yet tested** | Non-empty hint in the response, informational only (doesn't block) |
| SAC-05 | Direct wiki mutation (`keryx wiki new`/`wiki enrich`) bypasses SAC review entirely | Confirmed live (issue #391) | n/a |
| SAC-06 | `keryx workspace catch-up` correctly buckets pending / blocked / unbound / unknown / lifecycle-flags | Confirmed live — real pending proposal shown, real "Unknown" session shown | n/a |
| SAC-07 | `keryx workspace catch-up --include-lifecycle-flags` (shown by default) flags an orphaned memory/wiki/workspace scope | Confirmed live (one real flag surfaced: `lessons/allowlist-not-a-boundary.md`) | n/a |
| SAC-08 | Workspace binding "re-evaluates mid-session if the topic shifts" — **doc claim vs. code claim mismatch, HIGH PRIORITY** | **Not yet cleanly tested.** `shared-agent-context.md` states binding "re-evaluates that binding mid-session if the topic shifts"; `goal-command.ts`'s own comment says a `/goal` "reusing an already-bound slate mid-session is never re-resolved" (AC-25). A prior live run's proposals landing in an unrelated, already-closed workspace is consistent with the code's claim, not the doc's — but that run resumed an old session by accident, confounding the result. **Test**: fresh session, `/goal <topic A>` (binds workspace X), then in the SAME session `/goal <clearly unrelated topic B> --auto 1`, and check which workspace topic B's proposal lands in. | Either resolves the discrepancy or confirms a real doc bug worth its own issue. |
| SAC-09 | `keryx workspace add-resource` / `remove-resource` / `rename` / `archive` | **Not yet tested** | Manifest reflects each op; archived workspace excluded from default `list` |

## 9. Slate v3 — external MCP surface

*(Rows 01–03 already exercised live — see prior report §2, real MCP SDK
client against a freshly-spawned `keryx mcp serve`.)*

| ID | Test | Expected |
|---|---|---|
| MCPSLATE-01 | `slate.open` → `slate.writeSeed` → `slate.close` full lifecycle | Confirmed live |
| MCPSLATE-02 | A second `slate.open` for the same `externalSessionId` is a no-op | **Not yet tested** — open twice, confirm identical returned slate, no second file |
| MCPSLATE-03 | An invalid `kind` on `slate.writeSeed` throws | **Not yet tested** — `{"kind": "not-a-real-kind"}` |
| MCPSLATE-04 | `text` capped at 4,000 chars; a slate holds at most 200 Seeds | **Not yet tested** |
| MCPSLATE-05 | A slate with no bound workspace surfaces at `catch-up` as `unbound-candidate` on close | **Not yet tested** |

## 10. Provider / model switching

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| PROV-01 | `--provider <p>` CLI flag selects a real provider | *(confirmed live repeatedly with `deepseek`)* | n/a |
| PROV-02 | `/provider <name>` mid-session (readline) — see SLASH-07's open question | **Not yet tested** | Switches active provider for later turns |
| PROV-03 | `/models` (chat-mode-only) numbered menu | **Not yet tested**, needs `--chat` | Numbered list; selecting one switches |
| PROV-04 | Missing API key for a chosen provider fails closed with a named message | *(confirmed live for `openai`/`gemini` via `harness run`; not yet confirmed via `keryx shell` itself choosing an unconfigured provider)* | No network attempt, clear message |
| PROV-05 | `keryx shell --model <m>` overrides the provider's default model | **Not yet tested** | Header shows the requested model, not the provider default |

## 11. Background shell jobs

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| BGJOB-01 | `shell_exec` with `background: true` returns immediately with a `job_id` | **Not yet tested** | Turn continues without blocking on the command's exit |
| BGJOB-02 | `shell_job_output(job_id)` returns only new output since the last poll | **Not yet tested** | Cursor-based incremental read, no duplication |
| BGJOB-03 | `shell_job_kill(job_id)` stops a running background job | **Not yet tested** | Process actually terminates; subsequent `shell_job_output` reflects it |
| BGJOB-04 | TUI sidebar "Background Jobs N" panel + live Output/Meta modal | **TUI-only**, not testable via readline | Visual — needs real PTY |

## 12. Queue and interrupt

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| QUEUE-01 | A message sent while the main turn is busy queues instead of interleaving | **Not yet tested**, and hard via piped readline (no real concurrency window) — most realistically a TUI test | Queued indicator; delivered after current turn ends |
| QUEUE-02 | `/queue remove [N]` removes a queued item | **Not yet tested** | Queue shrinks by one at position N (default 1) |
| QUEUE-03 | `/queue edit [N]` edits a queued item before delivery | **Not yet tested** | Content changes, position unchanged |
| QUEUE-04 | `/queue force [N]` — same semantics as external-agent `force` (kill-plus-resume, not a plain abort) per `harness.md` | **Not yet tested** | Current turn terminated, queued item runs next |

## 13. External delegation (`/delegate`)

*(Capability is off by default — flow 176 — so most rows expect a **named
refusal**, not silent unavailability, unless `externalAgents.enabled: true`
is set in `~/.local/share/keryx/auth.json` and the project opted in via
`keryx init --external-agents`.)*

**Correction from the SLASH-26 trace: `/delegate` has zero dispatch
occurrences in `shell.ts` — it is TUI-only in practice, not readline-callable
at all.** DELEG-01/02/03 below as originally conceived (readline) will only
ever show `Unknown command: /delegate. Type /help.`, never reach
`parseDelegateCommand`. That IS a valid, if low-value, test case on its own
(DELEG-00). To actually exercise `parseDelegateCommand`'s refusal text and
the capability gate, either drive it through the TUI, or call the parser
directly in a unit-style check (`bun test` already covers this — see
`src/commands/agent-commands.ts`'s own exports) rather than via a live shell.

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| DELEG-00 | `/delegate` typed in readline does nothing delegate-specific | readline: `/delegate claude-cli "say hi"` | `Unknown command: /delegate. Type /help.` — confirms the TUI-only gap above |
| DELEG-01 | `/delegate` with no capability enabled | **TUI required** — readline cannot reach this | Named refusal citing the capability gate, not a generic error |
| DELEG-02 | `/delegate` with an unknown agent id | **TUI required** | `parseDelegateCommand`'s exact refusal text, names `codex-cli, claude-cli` |
| DELEG-03 | `/delegate` with an agent but no task (or vice versa) | **TUI required** | `needs both an agent and a task` refusal |
| DELEG-04 | `keryx agents external list [--json] [--no-probe]` — read-only, spends no quota | **Not yet tested** | Reports installed/not-installed/not-probed per agent, only ever runs `--version` |
| DELEG-05 | A real, capability-enabled dispatch (if this machine has `claude`/`codex` CLI installed and logged in) | **Not yet tested — explicitly flagged in `harness.md` as never run against a real vendor process, project-wide** | Disposable worktree, stripped env, restricted tool roster — see `harness.md`'s own detailed contract |

## 14. Compaction

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| COMP-01 | `/compact` shortens the model window, archive stays intact | **Not yet tested** | `context.jsonl` shrinks; `archive.jsonl` unchanged; entry count preserved in archive |
| COMP-02 | `/compact [focus]` — a focus argument | **Not yet tested** | Compaction biased toward the named focus (exact semantics TBD by reading `src/session/compact.ts`) |
| COMP-03 | Compacting away an entry that's evidence for something raises `EvidenceDeletionError` instead of silently dropping it | **Not yet tested** | Compaction refuses / degrades rather than losing evidence |

## 15. Sessions CLI (cross-check surface)

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| SESSCLI-01 | `keryx sessions path` | **Not yet tested** (used manually throughout the prior pass, never as a formal assertion) | Prints the real on-disk store root |
| SESSCLI-02 | `keryx sessions list --json` (if supported) or plain | *(used live, informally)* | Matches what `/sessions`/`/resume` would show in TUI |
| SESSCLI-03 | A session store read failure states the file + reason, not a stack trace | **Not yet tested** — `config-dir.readers.test.ts` implies this exists as tested behavior; worth a real CLI-level confirmation | Clean error message |
| SESSCLI-04 | An oversized/corrupted session file is refused cleanly, not crashed on | **Not yet tested** | Named refusal |

---

## How to execute this catalog

1. Prefer **readline** method for anything not marked TUI-only — it exercises
   the identical backend engine (confirmed by source cross-reference in the
   prior pass) at a fraction of the setup cost.
2. Use a **fresh session** per test case unless the case is explicitly about
   session continuity (§1) — resumed-session state bleed already produced one
   confounded result (SAC-08's origin).
3. For anything gated by approval (`shell_exec`, `apply_patch`,
   `spawn_subagent`), decide **deliberately** whether the case is testing the
   `ask`-mode denial path (headless, no `/mode` line) or the real execution
   path (`/mode trust`/`auto` as the first piped line) — both are valid test
   cases for different rows above; conflating them silently (as happened
   once in the prior pass) wastes a run.
4. Record, per case: the exact command(s) run, the session id, and either a
   quoted transcript excerpt or an on-disk artifact path as evidence — the
   same evidentiary standard `keryx-0.2.55-live-testing-2026-08-21.md`
   already established.
5. File a GitHub issue for any case whose real result contradicts its
   "Expected" column, the same way #389–#392 were filed from the prior pass.
