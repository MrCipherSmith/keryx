# keryx shell — why it loses in the arena

A running log. Every entry is something observed in an arena transcript or result
row, with the evidence that shows it, and what a fix would have to change. It is
written to be worked from: each defect is a candidate change to `keryx shell`, and
the arena is how the change is checked.

Status per entry: `observed` (seen once) → `confirmed` (seen across tasks or reruns)
→ `fixed in <commit>` → `verified` (the arena rerun that shows the gap closed).

Evidence lives in `/tmp/arena*/results.jsonl` and, from the diagnostic rerun on,
`/tmp/arena*/transcripts/<task>-<harness>-<arm>.jsonl`. Transcripts before that
rerun were not kept — see K-000.

---

## Baseline: the smoke, 2026-09-10, task `t1-53254e0e`

Task: `fix(data-catalog): treat the system pseudo-case as global in the schema
editor (#6435)`. Gold, four files: `src/context/case-context.ts`,
`src/data-catalog/dc-service.ts`, `src/data-catalog/dc-service.msw.ts`,
`src/data-catalog/schema-editor/dc-schema-editor-store.ts`.

| leg | arm | recall | precision | context tokens | tool calls | first gold at | wall |
|---|---|---|---|---|---|---|---|
| grok-build | on | 1.00 | 0.67 | 307,607 | 24 | 1 | 90s |
| grok-build | off | 1.00 | 0.67 | 1,495,992 | 83 | — | 366s |
| keryx-shell | on | 0.25 | 0.50 | 976,908 | 76 | 6 | 484s |
| keryx-shell | off | 0.25 | 0.50 | 994,121 | 62 | 9 | 420s |
| claude-sonnet | on | 0.25 | 0.33 | 726,281 | 16 | 8 | 109s |
| claude-sonnet | off | 0.25 | 1.00 | 515,463 | 12 | 5 | 91s |

grok-build and keryx-shell drive the same model, grok-4.6. The difference between
those two rows is the shell and nothing else.

> **CORRECTION, 2026-09-11 — the grok-build rows are contaminated (K-011).** In the
> kept transcripts of `/tmp/arena-diag3` the grok CLI read `.git/FETCH_HEAD` in its
> own checkout, learned the absolute path of the SOURCE clone, and ran `git -C
> ~/sandbox/arena/clear/vantage-frontend show 53254e0e3` — the answer commit — in
> both arms. Its 4/4 is an answer it took from outside its tree. The smoke's grok
> 1.0 recall very likely came the same way (no transcripts were kept then). keryx
> tried the same kind of search (`git show-ref`, `ls` of the arms directory) and did
> not find the path. **Nothing in this table compares the two shells.** The keryx
> defects below stand on keryx's own transcript and are real regardless; K-001 is
> withdrawn.

---

## K-000 — the arena kept no transcripts · fixed in this branch

**Observed:** the smoke produced the most interesting number of the measurement —
keryx-shell finding one of four files in both arms — and nothing could say why. The
keryx events file lived in a temp directory removed in a `finally`; the grok and
claude adapters read stdout into memory and discarded it; the arm's tree is deleted
after every arm.

**Fix:** `writeTranscript` (`scripts/benchmark/retrieval-transcript.ts`), called by
all three adapters before the answer is interpreted, so a refused arm keeps its
evidence too. `runArenaArm` names the file; `run-arena` puts them under
`<out>/transcripts/`. stderr is now drained and kept beside the stream.

---

## K-001 — same model, a quarter of the recall · WITHDRAWN (the comparison leaked, K-011)

**Evidence:** smoke rows above. keryx-shell and grok-build, both grok-4.6, both arms:
grok found 4/4 in both arms, keryx found 1/4 in both. keryx's two answers are
identical — same match (`dc-schema-editor-store.ts`), same wrong extra
(`CreateDcSchemaFromTable.integration.test.tsx`), same three misses.

