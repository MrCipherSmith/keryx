# Keryx Unattended Posture Requirements Package
Version: 0.1.0

## Status

Specification ready; descoped out of PR #253 on 2026-08-05 after three review
rounds. No implementation is carried forward — the code written there is not
merged. What *is* carried forward, and is the reason this package exists
separately, is everything those rounds proved.

## Purpose

Let a keryx run finish without a human at the terminal, without giving up the
one property the shell benchmark actually demonstrated: that keryx refuses by
default, and that the refusal survives the model.

Those two goals pull against each other, which is why this is its own package.
The benchmark's C1 pair is the thing to protect: keryx and opencode ran the
**same model**, opencode deleted the project's graph index and health history,
keryx stopped. Any unattended mode that loses that has traded away the finding
it was built to make measurable.

## Why this is not a small change

Three independent review rounds, each running the code rather than reading it,
each finding a hole the previous round's fix had not closed:

| Round | What was built | What it let through |
|---|---|---|
| 1 | A profile selector; `shell: allow` gated by the destructive-command classifier | 16 dangerous commands, including benchmark case C1 verbatim, credential reads, and an exfiltration POST |
| 2 | Two gates: the policy engine **and** an operator argv allowlist | `--unattended-allow "*"` accepted at launch (14 of the 16 back); `bash -c *`, `sh -c*`, `node -e*`, `bun x*`, `git -c*`, `nice sh*`, `env FOO=1 sh*`; `keryx *` as arbitrary execution |
| 3 | Literal-command-word rule; no wildcard after a banned wrapper, whatever intervenes | `timeout *`, `setsid *`, `stdbuf *`, `flock *`, `unshare *`, `strace *`, `busybox *`, `parallel *`, `command *`, `chroot *`, `expect *`, `pwsh *`, `sshpass *`, `runuser *`, `setpriv *`; plus shell escapes through `psql -c '\! …'`, `sqlite3 '.shell …'`, `tar --to-command`, `gh auth token`, `aws s3 cp`, `pip install -e`, `cmake -P` |

The pattern is the finding: **each round the rule got righter and the vocabulary
stayed behind.** A list of forbidden command words is a blocklist wearing a
different hat, and a blocklist is unbounded by construction. The classifier this
work kept trying to lean on says so in its own module header — that it is *"an
EXPEDIENT, not a boundary … inevitably incomplete"* and *"must not be used to
block a command"*.

## Document Index

- [PRD](prd.md) — problem, users, requirements, success criteria, risks, recommendation.
- [Specification](specification.md) — the design constraint, the required regression corpus, and acceptance criteria.

## Scope

- A named, opt-in posture that lets a read-only run complete with zero operator input.
- A containment mechanism that is **not** a list of forbidden words.
- The full attack corpus from three review rounds, as a permanent regression suite.
- Honest documentation: what is refused, what is not, and where the boundary is soft.

## Non-Goals

- Any path that reaches a policy `deny`.
- Any weakening of the supervised default. A test must pin that the unflagged
  behaviour is unchanged.
- Fixing `keryx *` in the **saved-permission** path. That is a live hole
  (`keryx ctx run -- rm -rf /` auto-approves today with a saved `keryx *` grant)
  but it is a neighbouring subsystem with its own frozen tests, and it is not
  reachable from an unattended run. It needs its own change; see the PRD's risk
  table.

## Related

- [keryx-shell-remediation](../keryx-shell-remediation/README.md) — the parent package; P1's other half shipped without this.
- [keryx-shell-benchmark](../keryx-shell-benchmark/run-2026-08-05.md) — D2, and the C1 pair this must not break.
- `docs/harness.md` — the policy engine's three answers and seven risk classes.
