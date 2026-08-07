# A Linux install has no OS containment and nothing says so

Benchmark finding **P4**. Full write-up:
[specification.md](../../../docs/requirements/keryx-shell-remediation-v2/specification.md#p4).

## Problem

```
$ keryx harness exec --allow-real-subprocess --allowed-domains example.com -- /bin/echo hi
{"outcome":{"kind":"blocked","reason":"Contained spawn failed: OS sandbox launcher
 unavailable on linux … failing closed (install bubblewrap on Linux …)"}}
```

`scripts/install.sh` is 144 lines and mentions `bwrap`, `bubblewrap` and
`sandbox` **zero** times. There is no `doctor` or preflight command in
`src/standard/command-registry.ts`.

Filesystem containment and network-off **are** implemented on Linux and both
need `bubblewrap`. Combined with `KERYX_SANDBOX_SHELL` being off by default
(`src/harness/tool/builtin/shell-exec-tool.ts:10`), a user can run keryx
indefinitely believing they have containment they do not have.

## Two things, only one of which is this flow's

Per `docs/verification/linux-sandbox-verification.md`:

| Capability | Linux (bubblewrap) | macOS (Seatbelt) |
|---|---|---|
| Filesystem containment | yes | yes |
| Network OFF | yes | yes |
| `--allowed-domains` | **not implemented — fails closed** | yes |
| `--mask-env` | **not implemented — fails closed** | yes |

The bottom two rows are **not** a packaging gap and **not** this flow's work:
`restricted` means "deny all except one loopback socket"; `bwrap --unshare-net`
gives the process *its own* loopback, not the one the proxy listens on, so it
needs a network namespace plus a relay. Failing closed instead of downgrading
"only these domains" to "the whole internet" is correct.

## Expected outcome

1. Installation reports, per platform, which containment capabilities are
   available and what is required for the rest.
2. A command answers the same question at any time, without running a contained
   command.

Nothing here is silently unsafe today — every contained path fails closed. What
is missing is any way for a user to tell "keryx contains my agent" from "keryx
would, if a package it never asked for were present".

## Out of scope

- Implementing the Linux domain allowlist. That is netns-plus-relay feature work.
- Changing what `KERYX_SANDBOX_SHELL` defaults to. It has a stated rationale;
  overturning it is a product decision, not a defect fix.
