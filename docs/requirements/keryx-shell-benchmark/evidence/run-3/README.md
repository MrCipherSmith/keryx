# Run 3 — what actually ran, and what stopped it

Started 2026-08-07T21:28Z against the run-3 runbook. **Stopped after five
minutes**, deliberately, with one case of one group complete. Four of the six
legs are unavailable for reasons outside the benchmark, and the two that remain
are both Claude.

Read this before reading any row in this directory.

## Leg availability

| Leg | State | Evidence |
|---|---|---|
| `keryx-deepseek` — the subject | **provider out of credit** | `blocked/A3-keryx-deepseek-insufficient-balance.txt` |
| `opencode-deepseek` — the clean pair | same account, same wall | not run |
| `baseline-grok` | **weekly quota exhausted** | `blocked/A1-baseline-grok-weekly-limit/` |
| `naked-grok` | same account, same wall | `blocked/A1-naked-grok-weekly-limit/` |
| `baseline-claude` | ran | `A1-baseline-claude/` |
| `naked-claude` | ran | `A1-naked-claude/` |

The two deepseek legs are the subject and its control. **E3 cannot say anything
about keryx until they run**, and nothing in this directory should be quoted as
if it could. Run 2's evidence contains no such failure — the accounts ran out
between the two runs.

Everything under `blocked/` is a non-result kept as evidence of the block. It is
outside the collector's tree on purpose: a bundle there must never be graded.

## What is measured, and trustworthy

### P1 — closed, verified without an agent

P1 lives in the graph, not in model behaviour, so it can be re-measured
deterministically. `helyx` at the pinned `bfad745b`, one query, two builds of
keryx — the merge-base (pre-fix) and this branch's HEAD (post-fix):

| | Cycles reported | Through a dynamic-import edge |
|---|---|---|
| Before | 8 | 5, all via `bot/commands/menu.ts` |
| After | 7 | none |

The graph is identical either way — 267 nodes, 656 edges. What changed is
classification: `await import()` is no longer counted as a load-order edge.

8 → 7 rather than 8 → 3 because cycles previously reported *via* the menu path
now surface directly: `bot/commands/memory.ts` and `bot/handlers.ts` import each
other statically. That is a real cycle the old output attributed to the wrong
edges. Both the old number and the tempting new one would be wrong to quote
without this sentence.

This independently reproduces what commit `2980cb40` claims, on the target
rather than on a fixture.

### P3 — not measured, and cannot be

P3 was found by comparing `keryx-deepseek` with `opencode-deepseek` on the same
model. Both legs are down. A Claude-only regression would measure a different
product.

### E3/A1 — one case, two legs, and an unflattering comparison

The oracle is in [oracle-keryx.md](oracle-keryx.md), computed before any leg ran.

`config.ts` **does not exist in this repository** — ten files end in that name.
The prompt resolved to exactly one file on `helyx`; here it resolves to none, so
A1 measures blast-radius computation *and* ambiguity handling at once. The
prompt is unchanged per runbook §8; the ambiguity is a property of the target.

| Leg | Time | What it did |
|---|---|---|
| `baseline-claude` | 60.6 s | Used the graph, found the six exact `config.ts` files, listed direct-dependent counts, and asked which one was meant. Did not answer. |
| `naked-claude` | 132.7 s | No graph, no routing block. Broke every candidate down **per export**, separated transitive from direct, then asked which one. |

Both refused to guess, which the grading key scores as correct. But the leg
**without** the workspace produced the richer answer, and named two risks no
graph holds: `render*Config` writes config files consumed by `keryx init` and
`keryx update`, so a signature change there breaks on-disk configs in existing
installs; and `security/config.ts` hashes its own shape, so changing it
invalidates checksums already written to disk.

Twice the wall-clock, more of the answer. This is run 2's M2 — "the graph bought
speed and completeness, not correctness" — stated more sharply, and on a target
the graph was built for.

Two legs, both Claude, is not a finding about keryx. It is recorded so the
comparison is not re-derived from scratch when the full set runs.

## M8 — the harness records a quota wall as a result

New, and it fired twice within an hour.

`drive.py` refuses to record a run whose transcript is under 40 characters. That
guard was written for an empty pane. It does not catch a provider that answers:

- `[error] Insufficient Balance` → recorded `DONE`, 14.0 s
- `You hit your weekly limit.` → recorded `DONE`, 32.6 s

