# test-v1 — the first uncontaminated arena sweep

2026-09-12, branch `arena/measurement`. Raw data, logs and verdicts are in
[`data/`](data/); improvement proposals are in
[`improvement-proposals.md`](improvement-proposals.md) (written by a separate
reviewer from this data) and [`arena-improvements.md`](arena-improvements.md).

This folder is meant to outlive any single run: rebase it onto `main`, run the next
sweep, and add `test-v2` beside it rather than editing these numbers.

## The question

Does a provisioned `.metaproject/` workspace make an agent better at real work, and
is keryx's own shell competitive with a vendor CLI on the same model?

## The method

13 frozen T1 tasks — real historical changes to `vantage-frontend`. Each task is
described **forward**: "a developer is about to make this change … name the source
files that will have to change; the change is not in this repository's history".
PR numbers, conventional-commit prefixes and squash bullets are stripped
(`asRequest` in `scripts/arena/arena-prompts.ts`), because the earlier phrasing
("a change was made … which files did it touch") turned every task into a history
lookup: agents went to GitHub, to other arms' output, and into the operator's home.

Two legs, each task run twice:

| leg | agent | model |
|---|---|---|
| `keryx-shell` | keryx's own agent shell, built from this checkout | grok-4.6 |
| `claude-sonnet` | the Claude Code CLI | claude-sonnet-5 |

- **context-on** — the arm's checkout carries a provisioned `.metaproject/`
  (503 wiki pages, graph, routing index).
- **context-off** — the same checkout with that stripped.

Both arms get byte-identical prompts. Scoring is retrieval against the gold file set
of the real change: recall, precision, tool calls, context tokens, dollars, wall
clock, and the step at which a gold path first appeared.

## The results

Per-task rows: [`data/breakdown.txt`](data/breakdown.txt). Rows are de-duplicated by
`(harness, task, arm)` — a resumed run re-ran one arm (K-017).

| leg | pairs | recall with context | recall without | tokens (recorded) | tokens (corrected) | cost |
|---|---|---|---|---|---|---|
| keryx-shell @ grok-4.6 | 10 | 8/23 (0.35) | 8/23 (0.35) | 6.87M vs 5.94M (1.16×) | same — no sub-agents | subscription |
| claude-sonnet | 13 | 10/28 (0.36) | 9/28 (0.32) | 17.06M vs 4.04M (4.22×) | 17.06M vs ~13.55M (1.26×) | $7.58 vs $6.81 (1.11×) |

The arena's own verdicts, verbatim from [`data/run.log`](data/run.log):

```
keryx-shell:    +0.0 points over 10 paired tasks, below the +10 threshold — no
                difference, not a trend; context cost ratio 1.15, within the ±20% tie band
claude-sonnet: +13.5 points over 13 paired tasks, at or above the +10 threshold;
                context cost ratio 4.38, above the tie band — the gain was not free
```

### What those verdicts mean, stated honestly

- **keryx-shell: no difference.** Identical recall in both arms, 16% more tokens with
  the workspace. Two tasks were much cheaper with it (`t1-5dde4b04` 27 s against
  279 s; `t1-feca1074` 270k tokens against 543k) and three much dearer
  (`t1-6151fea2` 643k against 193k). It helps where the answer sits in one place and
  costs where the work is a broad sweep of the code.
- **claude-sonnet: a weak positive.** `+13.5` clears the pre-registered threshold, but
  the raw difference is **one gold file out of 28** — four task wins against three
  losses. That is the size of the noise on a 13-task sample.
- **The cost half of the claude verdict is wrong** — see K-018 below. Corrected, it is
  a tie, not a 4× penalty.
- **Recall is about a third of the gold files in every arm.** On this task type the
  binding constraint is the search itself, not the presence of a workspace.

## What makes this run trustworthy, and what does not

**Trustworthy:** isolation. **Zero of 26 arms left their tree**, against 15 of 16 in
the previous batch. Every arm's transcript is checked afterwards for the operator's
home, the arena's own output directory, other arms' trees and the source clone
(`transcriptReachingOutside`); the earlier contamination — an arm reading the answer
PR through the operator's `gh` login — cannot recur unnoticed.

**Not trustworthy:** the token metric for any agent that delegates (K-018).
`contextTokens` is read from the final `result` event's `usage`, which is the main
thread only. Claude's control arms spawned 16 sub-agents carrying 9.51M tokens that
the metric never saw. The dollar column gives it away: delegating arms appear to cost
$5.92–$16.00 per million recorded tokens while every arm that reads for itself sits
at $0.35–$0.99.

**Caveats that no fix removes here:** 13 tasks is a small sample; three keryx control
arms hit the 900 s watchdog ceiling and their tasks are unpaired; and T1 measures
retrieval only — it says nothing about whether the workspace helps an agent *change*
code.

## What the sweep produced besides numbers

Three keryx defects, found by reading the arms' own transcripts, fixed in PR #532
(flow 253) and shipped in **0.2.98**:

- **K-013** — a scripted shell (`--no-tui`, `--print`) sent an expired grok token
  instead of refreshing it, and the 403 read as a revoked login.
- **K-015** — `shell_exec` handed every saved provider key to every command it ran;
  an agent that ran `env` printed the operator's DeepSeek, OpenRouter and xAI keys.
- **K-016** — a `memory_search` miss printed the deletion journal's absolute path in
  ~700 characters of disclaimer; it was where three arms first learned their own
  location, the step before they walked out of their tree.

Four arena defects: **K-014** (an arm reached the operator's home and the arena's own
files — fixed, with a transcript fence), a false positive in that fence (an arm's own
tree at the end of a sentence — fixed), **K-017** (a resumed sweep re-runs a
half-finished task's arms), **K-018** (the token metric above). All are recorded in
[`../arena/keryx-shell-defects.md`](../arena/keryx-shell-defects.md).

## Files

| file | what it is |
|---|---|
| `data/results.jsonl` | one row per scored arm, as the runner wrote it |
| `data/failures.jsonl` | the three arms that hit the watchdog ceiling |
| `data/failures-before-rerun.jsonl` | the same file before a stale false refusal was removed, kept as evidence |
| `data/run.log` | the runner's own output, including every verdict line |
| `data/breakdown.txt` | the per-task table above, de-duplicated |
| `data/breakdown-report.ts` | the script that produces it — `bun breakdown-report.ts <out-dir>` |
| `data/transcripts.tar.gz` | all 52 arm transcripts, 12 MB uncompressed |

## Reproducing

```bash
# node 25 + pnpm 11 active; ripgrep on PATH
bun scripts/arena/run-arena.ts --repo ~/sandbox/arena/clear/vantage-frontend \
  --out /tmp/arena-next --harness keryx-shell,claude-sonnet \
  --task t1-1405959d,t1-5dde4b04,… --lint-baseline /tmp/arena-lint-baseline.txt
```

Run a dry run first (`--dry-run`): it spends nothing, provisions every arm and fails
on a control arm that can resolve `keryx` or a tree that points at the source clone.
Use a fresh `--out` each time, and keep `/tmp` clear of previous runs — an arm that
finds an earlier run's `results.jsonl` has found the answer key.