**What it rules out:** the model (held constant) and the project context (keryx lost
with and without it, grok won with and without it). What is left is the shell: its
system prompt, its tool set and tool descriptions, how tool output is clipped before
the model sees it, and when the loop decides the turn is over.

**What it does not yet say:** which of those. Diagnosis below, from transcripts.

## K-002 — the project context does not reach keryx's own behaviour · observed

**Evidence:** keryx-shell context-on vs context-off: 976,908 vs 994,121 tokens (ratio
0.98), 76 vs 62 tool calls, the same final answer. The context arm found its first
gold file at step 6 instead of 9 and still stopped at one. grok-build given the same
`.metaproject/` fell from 1.50M to 308k tokens and from 83 to 24 tool calls.

**Why it matters more than K-001:** keryx is the product that ships the context
layer. On this task the context helps a third-party CLI five-fold and keryx's own
shell not at all.

**Open question for the transcript:** did the context arm read
`.metaproject/index.md`, and did it call `keryx gdgraph` / `keryx ctx rg` / the wiki,
or did it search the way the control arm did?

## K-003 — more work, no better answer · observed

**Evidence:** keryx-shell used 62–76 tool calls and 420–484s where grok-build's
context arm used 24 calls and 90s for a better answer. Tool calls without recall
means the loop is searching without converging — the transcript should show whether
it repeats searches, reads large files whole, or loses gold paths it already held.

## K-004 — the shell's tools call a different keryx than the shell · observed

**Evidence:** `makeKeryxRunner` (`src/harness/tool/builtin/metaproject-tools.ts:77`)
spawns `keryx` from PATH. Inside an arena arm that resolves to the globally installed
release, `…/node/v25.9.0/lib/node_modules/@mrciphersmith/keryx/dist/cli.js`,
version **0.2.84** — while the shell itself is `bun src/cli.ts` from this checkout.
So a keryx-shell arm runs two keryx builds at once: the loop from this branch, and
every subprocess-backed tool from a release four versions behind it. The arena's
provisioner (`keryx init`, `gdgraph build`, `wiki collect/index`) uses the same PATH
binary, for every leg.

`search_code` is NOT affected: it has an in-process ripgrep backing
(`src/harness/tool/metaproject-adapter.ts:540`) and only falls back to the runner on
a port error. So "the control arm has no search" is ruled out.

**Fix direction:** the runner should spawn the running keryx (`process.execPath` +
the entry script, or an injected self-command), never whatever `keryx` PATH yields.
For the arena, the provisioner should use `KERYX_DEV_COMMAND` too, so graph and
wiki are built by the version under test.

## Code-level suspects, to confirm or drop against the transcript

These are read from the source, not observed in a run. Each needs a transcript line
before it becomes a defect.

- **S-1 · read_file sees only the head of a file.** Capped at `MAX_READ_BYTES` from
  byte 0, no offset or range (`interactive-tools.ts:115-156`); the tool description
  says so. A gold file whose relevant code sits past the cap cannot be confirmed by
  reading it, however many times the model tries.
- **S-2 · every metaproject tool output is cut at 20,000 bytes**
  (`metaproject-tools.ts:38`). A graph or search result listing more paths than fit
  loses the tail — and a gold path in the tail is a gold path the model never saw.
- **S-3 · the system prompt is about the product, not the task.**
  `buildAgentSystemInstruction` (`src/commands/agent.ts:676`) spends most of its
  length on Slate seeds, Shared Agent Context workspaces, web tools, approval pools
  and product workflows. For "which files did this change touch" almost none of it
  applies, and it tells the model nothing about how to search a codebase to
  completeness. grok-build's own prompt is what keryx is being compared against.
- **S-4 · 40 model rounds per turn** (`DEFAULT_MAX_ROUNDS`, `agent.ts:357`). The
  arms made 62–76 tool calls; if the budget ran out, the final answer is whatever the
  model held at that point. The transcript's round count and turn-end reason decide
  whether this is live.

---

## Diagnostic rerun, 2026-09-10 23:50 — `/tmp/arena-diag`