Both produce a plausible transcript, a screenshot, a `meta.json` and a timing —
everything a reader uses to tell a result from a failure. A report built on
`status.tsv` alone would treat four dead legs as four measurements.

**Fixed, 2026-08-07.** `drive.py` now matches known provider phrases
(`PROVIDER_WALLS`) against the transcript and raises, keeping a
`provider-wall` frame so the wall is read off evidence rather than guessed.
`FAILED` is data; `DONE` with a time is a fabrication.

Matched as exact provider phrases, not as words like "quota" or "rate limit" —
an agent reading code can legitimately write those, and failing a run for
saying them would trade one wrong verdict for another. The asymmetry is
deliberate: a false `FAILED` costs a human one glance at a log.

Verified end to end on the leg that produced the defect. The same
`A1 baseline-grok` that was `DONE 32.6s` an hour earlier now reads:

```
A1  FAILED  baseline-grok  21:41:15  baseline-grok hit a provider wall on A1
('You hit your weekly limit') — refusing to record a run the provider refused
```

`harness/drive-selftest.py` pins the guard to the real transcripts in
`blocked/`, and checks that a genuine answer and prose *about* rate limits are
not flagged. 8 checks, all passing.

## M9 — the prepared workspace was never actually there

Found while executing, not while reviewing. Neither `base` nor `base-keryx`
exists on disk, and `make_worktree` copied it under `if os.path.isdir(src)` — a
**silent** skip. Every leg in this run therefore ran without a prepared
workspace and without `node_modules`, and nothing in any bundle said so.

Survivable, because the graph is built in-worktree at the pinned commit and the
build is checked. Not acceptable as an invisible condition: a leg that *could
not* run the tests must be distinguishable from one that chose not to.

**Fixed, 2026-08-07.** `make_worktree` returns what it prepared;
`meta.json` now carries `preparedWorkspace`, `baseDir`, `nodeModules` and, for
naked legs, `stripped`. A missing base also prints to stderr rather than
passing in silence. This is the same class of defect as run 1's empty
workspace, and the runbook's own §5 note — "a missing prerequisite that skips
is how this went unnoticed the first time" — describes it exactly.

## P5 — `sandbox status` reported a boundary that was not there

Product finding, surfaced while unblocking C4 rather than by a case.

`bubblewrap` was installed to satisfy runbook §2 check 4 (decision D1). The
check went green — `harness exec` stopped answering `blocked` — and every
contained run then failed with `exitCode 1`:

```
bwrap: setting up uid map: Permission denied
```

Ubuntu 23.10+ sets `kernel.apparmor_restrict_unprivileged_userns = 1`, and
bubblewrap builds its boundary out of exactly those namespaces. Meanwhile
`keryx sandbox status` and `scripts/install.sh:62` both decided from
`command -v bwrap` and printed:

```
Filesystem containment and network-off are available.
```

Before the install that line was accidentally right ("no launcher" is true
either way). After it, it was a **false green** — the command added by flow 142
to stop keryx claiming untested capability was itself claiming untested
capability. This is the most serious finding of run 3, and it affects every
user on a current Ubuntu, not just this benchmark.

Remediated on this host with an AppArmor profile scoped to `/usr/bin/bwrap`
(`userns,`, the shape Ubuntu ships for ~40 applications); `harness exec` then
returns `exitCode 0` and precondition 4 is genuinely green. The sysctl route was
rejected by the owner and is now warned against in the docs that recommended it.

Design consequence recorded in **ADR-0010, "Linux containment without
privilege"** (`docs/decisions/keryx-harness/`, written on the feature branch
that carries the fix, so it is not linked from here): Landlock first — no
privilege, no namespace, measured ABI 4 on this host — bubblewrap as fallback,
container as an opt-in profile; and capability reporting becomes a probe rather
than a lookup.

## To resume

1. Top up the DeepSeek account — this unblocks the subject and its control.
2. Grok's weekly quota resets on its own; check before batching.
3. ~~Fix M8 first~~ — done, with M9. Run `python3 harness/drive-selftest.py`
   before the batch; a walled leg now fails loudly instead of scoring.
4. Build `harness/base-keryx` (and `base`) if a leg needs `node_modules` — M9
   makes its absence visible, it does not create it. Group A's graph questions
   do not need it; anything asking to run tests does.
5. `bubblewrap` still needs a human (`sudo apt-get install -y bubblewrap`); C4
   stays out until then, per D1.
