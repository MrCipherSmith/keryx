# Arena handoff

Written for someone picking this up cold. Read it before touching anything; several
things below were established the expensive way and are not obvious from the code.

Branch: `arena/measurement`. Pushed to `origin`. Based on
`measurement/context-2026-09`, which is 49 commits off `main` and holds the earlier
2026-09-05 measurement.

---

## 00. Where it stopped, 2026-09-11 ~00:10 — read this first

**Blocked on the x.ai balance.** Both grok-4.6 legs (`keryx-shell`, `grok-build`)
fail until it is topped up. `grok` says it plainly — `402 Payment Required: Grok
Build usage balance exhausted`; keryx says `Ollama API returned HTTP 403` (a defect
in itself, K-005). `keryx auth status grok` is `active`, so it is not the token. The
claude leg is a different account and works.

**Done this session:**

- Synced to `origin/arena/measurement` (fast-forward to `0a0eece`).
- Dry run passes: isolation proven for all three legs, context arm provisions 503
  wiki pages + graph + routing index, control arm has none and cannot resolve
  `keryx`.
- **The smoke completed for the first time — 6/6 arms, 0 failures**, task
  `t1-53254e0e` (4 gold files). Results in `/tmp/arena/results.jsonl`. The claude
  credential path works under the isolated home (§7 is closed in fact, not only in
  code). Token accounting cross-check (§8 step 4) passes: keryx-shell 994k vs
  grok-build 1.50M on the control arm, same order of magnitude.

  | leg | arm | recall | tokens | tool calls |
  |---|---|---|---|---|
  | grok-build | on | 1.00 | 308k | 24 |
  | grok-build | off | 1.00 | 1.50M | 83 |
  | keryx-shell | on | 0.25 | 977k | 76 |
  | keryx-shell | off | 0.25 | 994k | 62 |
  | claude-sonnet | on | 0.25 | 726k | 16 |
  | claude-sonnet | off | 0.25 | 515k | 12 |

  One task, no statistical claim. The signal worth chasing: the same `.metaproject/`
  cut grok's tokens 4.9× at equal recall, and did nothing for keryx's own shell on
  the same model.
- `b4baefa` — every arm's raw stream is now kept at `<out>/transcripts/`, written
  before interpretation so refused arms keep their evidence; stderr drained and kept.
- **`arena/keryx-shell-defects.md`** — the running log of why keryx-shell loses,
  worked from transcripts. K-004…K-009 plus code-level suspects S-1…S-4. Read it
  before touching the shell.

**Not done, in order:**

1. **Top up the x.ai balance** (operator).
2. **Wire the watchdog into `runArenaArm`** (§6.4) — needs no model; was next when
   this stopped. The adapters own the child process, so they have to expose its pid
   and a last-activity signal (the keryx events file's mtime; stdout activity for
   grok and claude) to a poll loop that calls `evaluate`.
3. **Rerun the diagnostic** to close K-006 — does grok-build, on the same model,
   also hunt for the commit in git history, or is that keryx's prompt?
   ```bash
   bun scripts/arena/run-arena.ts --repo ~/sandbox/arena/clear/vantage-frontend \
     --out /tmp/arena-diag2 --task t1-53254e0e --harness keryx-shell,grok-build
   bun scripts/arena/arena-trace-keryx.ts /tmp/arena-diag2/transcripts/<file> <gold,…>
   ```
   (`/tmp/arena-diag` holds the balance-killed attempt; its keryx context-off
   transcript, 43 calls, is the evidence behind K-005…K-009.) The trace script
   prints each tool call, result size, clipping, and the step each gold path first
   appeared. It reads the keryx events format only; grok and claude transcripts are
   stream-json and need their own reader.
4. Full sweep (§8 step 8), then T2 judging.

---

## 0. Update, 2026-09-10 — what changed after this document was written

Three items in §8 moved. Read this before §6 and §7, which are otherwise still
accurate.