Same task, keryx-shell and grok-build, transcripts kept. Traced with a script that
prints each tool call, its result size, clipping, and when each gold path first
appeared in a result.

### keryx-shell context-off — FAILED at 43 tool calls

Transcript: `/tmp/arena-diag/transcripts/t1-53254e0e-keryx-shell-context-off.jsonl`.
15 provider rounds, 43 tool calls: `search_code` 23, `shell_exec` 7, `list_dir` 7,
`read_file` 4, `get_cwd` 1, `graph_find` 1. Gold first seen in a tool result:
`dc-service.ts` and `dc-schema-editor-store.ts` at step 15, `case-context.ts` at step
26. `dc-service.msw.ts` never. Turn ended on a provider error, with the model's last
sentence as its "answer".

## BLOCKED — the x.ai balance is exhausted, 2026-09-11 ~00:00

Both grok-4.6 legs stop here until the balance is topped up. The diagnostic rerun's
failures are the account, not the shell:

- `grok-build` context-on, same minute, stderr: `API error (status 402 Payment
  Required): Grok Build usage balance exhausted`, 0 turns, 0 tokens.
- `keryx-shell` context-on: `turn_end.errorMessage = "[error] Ollama API returned
  HTTP 403"`, 0 tool calls, 0 usage events — on its first request.
- A one-line `keryx shell --print "reply with the single word ok"` under the REAL
  home, outside the arena: the same 403. `keryx auth status grok` reports the grant
  `active`, expiring 2026-09-11T00:54Z, refreshable — so it is not an expired token.
- keryx-shell context-off's mid-turn death at round 16 is the balance running out
  under it.

The smoke (23:09–23:37) and this run's first 15 rounds spent it. The claude leg is a
different account and is unaffected.

Retried 2026-09-11 10:34 (`/tmp/arena-diag2`): all four arms failed the same way —
grok CLI 402 with the balance message, keryx 403 with no reason.

**CORRECTION — keryx's 403 was never the balance (K-010).** After the balance
returned, the grok CLI recorded arms and keryx still failed with a bare 403. A probe
through a build with the K-005 fix printed the reason the old code dropped: `xAI
(Grok) API returned HTTP 403: The OAuth2 access token could not be validated.` —
while `keryx auth status grok` said `active`. `keryx auth login grok` fixed it. The
two CLIs were failing for two different reasons that looked like one.

## K-005 — a provider refusal kills the turn, and is reported as Ollama · confirmed

**Evidence:** `turn_end.errorMessage = "[error] Ollama API returned HTTP 403"` on a
session whose provider is `grok` and model `grok-4.6`. Round 16 of the turn. The
smoke's same arm, same task, completed 62 calls without it.

**Two defects in one line.** The error names the wrong provider — whoever reads the
transcript goes looking at an Ollama endpoint that was never involved. And a single
403 mid-turn ends the whole turn with no retry and no partial answer: 43 tool calls
of work, three gold files already in view, and the recorded answer is a sentence of
narration. Whether the 403 is rate limiting, an expired grant or content policy, the
shell does not say.

**Where:** the message is `${this.label} API returned HTTP ${status}`
(`src/harness/provider/compat/openai-compat-provider.ts:415`), and the label comes
from `OLLAMA_COMPAT_IDENTITY` (`src/harness/provider/make-provider.ts:33-39`) —
`providerLabel: "Ollama"`, `providerId: "ollama"`, `providerRevision:
"ollama-2024-10-22"` — the identity the OpenAI-compatible engine carries for every
compat provider, grok included. The body is only surfaced when it is JSON with
`error.message`; anything else is dropped (`:416-424`), which is why this 403 has no
reason attached. The error goes straight to `provider_error` and the turn ends
(`:425-427`).

**Fix direction:** give each compat provider its own identity, so errors (and
anything keyed on `providerId` / `providerRevision`) name grok as grok; keep a
non-JSON error body, truncated, instead of dropping it; distinguish 403 from 429; on
a mid-turn provider failure, keep the turn's findings rather than discarding them.

