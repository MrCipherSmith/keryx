# Runbook: the three-harness pilot

Written to be executed by someone who was not in the room, on a machine that is
not this one. Every command is meant to be pasted as-is. Where a step can fail,
the failure is described, because several of them are silent by nature.

**What this run answers.** Whether project-local context helps an agent find the
right files — the claim the 2026-09-05 run measured on one CLI and did not
support — now on three: `claude`, `grok`, and keryx's own shell. And, as a
separate ladder that is never averaged with it, what the keryx wrapper costs
around the same model the grok CLI runs.

**What it does not answer.** Anything about comprehension, patch quality, or the
value of a wiki a person reads. The metric is file recall. See
[pre-registration.md](pre-registration.md) — the threshold, the model rule and
every amendment are fixed there, and were fixed before this run.

---

## 0. Before anything: one trap

```
npm i -g keryx          # ← WRONG PACKAGE
```

`keryx` on npm is `actionhero/keryx`, an unrelated TypeScript framework,
currently at 0.45.0. This project publishes as **`@mrciphersmith/keryx`**. The
wrong command installs a stranger's binary over the same path.

```bash
npm i -g @mrciphersmith/keryx@0.2.83
```

A global install is optional for this run — every command below uses the
repository's own build via `bun src/cli.ts`, which is the version under test.
The global binary is only worth updating so that ordinary day-to-day use is not
running 0.2.80.

## 1. Get the branch

```bash
git clone git@github.com:MrCipherSmith/keryx.git
cd keryx
git checkout measurement/context-2026-09
bun install --frozen-lockfile
```

This branch, not `main`. The harness and the pre-registration are not on `main`
and deliberately so — see [MERGE-STATUS.md](MERGE-STATUS.md).

## 2. Tools that must be present

| tool | why | check |
|---|---|---|
| `bun` | runs everything | `bun --version` |
| `git` | the harness builds each arm as a standalone shallow checkout | `git --version` |
| `rg` (ripgrep) | keryx's own search route; without it the `context-on` arm loses a capability the arm is supposed to have | `rg --version` |
| `claude` | the claude leg | `claude --version` |
| `grok` | the grok leg | `grok --version` |

`rg` missing is the one that silently changes a result rather than failing:
install it (`brew install ripgrep`).

## 3. Credentials

Three separate stores. They do not share anything, and each leg needs its own.

```bash
claude --version                       # Claude Code must be logged in
grok models                            # must print the model list, not a login prompt
bun src/cli.ts auth login grok         # keryx's OWN grok credential — device code
bun src/cli.ts auth status grok        # must NOT say "not authorized"
```

The third one is the easy mistake. Being logged into the `grok` CLI does
**nothing** for keryx: the CLI keeps its credential in `~/.grok/auth.json` and
keryx keeps its own in `~/.local/share/keryx/auth.json`. keryx does not read the
other store. `keryx auth login grok` is a device-code flow against your
subscription; `export XAI_API_KEY=…` works instead if you would rather use a
key.

The `auth` command exists from 0.2.83. A globally installed 0.2.80 answers
`Unknown command: auth` — another reason to run everything through
`bun src/cli.ts`.

**If you skip this step the keryx leg does not silently produce bad data.** It
refuses: without a credential keryx constructs an offline fake provider whose
turns report no token usage, and an arm with no usage is treated as a broken arm
rather than as an arm whose cost is unknown. You will see
`keryx reported no token usage … an arm that never called a model must not be
scored`. That guard exists because the fake is otherwise invisible — the session
header still prints the provider you asked for.

## 4. Preflight — costs nothing

```bash
bun test scripts/benchmark
bunx tsc --project tsconfig.scripts.json --noEmit
```

Expect ~226 passing, 0 failing. This exercises the whole pipeline against a fake
agent port, which is why it exists: a harness whose wiring can only be tested by
paying for model calls does not get tested.

## 5. Smoke — one task, three harnesses

Run this before the pilot. It is two arms per harness — six agent sessions —
and it is the cheapest way to find a broken leg.

```bash
bun scripts/benchmark/run-retrieval.ts \
  --repo "$PWD" --tasks 1 --out /tmp/pilot-smoke \
  --harness claude,grok,keryx
```

Before any model call it prints the model split per harness. Read that line: it
is the pre-registered rule stating itself, and it cannot be described after the
fact.

What good looks like: three `=== <harness> ===` sections, each ending in a
verdict with `tasks: 1`.

## 6. The usage cross-check — do this before the pilot

One assumption in the keryx leg is recorded as an assumption rather than a
fact: that keryx's `inputTokens` (mapped from the OpenAI-compatible
`prompt_tokens`) counts the whole prompt including any cached prefix — the same
quantity the other legs compute as `input + cache_read + cache_creation`. If
x.ai accounts differently, the keryx leg's context cost is not comparable to the
grok leg's, and the harness-cost ladder is measuring nothing.

The smoke run settles it. From `/tmp/pilot-smoke/results.jsonl`:

```bash
python3 - <<'PY'
import json
rows=[json.loads(l) for l in open('/tmp/pilot-smoke/results.jsonl') if l.strip()]
for r in rows:
    print(f"{r['harness']:8} {r['arm']:12} model={r['model']:14} "
          f"contextTokens={r['contextTokens']}")
PY
```