**Step 6 (§6.3, extract the events-file feature to `main`) is DONE.** It landed
as PR #524, squash `1c482abc`, together with a second fix described below.
`src/commands/shell-events.ts` and `--print` / `--events-file` /
`--events-max-field` are on `main` now. The keryx leg still runs from source
(`bun <repo>/src/cli.ts`), because `main` is ahead of the last npm release — but
the caveat §6.3 asks the report to carry is now about a release lag rather than
about an unreleasable feature.

That PR also carried a **defect in the redaction floor** found while writing the
transcript's tests: `redactSensitiveText` masked `AKIAIOSFODNN7EXAMPLE` and
printed the `aws_secret_access_key` on the next line in full, in both the
uppercase and the lowercase form — the exact `cat ~/.aws/credentials` case its
own contract names. Fixed, with prose and camelCase identifiers tested to stay
untouched.

**Step 1 (§7, the claude credential path) is FIXED IN CODE and still BLOCKED in
fact.** The grant is now materialised from the Keychain into the isolated home
at 0600, `~/.claude.json` is synthesised rather than linked, and the Linux link
is required rather than optional. The observable change: `claude -p` under an
isolated home no longer answers `Not logged in · Please run /login` — it answers
`Failed to authenticate: OAuth session expired and could not be refreshed`,
which means the grant was found, read and recognised.

**The same call under the REAL home fails identically.** That removes isolation
from the picture entirely: this operator's Claude Code OAuth session is expired
on this machine. Nothing in this repository can fix that. **The operator must
run `claude` and sign in again before the claude leg can be verified end to
end**, and until then no run should be read as evidence about that leg.

