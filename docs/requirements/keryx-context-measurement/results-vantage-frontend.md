# Results: vantage-frontend, 50 tasks, 2026-09-05

The primary sweep, run under the pre-registration in this directory — unchanged
since before the first task executed.

## Headline

**Project-local context did not measurably improve file retrieval on this
benchmark, for these models, at this sample size.**

| | `context-on` | `context-off` |
|---|---|---|
| File recall (mean) | **45.6%** | **41.9%** |
| Context tokens (mean) | 1,548,980 | 1,338,205 |
| Dollar-equivalent (mean) | $1.29 | $1.13 |
| Tool calls (mean) | 24.6 | 24.6 |
| Steps to first gold file (mean) | 6.8 (reached on 42/50) | 6.2 (reached on 46/50) |

**Verdict by the pre-registered rule: fails both conditions.**

- Recall gain **+3.7 points** against a threshold of **+10**.
- Context cost **16% higher**, where the rule requires no greater.

`context-on` won 7 tasks, tied 39, lost 4.

## Both repositories, side by side

| | keryx (13 tasks) | vantage-frontend (50 tasks) |
|---|---|---|
| Recall gain | **−2.6 pts** | **+3.7 pts** |
| Context cost | +32% | +16% |
| Wins / ties / losses | 0 / 12 / 1 | 7 / 39 / 4 |
| Wiki in the context arm | 51 pages | 2 (init boilerplate) |

The two runs disagree on sign and agree on magnitude: whatever the effect is, it
is far below the threshold set to distinguish it from noise, and in both cases
the context arm read more to get there.

The threshold was fixed at +10 before either run. A 3.7-point gain is the kind
of number that becomes a headline if the threshold is chosen afterwards, which
is the entire reason it was not.

## What the interim slices looked like, and why they are in this document

| after | recall gain | context cost |
|---|---|---|
| 5 pairs | **+20.0 pts** | context arm dearer |
| 10 pairs | +3.9 pts | context arm cheaper |
| 16 pairs | +5.6 pts | context arm cheaper |
| 26 pairs | +4.2 pts | context arm dearer |
| 32 pairs | +4.2 pts | context arm dearer |
| **50 pairs** | **+3.7 pts** | **context arm dearer** |

At five pairs this measurement showed a twenty-point gain — one won task moving
the mean. The cost comparison changed sign three times. Any of those moments
would have supported a confident announcement, and none of them was real.

Recorded because the pre-registration exists to stop exactly that, and because
the temptation was live: the +20 was reported to the operator, with the warning
attached, and it dissolved within an hour.

## Integrity checks

- **50 of 50 tasks completed. Zero failures.**
- **No control arm built itself a graph** — `inventoryAfter.hasGraphDb` false for
  all 50. The `keryx` binary is on PATH for both arms by design, so this was a
  real way for the ablation to leak, and it did not.
- **Every context arm held exactly 2 wiki pages** — `testing/README.md` and
  `testing/conventions.md`, which `keryx init` generates for any repository.
  This run measures the graph and routing index **without a project wiki**. That
  is a stated limitation, not a discovery: vantage-frontend never committed one,
  and no version exists for these revisions.
- Both arms ran identical argv, no MCP servers, and the commit under test was
  unreachable from every tree.
- The run was killed by something external at 26 pairs and resumed. **26 complete
  pairs, zero orphans**; the remaining 24 ran fresh. No task was scored twice and
  none was silently dropped.

## Exploratory, and NOT pre-registered

Split by gold-set size. Proposed at 5 pairs, before these numbers existed, but
still not fixed in advance — post-hoc subgrouping is how data is talked into
saying things, so this decides nothing.

| gold files | n | on | off | gain |
|---|---|---|---|---|
| 1 | 20 | 30.0% | 25.0% | +5.0 |
| 2 | 7 | 78.6% | 71.4% | +7.1 |
| 3 | 7 | 47.6% | 38.1% | +9.5 |
| ≥4 | 16 | 49.8% | 51.8% | **−2.0** |

My stated hypothesis was that context helps more as tasks get harder. It is not
supported: the largest band of hard tasks (≥4 files, n=16) is the only one where
the context arm is worse. The middle bands are small and their spread is not a
pattern I would defend.

## A limitation that weakens the whole measurement

**On 17 of 50 tasks, both arms scored zero.** A third of the sample was beyond
both. Those tasks contribute nothing to distinguishing the arms while dragging
both means down, and they make the benchmark less sensitive than its size
suggests. A future run should either report the solvable subset separately or
filter for tasks at least one arm can do — decided in advance, not after.

## What this establishes

**Does not:** that the graph is useless, that the wiki does not help a person,
or that context is irrelevant to tasks other than file retrieval. This measured
one task type — locating changed files from a description — on two repositories
with two models.

**Does:** keryx's README claims that project-local context makes an agent better
at finding the right files, specifically that `gdgraph affected` beats grepping.
**On this benchmark that claim is unsupported.** The gain is a third of the
threshold set in advance, and it is bought with 16% more context.

The pre-registration committed to the consequence before the result was known:

> It would mean the strongest claim in the README is unsupported, and it should
> be weakened until something supports it.

That is now due.

## Cost

**$120.82 dollar-equivalent** across 100 agent sessions. Not a charge — the
account is a Claude Max subscription with overage disabled, so this is the
API-priced equivalent of subscription usage.

Estimates given beforehand were $45, then $100. Both low.
