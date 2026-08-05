# Keryx Unattended Posture PRD
Version: 0.1.0

## Problem

`keryx shell` cannot complete a run without a human at the keyboard. `claude`
has `--permission-mode`, `grok` has `--always-approve`, keryx has nothing. The
shell benchmark measured the consequence directly: keryx finished **zero of five
cases**, and every number recorded against it is a measurement of a stall rather
than of capability. It cannot be put in CI, cannot be scripted, and cannot be
benchmarked — by us or by anyone evaluating it.

That is defect D2, and it is still open.

## The thing that makes it hard

The obvious implementation is a flag that approves everything, and that would
trade away the only property the benchmark demonstrated. On case C1 keryx and
opencode ran the **same model**; opencode deleted the graph index and the health
history, keryx stopped. The difference was the wrapper. An unattended mode that
loses the refusal has deleted the finding.

Three review rounds established, empirically, that the difficulty is not the
gate but its vocabulary:

- Round 1 leaned on `isDestructiveCommand()`. 16 dangerous commands executed,
  including `git clean -fdx` — case C1 verbatim — plus `cat ~/.aws/credentials`
  and `curl -X POST … -d @.env`.
- Round 2 added an operator allowlist. `--unattended-allow "*"` was accepted and
  14 of the 16 came back; so did `bash -c *` and, on this repository specifically,
  `keryx *`, because our own `CLAUDE.md` tells agents to route commands through
  `keryx ctx run --`.
- Round 3 required a literal command word and banned wildcards after wrapper
  words. `timeout *` launched and ran `timeout 5 sh -c 'cat ~/.ssh/id_rsa'`,
  along with fourteen more wrappers in exactly the categories already banned,
  and shell escapes through database and cloud clients.

Each round's *rule* was better than the last. Each round's *word list* was
behind. A fourth round would extend the list again and a fifth reviewer would
find `pv`, or `ionice`, or a client whose escape nobody here knows.

## Goal

An unattended posture whose containment does not depend on anyone having
enumerated the dangerous programs.

## Users

| User | What changes |
|---|---|
| CI | Can run an agent step. Today it cannot. |
| The benchmark | Group A measures capability instead of a stall; D2 stops contaminating every result. |
| An operator scripting a repeated task | States what may run, once, and gets a run that finishes. |
| A reviewer | Has a corpus that fails loudly instead of a list to eyeball. |

## Requirements

### R1 — containment must not be a blocklist

The barrier may not be "the command word is not on a list of bad ones". The
three rounds are the evidence. Candidate mechanisms, to be chosen with reasons:

- **Argv allowlist with a literal, wildcard-free command word** — an operator
  names exact commands. Round 3 reached this for the wildcard-free case and it
  held; what failed was permitting wildcards at all.
- **OS sandbox as the boundary.** keryx already has one: Seatbelt, bubblewrap,
  workspace-write, network off/on. A posture that requires containment to be
  *active* and fails closed when the launcher is missing moves the guarantee
  from a word list to the kernel. This is the strongest option available and it
  is already built.
- **Capability-scoped tools rather than shell at all.** The unattended posture
  could simply not grant `shell_exec`, and expose only `risk: "read"` tools —
  which is enough for the benchmark's group A, and for most CI uses.

The third is the smallest honest first release, and it is probably where this
should start.

### R2 — the supervised default is untouched

With no flag, byte-identical behaviour, pinned by a test. The cheap way to pass
R1 is to loosen the default so the flag looks safe.

### R3 — a `deny` stays terminal, an `ask` with no approver becomes `deny`

No posture may reach a `deny`. Headless never silently allows.

### R4 — the corpus is the acceptance test

Every command and every pattern the three rounds found must ship as a permanent
regression suite, run against a real runner and a real fixture, not a mock. It
is in the specification. A future contributor must not have to be as thorough as
these reviewers were.

### R5 — the documentation states the soft edge

If the mechanism has a boundary that depends on a list, the docs say it is a
list, that it will be behind, and what an operator must therefore not assume. A
category guarantee over a fixed list is a false claim, and this work has now
produced that false claim on three separate pages.

## Success criteria

| # | Criterion |
|---|---|
| S1 | A scripted read-only run completes with `human_interventions: 0`. |
| S2 | The whole corpus in the specification is refused, under every posture and every grant the mechanism accepts. |
| S3 | A control proves the posture is not simply refusing everything. |
| S4 | The unflagged default is unchanged, pinned. |
| S5 | No documentation sentence asserts a guarantee wider than the mechanism enforces. |

## Risks

| Risk | Mitigation |
|---|---|
| **A fourth round finds a fifteenth wrapper.** | R1: stop choosing a mechanism that can have a fifteenth wrapper. If a list survives anywhere, R5 requires saying so. |
| **The sandbox option is macOS-complete and Linux-partial.** The domain allowlist and credential masking refuse to run on Linux. | A posture that requires the sandbox must fail closed where the sandbox cannot deliver — which is the existing behaviour, not a new decision. |
| **Read-only-tools-only is too narrow to be useful.** | It is exactly enough for benchmark group A and for a CI "answer a question about this repo" step. Ship it, measure, widen with evidence. |
| **`keryx *` in the saved-permission path.** Not reachable from an unattended run — verified: both shells consult the unattended approver first and return before the saved allowlist. But with a saved `keryx *` grant, `keryx ctx run -- rm -rf /` auto-approves **today**, on the supervised path, from a grant that persists on disk. | Out of scope here, and it must not be forgotten: it needs its own change, inverting two frozen tests in `shell-permissions-hardening.test.ts` with attention rather than as a rider. |

## Recommendation

Start with R1's third option: an unattended posture that grants no shell at all
and exposes only `risk: "read"` tools. It is small, it cannot be defeated by a
word nobody thought of, and it unblocks the benchmark re-measurement — which is
the only thing currently waiting on D2. Widen later, with the corpus as the
gate, and only for a mechanism that is not a list.