**Step 2 (§6.1, PR #525 `--deny-tools`) is unblocked but not landed.** The PR
had gone `CONFLICTING`: #524 took the same four places in `ShellCliFlags` and
its parser an hour earlier. Every conflict was two additions with no overlap, so
both sides were kept, and the branch now carries `--deny-tools`, `--print`,
`--events-file` and `--events-max-field` together — verified from
`keryx shell --help` and by an unknown name still being refused with the list of
deniable tools. CI was reporting nothing on that branch before this push; it
runs now.

**Ordering trap for whoever wires §6.1.** Do not add
`--deny-tools web_search,web_fetch` to `buildKeryxArgs` until this branch's own
`src/` carries the flag. The keryx leg runs `bun <repo>/src/cli.ts` from THIS
checkout, and `arena/measurement` is behind `main`, so the flag would be passed
to a build that does not have it and every keryx arm would die on
`Unknown shell argument`. Either land #525 and bring `main` in first (§6.5), or
do both in one change.

**Step 2 is now DONE.** #525 merged (`ed026b9b`), `main` merged into this branch,
and `--deny-tools` is wired into `buildKeryxArgs`. Not the way §6.1 describes:
the constant beside `--auto` is a list of case-insensitive SUBSTRINGS for
judging a roster, while the flag takes exact names from keryx's registry and
refuses an unknown one — passing the markers would have killed every arm at
startup on `unknown tool name(s)`. The exact names are their own list, held to
the markers by a test, and their agreement with keryx's registry is checked by
running the CLI rather than by keeping a copy of its tool list.

**§6.5 is resolved by merge, not rebase.** `arena/measurement` is level with
`main` and was never force-pushed: a merge reaches the same tree without
rewriting what anyone may have fetched. The duplicated provider commits are
untidy and harmless. `measurement/context-2026-09` is archival, confirmed by
the operator.

**A fourth NUL byte, from `42d13dfe` rather than from the pilot work.**
`arena-run.ts` held a literal NUL between two interpolations, so ripgrep skipped
the file silently and every search for it read as "not present" — in the code
that decides which arm runs first. Now written as `\u0000`, which keeps the
digest and therefore the arm ordering byte-for-byte unchanged. The guard that
caught it has been in the suite since phase 5 and is on this branch, so its
silence until now means the full suite was not run after that commit. Two
different sessions produced the same corruption in the same shape of
expression; treat `${a} ${b}` between two interpolations as a construct to
avoid rather than a mistake one agent made.

---

## 1. What this measures, and what it cannot

**The question:** does keryx's project-local context make an agent better, and what
does it cost.

**What the arena does:** two task types on an external repository
(`~/sandbox/arena/clear/vantage-frontend` — 8,632 files, 6,910 ts/tsx, 266k lines),
three agent CLIs, two arms each (with and without `.metaproject/`).

| task | count | arms |
|---|---|---|
| T1 research — derived from git history | 13 | 78 |
| T2 implement — GitHub issue 4490 | 1 | 6 |

| leg | binary | model |
|---|---|---|
| `keryx-shell` | `bun src/cli.ts` (see §6.3) | grok-4.6 |
| `grok-build` | `grok` 1.0.24 | grok-4.6 |
| `claude-sonnet` | `claude` 2.1.266 | claude-sonnet-5 |

The first two hold the **model constant**, so the difference between them is the
wrapper and nothing else. That is the only thing this arena answers without leaning
on statistics. The third exists so the result is not a claim about one vendor.

**Only T1 has statistical power.** 13 paired tasks give a minimum detectable effect
of ~10 recall points, which is exactly the pre-registered threshold (+10 points at
no greater context cost). T2 is n=1 and is reported as a case study with full
transcripts — never folded into a mean.

**Three things the arena answers without statistics**, and which should be the
report's headline:

1. Wrapper overhead at constant model (`keryx-shell` vs `grok-build`).
2. Integration gaps as findings — keryx has no grok runtime (`orient install-hook`
   supports claude/codex/cursor; `agents bootstrap` supports
   claude/opencode/zcode/codex/antigravity).
3. Mechanism observations: `graphRebuilds`, token-accounting shape, fixed entry cost.

**What it does NOT measure, and this belongs in the report body rather than a
footnote:** an agent-authored wiki. The arena provisions deterministically
(`keryx init` + `gdgraph build` + `wiki collect` + `wiki index`, no model). Reasons
in §4.3. A null result is a result about the graph and routing layer; the
authored-wiki claim stays untested, not refuted.

---

## 2. Decisions already made — do not relitigate without a reason

| decision | why |
|---|---|
| 3 legs, not 4 | `claude-opus` was 26 of 104 arms at ~$1 each, half the budget, for a second point on a secondary axis. Deferred, not cancelled: `CLAUDE_OPUS_DEFERRED` is in `arena-harnesses.ts` and resume is per harness, so adding it is an append. |
| T1 = 13 tasks | At n=1 per metric the design cannot see its own threshold: MDE ≈ 20 points by normal approximation, 45 by exact t at 2 df, against a +10 threshold. |
| T1 tasks derived from git, not hand-written | Gold comes from a real PR diff rather than from an agent, which removes the teaching-to-the-test threat entirely. |
| T2 scored by gates + blind pairwise judge, no hidden acceptance test | §6.2 — the root cause is in a React component's call order with no unit seam, and in jsdom the bug does not reproduce at all. |
| No authored wiki | §4.3 |
| Watchdog kills, no retries | A retry masks a leg that systematically hangs and inflates its score. |
| Arena ablates `.metaproject/` only | `AGENTS.md`, `CLAUDE.md` and ten `.claude/rules/*.md` are ~35k tokens of the target team's own conventions. Stripping them measures what happens when you take a codebase's documentation away. **Consequence: arena numbers and the 2026-09-05 pilot's numbers answer different questions and must never share a table.** |
| Control arm loses `keryx` from PATH | On a tree with no `.metaproject`, `keryx ctx rg` still searches and `keryx ctx read` still compacts. The pilot decided the opposite (binary present in both, verified via `hasGraphDb === false`); both are defensible, the divergence is named in the report. |

---

## 3. What is done

17 commits on this branch. Grouped:

**Three defects fixed in the 2026-09-05 pilot harness** (`653dec6`, `da056b7`,
`8fb6eac`), with a note at
`docs/requirements/keryx-context-measurement/harness-defects-2026-09-09.md`
(`99761c5`) — **but see §7, part of that note is wrong**.

- keryx leg reported one request's prompt tokens, not the turn's sum.
  `shell.ts` assigns `lastUsage` per call, last wins; the adapter read only
  `turn_end.usage`. Claude and grok report a sum, so the legs were never the same
  quantity — an order of magnitude in keryx's favour on a long task.
- Neither CLI leg was isolated. `buildClaudeEnv` copied the whole parent
  environment and overrode one key, so the operator's global `CLAUDE.md` — which
  carries this project's own keryx routing block — reached the control arm. Both
  legs now build their environment from an allowlist.
- The keryx leg verified nothing: no roster check, no environment isolation.
  `turn_start` now carries the tool roster; the arm runs under an isolated HOME
  with `XDG_DATA_HOME` redirected.

**13 T1 tasks frozen** (`0eb952b`) — `arena/tasks/t1-tasks.json`, seed `20260909`,
drawn uniformly from 113 admissible. Four properties of the sample are recorded in
the artifact itself and must be read alongside the numbers:

- 6 of 13 have a single-file gold set, which caps what any retrieval layer can add.
- Task `1405959d`'s only gold file is `eslint.config.mjs` — a code graph cannot help
  locate it by construction.
- `e2e/app/component/profileSearch.component.ts` is the sole gold of two tasks and
  appears in a third, so three of thirteen share an answer and effective
  independence is below n=13.
- The gold-set-size filter dropped 242 of 600 candidates — every PR touching more
  than eight source files — so the sample is the small surgical change.

**Eleven arena modules with 168 tests**, all runnable against a fake agent with no
model spend: `arena-fake-agent`, `arena-context`, `arena-env`, `arena-checkout`,
`arena-tasks`, `arena-prompts`, `arena-scoring`, `arena-gates`, `arena-watchdog`,
`arena-run`, `arena-sweep`, `arena-judge`, `arena-provision`, `arena-leakage`,
`arena-harnesses`, `run-arena`.

**Two product fixes released in `v0.2.88`** (PR #523, merged). npm went 0.2.84 →
0.2.88, which also finally published 0.2.85–0.2.87 — those were prepared in `main`
with changelog entries and never tagged.

**`--deny-tools` in PR #525**, open at time of writing. Needed by §6.1.

---

## 4. Environment facts — established, do not rediscover

### 4.1 The target repository

- `~/sandbox/arena/clear/vantage-frontend`, branch `develop`, HEAD `441526a25`,
  clean, zero keryx references in tracked files. This is the arena's `--repo`.
- `~/sandbox/arena/withKeryx/vantage-frontend` is the operator's own working tree
  on a feature branch, 7.7G, with `graphify-out` snapshots and real work product.
  **Do not touch it.** An earlier note in this project claimed it was dead; that was
  wrong.
- Node 25.9.0 and pnpm 11.17.0 are required (`.nvmrc` = 25,
  `packageManager` = `pnpm@11.17.0`) and installed. Dependencies are installed in
  `clear/` — 1.5G — and serve as the `node_modules` template.
- **The repo uses git LFS** for screenshot baselines. `createIsolatedCheckout` sets
  `GIT_LFS_SKIP_SMUDGE=1`; without it a checkout at a base older than the clone's
  HEAD dies with "remote missing object".

### 4.2 Contamination, measured

`grok inspect` in the clean checkout under the real HOME finds: the operator's
global `CLAUDE.md` (~1,879 tokens, containing the Keryx bootstrap block), 79 skills,
six MCP servers including `github` and `backend-graph`, and four hooks. `.mcp.json`
comes from a cursor config outside the repo, so isolating HOME is not enough — MCP
is killed by flags as well.

**The allowlist must include `NODE_EXTRA_CA_CERTS`.** This machine is behind a
TLS-inspecting proxy; without it every Node or Bun process fails with "unable to get
local issuer certificate" while `curl` succeeds from the system keychain. A
Rust-built CLI survives the isolation and a Node-built one does not, so the symptom
reads as one harness being broken rather than one variable being absent.

### 4.3 Why there is no authored wiki

The only authored wiki for this target is in the operator's `withKeryx` tree: 511
`components` pages, 3 `architecture`, 2 `testing`, and **zero** for business-rules,
decisions, domain-models, integrations, services and user-scenarios — exactly what
the gdwiki skill warns about when it says a page count is not coverage.

It is at commit `79d95b0b96`, a feature-branch tip dated after every one of the 13
task parents (2026-06-29 to 2026-08-31). **0 of 13 tasks are admissible against it**
under the pre-registration's rule (a task is admissible only if its base descends
from the wiki's commit). Building a fresh one below the oldest parent means
re-authoring 511 pages of prose. So the arena provisions deterministically and says
so in the report.

`keryx wiki refresh` is documented by the gdwiki skill and **does not exist** on CLI
0.2.84+ — it prints the usage banner. The provisioner uses `collect` + `index`.

### 4.4 Credentials, per leg

- **grok** — `~/.grok/auth.json`, symlinked into the isolated HOME. Works.
- **keryx** — `~/.local/share/keryx/auth.json`, symlinked; `XDG_DATA_HOME` points at
  the isolated copy. Works after the `v0.2.88` grant fix.
- **claude** — **the hard one, see §7.**

---

## 5. The smoke run, and what it produced

Two smoke runs, one T1 task each. Only `grok-build` has ever completed both arms:

| arm | recall | context tokens | cost | tool calls |
|---|---|---|---|---|
| `context-on` | 1.0 | 123,938 | $0.019 | 11 |
| `context-off` | 1.0 | 127,511 | $0.028 | 10 |

Cost ratio 0.97 on the first run, 1.54 on the second for the same task — single-task
cost ratios are noisy, which is worth remembering before reading any one cell.

The other two legs have never completed. Causes in §6.

---

## 6. Open blockers, with diagnosis

### 6.1 keryx leg is refused by the roster check

The arm now reaches the model, and `assertKeryxRoster` rejects it:

```
keryx ran with forbidden tools in the roster: web_fetch, web_search
— these can reach the answer from outside the checkout
```

`keryx shell` offered no way to withhold tools. **Fixed in PR #525**
(`--deny-tools <a,b>`); the arena side is not wired yet.

**What to do:** once #525 lands, add `--deny-tools web_search,web_fetch` to
`buildKeryxArgs` in `scripts/benchmark/retrieval-agent-keryx.ts`, next to the
existing `--auto` and `--events-file`. Then the keryx leg's roster matches the
claude leg's (`--disallowedTools WebSearch WebFetch`) and the grok leg's
(`--disable-web-search`).

### 6.2 claude leg is not authenticated under an isolated HOME

See §7 — this is a defect in this branch's own work, with a known fix.

### 6.3 The keryx leg runs an unreleased build

`--events-file` and `--events-max-field` do not exist in published keryx — the
strings appear nowhere in the package, and `keryx shell` answers
`Unknown shell argument`. The whole adapter reads its transcript from that file, so
the leg cannot run against a release. `arena-harnesses.ts` therefore points it at
`bun <repo>/src/cli.ts`.

Those flags live only on `measurement/context-2026-09` (commits `ef2b27c`,
`6d5e4d6`), along with `src/commands/shell-events.ts`, which does not exist on
`main` at all.

**Recommended:** extract that feature to `main` in its own PR. The mechanism carries
no private material; seven references to the private repository sit in docblocks and
can be reworded. Until then the report must carry the caveat that the keryx leg
measures an unreleased build, so a reader comparing against `npm i -g` is not
comparing against this.

### 6.4 The watchdog is not wired in

`scripts/arena/arena-watchdog.ts` is written and has 21 tests, including the case
usually forgotten — an arm working honestly at 90% of its budget must NOT be killed.
It is **not** called from `runArenaArm`, which currently bounds an arm only by the
adapter timeout (`watchdog ceiling + 60s`, so the watchdog would win if it ran).

Tolerable for a six-session smoke; not tolerable for 84 arms. Note especially that
silence suspension is mandatory: `.metaproject/index.md` tells the context arm to
rebuild the graph when uncommitted files are present, so every context arm on T2 is
instructed to run `keryx gdgraph build` over 8,632 files inside its own budget,
emitting nothing. A naive silence detector kills exactly the behaviour under test.

### 6.5 Branch hygiene

`arena/measurement` still carries `c4b1e46` and `a89c83c` — the provider fixes as
first written. `main` now carries them squashed as `e36380b`. Any future rebase or
merge conflicts in three `src/` files. The branch is also 66 commits behind `main`,
so it currently measures a keryx without its own released fixes.

**Planned:** rebase onto fresh `main`, dropping the two released commits.
Force-push. Not done yet because the base is still moving (#525, and possibly the
events-file extraction).

`measurement/context-2026-09` should be marked archival — its `MERGE-STATUS.md`
already records that it is deliberately not in `main` because the repository is
public and the material describes a private codebase.

---

## 7. Things this branch got WRONG — do not trust these claims

**`harness-defects-2026-09-09.md` and commit `da056b7` both claim that Claude Code
on macOS keeps its credential in the Keychain, scoped to the user rather than to
HOME, so an isolated HOME authenticates normally. That is false.** Under an isolated
HOME, `claude -p` returns:

```json
{"is_error": true, "result": "Not logged in · Please run /login", "apiKeySource": "none"}
```

This is why both claude arms failed in both smoke runs. A separate, earlier bug —
`sonnet-5` being an unrecognised model id — was fixed first and masked this one.

**The diagnosis, established by experiment:**

- `oauthAccount` + `userID` from `~/.claude.json` are **not** sufficient.
- The Keychain item is service `Claude Code-credentials`, account `<os-user>`, and
  its secret is JSON with a single key `claudeAiOauth` — the same shape as
  `~/.claude/.credentials.json` on Linux.
- Writing that secret to `$ISOLATED_HOME/.claude/.credentials.json` (mode 0600 in a
  0700 directory) **does** authenticate: `{"is_error": false, "result": "ok"}`.

**The fix to apply** in `createClaudeHome`
(`scripts/benchmark/retrieval-agent-claude.ts`):

1. Materialise the Keychain secret into the isolated
   `.claude/.credentials.json` with `umask 077`, rather than declaring the link
   optional.
2. Synthesise a minimal `~/.claude.json` holding only `oauthAccount`, `userID`,
   `hasCompletedOnboarding: true` and `mcpServers: {}`. **Do not link the real
   file** — it contains `mcpServers` with `backend-graph`, `context7` and
   `playwright`, which is the contamination the isolation exists to remove.
3. Correct the claim in `harness-defects-2026-09-09.md`.

---

## 8. Next steps, in order

1. ~~**Fix the claude credential path** (§7) and correct the defects note.~~ Done
   in code; the leg is still blocked by an expired session the operator must
   renew. See §0.
2. ~~**Land PR #525, then add `--deny-tools` to `buildKeryxArgs`**~~ — done, and
   not literally as written; see §0.
3. **Re-run the smoke** — one T1 task, three legs, two arms, 6 sessions, ~$2. It has
   never completed all three legs. Same command as §9, without `--dry-run`.
4. **Cross-check token accounting** on that smoke: `keryx-shell` and `grok-build`
   context tokens for the same task and arm should be the same order of magnitude.
   An order of magnitude apart means the cost half is not comparable and only recall
   is reportable. (The `cached_tokens`-is-a-subset-of-`prompt_tokens` finding in
   `v0.2.88`'s changelog says they should agree; this confirms it empirically.)
5. **Wire the watchdog into `runArenaArm`** (§6.4) before any long sweep.
6. ~~**Extract the events-file feature to `main`** (§6.3)~~ — done, PR #524.
   Repointing `KERYX_DEV_COMMAND` at a release still waits on the next publish.
7. ~~**Rebase onto `main`, force-push**~~ — done as a merge instead, §0.
8. **Full sweep:** 84 arms, ~$22, hours, one leg at a time, resumable.
9. **T2 judging** — `arena-judge.ts` is written and tested against a scripted model;
   it needs a real judge model wired in, both presentation orders, and the
   calibration probe honoured.

---

## 9. How to run it

```bash
# node 25 + pnpm 11 must be active
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 25

# tests — no model calls, no spend
bun test scripts/arena
bunx tsc --project tsconfig.scripts.json --noEmit

# the verification gate: builds every tree, provisions every context arm, runs
# every assertion, prints each arm's inventory and environment, spends nothing
bun scripts/arena/run-arena.ts \
  --repo ~/sandbox/arena/clear/vantage-frontend \
  --out /tmp/arena --dry-run

# one task, one leg
bun scripts/arena/run-arena.ts \
  --repo ~/sandbox/arena/clear/vantage-frontend \
  --out /tmp/arena --task t1-<id> --harness grok-build \
  --lint-baseline /tmp/arena-lint-baseline.txt
```

A dry run is the verification step, not a convenience. A control arm that turns out
to resolve `keryx`, or a context arm whose graph did not build, fails there rather
than in hour three of a sweep. It has already earned itself twice — catching useless
answer needles and the git-LFS failure.

**Gate commands for T2**, measured on the untouched target: `pnpm type-check`
passes, `pnpm exec vitest run src/pipelines/` passes (302 suites, 973 tests), and
`oxlint` **fails** at rc=1 on five stale `eslint-disable` directives plus a stale
`oxlint-suppressions.json`. Lint is therefore a **delta** gate — baseline snapshot at
`/tmp/arena-lint-baseline.txt`, only new findings fail. Neither `pnpm lint` nor
`oxlint --type-aware` is usable: the first dies with
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` looking for eslint, the second exits 0 in 193ms
having printed nothing.

---

## 10. Issue 4490, for T2

The ticket asks for drag-out-to-unassign on iterator pipeline steps. **The feature is
already implemented and unreachable**, and the root cause is published on the ticket
(`issues/4490#issuecomment-5614938035`).

`resolveIteratorDropAction`
(`src/pipelines/components/pipeline-flow/utils/iterator-dnd-utils.ts:62`) returns
`moveOutOfIterator` at `:87-89`; `PipelineFlow.tsx:640-644` handles it;
`Pipeline.tsx:159` passes the prop; `pipeline-store.ts:1178` implements it. It never
fires because `PipelineFlow.tsx:632-633` runs the position through
`clampInnerStepPosition` (`:70`) first, which constrains it inside the parent, and
the escape test at `iterator-dnd-utils.ts:81-86` requires coordinates outside
`[0, width] × [0, height]`. A clamped position satisfies all four conditions by
construction, so `isInsideParent` is always true and the handler is dead code. Same
call order existed at the ticket's date (`PipelineFlow.tsx:553-554`), so it is not a
regression.

**Consequences for T2.** The criterion in `arena-judge.ts` (`T2_CRITERION`) is
written from this: a correct fix must let the escape test see an unclamped position
while still clamping the stays-inside case. That is checkable by reading a diff,
which is a far better judge question than "is this a good implementation".

No hidden acceptance test, and the reason is worth keeping: the bug lives entirely
in the call order inside a React component. `clampInnerStepPosition` is
module-private and `resolveIteratorDropAction` already behaves correctly given an
unclamped position, so there is no unit seam unless the fixer creates one — and a
test that required one would constrain the implementation. A behavioural test would
need a new story fixture (`PipelineFlow.stories.tsx` has four stories, none with an
iterator containing a child), a Playwright spec, docker, and a DOM-observable
consequence that ReactFlow does not give. **And in jsdom the bug does not reproduce
at all:** `clampInnerStepPosition` returns the position unchanged when the parent's
measured size is 0, so without a browser the clamp disables itself and the test would
pass on the broken baseline — failing its own negative control. Verified, not assumed.

**Answer needles** for the leakage check are prose from the published analysis, not
symbol names: `clampInnerStepPosition` and `moveOutOfIterator` are in the source by
definition, and a generic phrase is worse — "dead code" matched
`.claude/rules/temporal.md` and unrelated source across 8,117 files on the first dry
run and refused a clean arm.