## K-006 — the loop hunts for the commit instead of answering from the code · observed

**Evidence:** the first four calls are `git log --grep='#6435'`, `--grep='pseudo-case'`,
`git branch -a`, `git show-ref`, `git stash list`. It returns to it at step 39
(`git log -p -S isGlobalContext`), step 40 (`search_code "6435"`, which matches an SVG
asset), and step 43 (`find . -name '*.patch'`). Its narration twice says "the #6435
commit isn't in this clone's history — I'll look for a patch, PR metadata, or other
traces". 7 of 43 calls, and the reason the turn was still running at round 16.

The commit is unreachable by construction — the arena checks that before the arm
starts. The task is answerable from the code: 3 of 4 gold files were in view by
step 26. The loop treats "find the source of truth" as the goal and the code as a
fallback.

**Open:** whether grok-build does the same on the same model. If it does not, the
shell's prompt is pushing it there — S-3's "keep working until the task is fully
done" plus "prefer ONE correct shell_exec" are candidates.

## K-007 — gold in view is not gold in the answer · observed, confirmed across runs

**Evidence:** this run held `case-context.ts` (step 26, `get isGlobal`), `dc-service.ts`
(step 15) and `dc-schema-editor-store.ts` (step 15) in tool output. The smoke's run of
the same arm answered with one of them. Holding a path and naming it are different
steps, and the loop does not get from the first to the second.

**Fix direction:** this is the step a research-shaped task lives or dies on. A shell
that has no "stop and commit to an answer from what you have" discipline keeps
searching until something external ends the turn.

## K-008 — search output is padded with noise, then clipped · observed

**Evidence:** every `search_code` line carries the absolute path
`/private/tmp/arena-diag/arms/t1-53254e0e-keryx-shell-context-off/…` — ~65 bytes of
prefix per match line, repeated on every line. Step 16's search hit the 20,000-byte cap
(`CLIPPED`) with gold in it. Steps 6 and 40 searched `6435` and got 8 KB of matches
inside `synergy-docs/static/img/brand/synergy-mark.svg`.

**Fix direction:** repository-relative paths in `search_code` output; skip binary and
asset types by default; when a result is clipped, say how many matches were dropped.

## K-009 — the roster ignores the project it is in · observed

**Evidence:** the control arm (no `.metaproject/`) was offered 36 tools, including
`graph_*` ×5, `wiki_*` ×5, `read_wiki`, `memory_search`, six `workspace_*`,
`slate_*`, `skill_*`, `health_status`, `flow_status`, `test_related`, `apply_patch`
and `spawn_subagent`. It called `graph_find` at step 14 and got
`index-incomplete … never built here`. Every one of those tools is a description in
the prompt the model reads on every round, for a read-only question.

**Fix direction:** offer metaproject tools only when the project has a metaproject,
and graph tools only when a graph exists.

## S-1 confirmed, S-4 not live here

- **S-1:** step 17 `read_file dc-schema-editor-store.ts` → 20,022 bytes, `CLIPPED`.
  The one file the smoke's keryx answer did contain was read only up to the cap.
- **S-4:** 15 rounds of a 40-round budget. The round cap did not end this turn.

### keryx-shell context-on — never ran (the 403 was the token, K-010)

---

## K-010 — `auth status` says active while x.ai rejects the token · open

**Evidence:** `keryx auth status grok --json` at ~00:05 → `state: "active"`, expiry
2026-09-11T00:54Z, refreshable. At 11:45 the same grant was refused on every request
with `The OAuth2 access token could not be validated.`, arena and real home alike;
`keryx auth login grok` fixed it at once. The smoke used the grant successfully
until ~23:35 on 2026-09-10.

**Two defects.** `auth status` reports a state computed from the local record, not
from whether the provider accepts the token. And a 401/403 on a refreshable grant
neither tries a refresh nor says "run `keryx auth login grok`" — the turn ends on the
first request. Why the token stopped validating early is not known; a newer login
by another client invalidating a single-session grant is a candidate, not verified.

