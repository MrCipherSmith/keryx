# Does project-local context help an agent find the right files?

Measured 2026-09-05. Two repositories, 63 tasks, 126 agent sessions, zero
failures.

**Answer: not measurably, and it costs more to read.**

| | keryx | vantage-frontend |
|---|---|---|
| Tasks | 13 | 50 (primary) |
| Recall, `context-on` | 80.3% | 45.6% |
| Recall, `context-off` | 82.9% | 41.9% |
| **Gain** | **−2.6 pts** | **+3.7 pts** |
| Context cost | **+32%** | **+16%** |
| Wins / ties / losses | 0 / 12 / 1 | 7 / 39 / 4 |
| Wiki present | 51 pages | 2 (init boilerplate) |
| Verdict | fails | fails |

Threshold, fixed before the first run: **+10 points of recall at no greater
context cost.** Neither run comes close, they disagree on sign, and in both the
context arm read more to get there.

## Documents

| file | what |
|---|---|
| `pre-registration.md` | the charter — threshold, filters, metrics, and every amendment with its date and reason |
| `results-keryx.md` | secondary run, the only one with a real wiki in the arm |
| `results-vantage-frontend.md` | the primary run, including the interim slices and the limitations |
| `data/*.jsonl`, `data/*.json` | raw per-arm results and the computed verdicts — recompute and check |

## What follows, in order of how much it matters

### 1. Weaken the README claim. This was pre-committed.

keryx's README says project-local context makes an agent better at finding the
right files — specifically that `gdgraph affected` beats grepping. **This
benchmark does not support that.** The pre-registration committed to saying so
before the result was known, and this is that.

What the evidence actually supports is narrower and still worth saying: the
graph and routing index did not change *file retrieval* outcomes on merged pull
requests, on two repositories, with two models. It says nothing about
comprehension, patch quality, or a wiki a person reads.

**Recommendation: state what is measured and what is not, and drop the
comparative claim until something supports it.** The wording is the owner's
call; this document does not make it.

### 2. The benchmark is less sensitive than its size suggests. Fix before rerunning.

**On 17 of 50 vantage tasks, both arms scored zero.** A third of the sample
separates nothing while dragging both means down. Any rerun should decide *in
advance* whether to report the solvable subset separately or filter for tasks at
least one arm can complete.

### 3. The wiki has never actually been tested.

The primary run had 2 boilerplate pages. The only run with a real wiki was
keryx's 13 tasks, which is underpowered and is also the repository where the
context arm did worst. **Whether the wiki helps remains genuinely unknown** —
not disproven, untested.

Testing it needs a repository that commits its wiki and has enough history, or
generating one per worktree at the parent commit (expensive, and the generator
is itself a model).

### 4. vantage-backend is ready and unused.

68 Java tasks, private, independent of the frontend, and stricter layering —
where a code graph would be expected to help most if it helps anywhere. The
harness handles it; the run was never authorised. **This is the cheapest way to
find out whether the negative generalises across languages.**

### 5. Do not throw the harness away.

It found nine defects in itself before producing a number, eight of them before
they could reach a result — including a git channel that handed the agent the
answer, an ablation with nothing to ablate on the primary repository, and a
leakage check that was backwards *and* never executed. Those are recorded in
`pre-registration.md` as dated amendments.

The reusable parts are the guards, not the conclusion: assert the arms are the
arms, record what each arm actually held before and after, and refuse a run that
cannot demonstrate its own setup.

## What this measurement cost

**$146.18 dollar-equivalent** across both runs (subscription usage, not a
charge). Estimates given beforehand were $6 for keryx and $45 then $100 for
vantage. All three were low — the first by 4×, because it was extrapolated from
a smoke run that had executed against a broken harness.
