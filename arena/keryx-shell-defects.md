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

## K-001 — same model, a quarter of the recall · observed

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

### keryx-shell context-on — pending