The grok and keryx rows for the same task and arm should be the same order of
magnitude. An order of magnitude apart means the assumption is wrong: stop, and
report the two numbers rather than continuing — the recall half of the run is
still valid, the cost half is not.

## 7. The pilot

```bash
bun scripts/benchmark/run-retrieval.ts \
  --repo "$PWD" --tasks 13 --out /tmp/pilot \
  --harness claude,grok,keryx
```

13 tasks × 2 arms × 3 harnesses = **78 agent sessions**, run one harness at a
time. Expect hours, not minutes.

Verified on this branch at the time of writing, so you can compare before
spending: 13 tasks available, split **4 to the harder model and 9 to the
lighter one**, from 411 candidate commits — 330 dropped as not a pull request,
38 as chore or docs, 15 on gold-set size, 28 because the answer was reachable.
The run prints these same numbers before it starts. If yours differ, the
history moved and the sample is not the one described here.

**Resumable.** Interrupt it and run the identical command again: results are
appended per task, and a finished task is skipped — per harness, so a completed
claude leg does not make an untouched grok leg look done.

**Cost, estimated from the 26 arms actually paid for on 2026-09-05:**

| leg | estimate | basis |
|---|---|---|
| claude | ~$25 | measured: 26 arms at $0.98 mean |
| grok | ~$10 | extrapolated from one probe: $0.0045 for 13k tokens |
| keryx | ~$10 | same models, same order |
| **total** | **~$45** | |

Treat the grok and keryx numbers as soft. Every previous estimate on this
measurement came in low, one of them by four times, because it was extrapolated
from a run that was itself broken. The claude figure is the one with real arms
behind it.

## 8. Reading the result

```bash
cat /tmp/pilot/verdict.json
```

One verdict per harness, in `verdicts`. They are never pooled and cannot be:
`decide` throws on results spanning two harnesses, because pairing is keyed on
task id and one task under two CLIs has two `context-on` rows a task id cannot
tell apart.

Each verdict carries `meetsThreshold` and a `reason` in plain words. The
pre-registered rule is **+10 points of recall at no greater context cost**, and
anything less is no difference — not "a promising trend".

`tokensOn`/`tokensOff` may be `null`. That is not a zero and does not mean free:
it means that leg could not establish what it read, so the cost half of the rule
could not be evaluated and the leg is reported on recall alone.

Per-arm rows are in `/tmp/pilot/results.jsonl`, one JSON object per line,
including what each arm actually held (`inventory`: wiki page count, graph
database present, routing index present) before and after the run.

## 9. Failures, and what each one means

Every one of these is a refusal, not a crash, and each exists because the
failure it describes is otherwise shaped exactly like a result.

| message | meaning |
|---|---|
| `no init event … refusing rather than assuming it was clean` | the CLI's tool roster could not be read back, so the arm's environment is unverified |
| `MCP server(s) reached this arm` | the arm held a second retrieval system; "without keryx" would not have meant that |
| `forbidden tools in the roster` | a web tool survived the flags. keryx is a public repository and the query is a merged pull request's subject line — a web search returns the answer |
| `keryx reported no token usage` | no provider turn happened; a missing credential yields an offline fake |
| `exceeded …s` | a timeout. Not zero recall |
| `produced no final answer` | the run ended without answering. Not the same as answering nothing |
| `no credentials at …/.grok/auth.json` | the grok CLI is not logged in. Raised before the sweep, not at the first call |

Failed arms are listed at the end and written into `verdict.json` under
`failures`. They are never silently dropped: a sweep that quietly loses the
tasks it choked on reports the subset it managed as if it were the sample.

## 10. Ways to invalidate the run without noticing

- **Running with a dirty `~/.claude/` or `~/.cursor/` on the grok leg.** Under a
  normal HOME, grok loads the operator's global instruction files — about 16,600
  tokens, including this project's own routing block — plus six MCP servers and
  ~130 tools, among them a GitHub code searcher. The adapter runs every grok arm
  under a temporary HOME with only the credential linked in, which is why the
  same prompt costs 12,975 input tokens instead of 27,863. Do not "fix" that by
  removing the isolation.
- **Pointing `--repo` at a checkout with uncommitted changes.** Arms are built
  from committed history at each task's parent commit; working-tree state is not
  part of the measurement and its presence means the tree you think you measured
  is not the tree that ran.
- **Changing `--tasks` between resumed runs.** The task list is deterministic
  given `--before`, but a different `--tasks` changes which subset is included
  while the results file keeps the old rows.
- **Editing the pre-registration after seeing numbers.** The document exists so
  that cannot happen quietly; every amendment carries its date and its reason.

## 11. What is deliberately not in this run

- **vantage-frontend.** The primary 2026-09-05 repository. Running it again
  needs the wiki rule in [pre-registration.md](pre-registration.md) implemented —
  a wiki generated once at a commit X, admissible only for tasks whose parent
  descends from X — which is not built yet. The keryx repository does not need
  it: it commits its own wiki, 55 pages, so every checkout at a parent commit
  carries the wiki as it was then.
- **codex.** Admissible but weaker: it reports input and output tokens with no
  cache breakdown, so it could only ever contribute a recall-only leg.
- **opencode.** Excluded, and not on preference: its headless mode hangs
  indefinitely on any task requiring a tool call, reproduced twice.