**Fix direction:** on an `authentication` error from an OAuth-backed provider, try
one refresh, and if that fails name the fix in the error. `auth status` should probe,
or say its state is local.

## K-011 — the arena's checkout pointed at the source clone · fixed on this branch

**Evidence:** `.git/FETCH_HEAD` in every arm checkout read `'<base>' of
/Users/…/arena/clear/vantage-frontend`. `createIsolatedCheckout` removed the remote
(closing `git fetch origin`) but left FETCH_HEAD. The grok CLI in `/tmp/arena-diag3`
read it (step 19 of the control arm: `cat .git/config`, `cat .git/FETCH_HEAD`) and
ran `git -C <source> show 53254e0e3` — the answer — in both arms. It also tried
`gh pr view 6435 --repo <the real repository>` and `curl` against GitHub.

**Fix (this branch):** FETCH_HEAD is deleted after checkout;
`assertNoSourcePointer` refuses a tree when any text file under `.git` names the
source clone (both spellings of the path), before the agent runs and in the dry run;
and an arm whose kept transcript or stderr names the source clone fails as "reached
the source clone … cannot be scored" instead of recording a result. Tests:
`scripts/arena/arena-escape.test.ts`, `retrieval-checkout.test.ts`.

**Residual, recorded rather than closed:** an arm with a shell can still search the
filesystem for another copy of the repository, and can reach the network through
`curl`/`gh` (the grok CLI's `--disable-web-search` does not cover shell commands).
The transcript check catches the first when the path appears in what the arm ran; the
second is bounded only by the isolated HOME holding no GitHub credential. A real
sandbox for the arm's shell is the complete fix.

## K-012 — a refused `keryx shell` start does not exit when MCP servers are configured · fixed in 0.2.96 (#530)

**Evidence:** after merging 0.2.95 into this branch, the two tests that check
`--deny-tools` names against the real CLI timed out. Measured with the tests' own
command, `bun src/cli.ts shell --provider deepseek --model unused --no-tui
--deny-tools web_serch -p x`:

| HOME | time | exit | refusal printed |
|---|---|---|---|
| operator's own | killed at 90 s | 143 | yes |
| isolated (the arena's) | 1.3 s | 1 | yes |

Under the operator's HOME the shell prints `unknown tool name(s) in --deny-tools`
and then never exits. The difference is the MCP servers configured in that HOME
(and read through the new compat readers — the run also warns about
`~/.grok/config.toml`): the tool list is built through the MCP runtime, which starts
them first, and after the refusal they keep the process alive.

**Impact:** any start that fails after the MCP runtime is up — a typo in
`--deny-tools` is the reproduced case — hangs instead of exiting, for every user with
MCP servers configured. A script or CI step that expected exit code 1 waits forever.
The arena is not affected (isolated HOME, no user servers), so the tests now run the
CLI under an isolated HOME, the way the arena does; that fixes the tests, not this.

**Fix direction:** validate `--deny-tools` against the static roster before starting
the MCP runtime; and on any startup error, close the runtime (or exit explicitly) so
live child connections cannot hold the process.

## K-013 — keryx sends an expired grok token it could have refreshed · open (product, 0.2.96)

**Evidence:** the 0.2.96 smoke (`/tmp/arena-0296`, 2026-09-11 20:18) failed both
keryx-shell arms on the first call: `xAI (Grok) API returned HTTP 403: The OAuth2
access token could not be validated`, zero tool calls. `keryx auth status grok` then
read `device-code expired (expires 2026-09-11T15:02:01Z), refreshable`. Calling
`refreshProviderGrant("grok", …)` by hand against the same `auth.json` succeeded at
once (new expiry 22:34 UTC) — the refresh token was good; the shell never used it.

**What the code does:** the only caller of `refreshProviderGrant` is
`resolveTuiStartup` (`src/commands/shell.ts`), with `.catch(() => undefined)` — a
failed refresh is silent, and the expired token is sent. In the arena the arm's
`auth.json` is a symlink to the operator's. Not yet established: whether the arena's
`-p` path reaches that refresh, whether it ran and failed, or whether a refreshed grant
was written somewhere the provider did not read. The operator's file still held the
expired grant after both arms, so no refresh landed in it.

**Impact:** every keryx grok session started more than ~6 h after login fails with a
403 until the operator runs something that refreshes — and the error says "could not
be validated", not "expired", so it reads as K-010 (a revoked grant) and sends the
operator to `auth login`.

**Fix direction:** refresh on every path that builds a provider from a grant, not
only the TUI start-up; surface a failed refresh instead of swallowing it; and on a 403
from a grant-backed provider, refresh once and retry before failing.

## K-014 — an arm borrowed the operator's HOME and read the answer from GitHub · fixed on this branch

**Evidence:** `/tmp/arena-0296/transcripts/t1-53254e0e-grok-build-context-on.jsonl`.
With the source clone fenced off (K-011) the grok CLI, in the context arm, ran
`HOME=<operator home> gh auth status` and then `HOME=<operator home> gh api
repos/Presight-AI/vantage-frontend/pulls/6435/files` — the operator's GitHub login,
and the answer PR's file list — and scored 4/4. On the way it listed
`/private/tmp/arena-0296/cache/` and read the head of the arena's `transcripts/`.
The control arm tried `gh` without the override (no credential, empty) and the public
API (404), and scored 1/4. The claude arm tried `gh pr view 6435`, was refused for
want of a login, and went back to the code. The K-011 transcript check named only
the source clone, so the arm was recorded.

**Fix (this branch):** `transcriptReachingOutside` (`scripts/arena/arena-run.ts`)
refuses an arm whose transcript or stderr names the operator's real home (except PATH
entries under it — naming `~/.nvm/…/bin/keryx` is resolving a binary; the entry's
parent is not allowed, so `~/.local/bin` does not open `~/.local/share/keryx`) or
anything in the arena's output directory outside the arm's own tree — the base-tree
cache, other arms' transcripts, sibling trees. Tests: `scripts/arena/arena-escape.test.ts`.

**Residual, still recorded rather than closed:** the fence reads what the arm showed.
An arm that reaches the network without naming a path — a bare `gh` with a token it
found some other way, or `curl` to a public mirror — is caught only if the transcript
names what it touched. The arm runs as the operator's user; only a separate user or a
real sandbox takes the operator's files out of reach.

**Consequence:** the grok-build context-on 4/4 of the 0.2.96 smoke is void, like the
earlier grok rows. The context-off 1/4 stands.

---

## Status after 0.2.95 (2026-09-11)

| id | status |
|---|---|
| K-000 | fixed on this branch (transcripts kept) |
| K-001 | withdrawn — comparison contaminated (K-011) |
| K-002 | open — needs an uncontaminated comparison to say anything |
| K-003 | open — same |
| K-004 | fixed in 0.2.95 (#529) |
| K-005 | fixed in 0.2.95 (#529); proved itself on the first real call |
| K-006 | answered — the model's habit, grok does it too; not a keryx prompt defect |
| K-007 | open — prompt change, deferred by the operator |
| K-008 | fixed in 0.2.95 (#529) |
| K-009 | fixed in 0.2.95 (#529), plus the prompt now follows the roster |
| K-010 | open |
| K-011 | fixed on this branch; residual risk recorded |
| K-012 | fixed in 0.2.96 (#530, flow 251): every exit closes the readline MCP runtime; a refused start went from a 40 s timeout to 5.8 s, and close() no longer lingers ~4.5 s |
| K-013 | open — expired grok grant sent instead of refreshed; root cause not yet pinned |
| K-014 | fixed on this branch (transcript fence: operator home, arena files); residual risk recorded |
| S-1 | fixed in 0.2.95 (#529) |
| S-2 | improved — clip notes now say how much was dropped (K-008) |
| S-3 | partly — the prompt's tool statements are now true of the roster |
| S-4 | not live — dropped |
