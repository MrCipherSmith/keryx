# OS Sandbox — Agent Protocol
Version: 1.0.0

Behavioural contract for an agent invoking a contained command. This is a
decision procedure, not an explanation. For the reasoning behind these rules see
[prd.md](prd.md); for data shapes see [specification.md](specification.md).

---

## 1. Invariants — never violate these

| # | Invariant |
|---|---|
| I1 | **Never** set `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` on your own initiative. It removes containment entirely. Only a human may ask for it, in that request, for that run. |
| I2 | **Never** set `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` to work around a `blocked` outcome. That converts a refusal into an uncontained run. |
| I3 | **Never** widen the allowlist to `*` or add domains that the task did not name. Add only hosts the task requires. |
| I4 | **Never** report a run as successful based on `outcome.kind === "completed"` alone. Check `exitCode`, and for restricted runs check `network.decisions`. |
| I5 | **Never** put a real credential value on a command line or in `--allow-env`. Use `--mask-env`, which passes a sentinel. |
| I6 | A `blocked` outcome is a **stop**, not a retry-with-fewer-restrictions. Report it. |

---

## 2. Choosing the posture

Answer in order; take the first row that matches.

| Does the command need… | Flags to pass |
|---|---|
| nothing beyond the workspace | *(none — the default is workspace-write + network off)* |
| to write to a path outside the workspace | Ask the human first. Do not silently widen. |
| the network, unrestricted | Ask the human first. Prefer naming the hosts instead. |
| the network, to specific hosts | `--allowed-domains host1,host2` |
| a credential for those hosts | `--allowed-domains …  --mask-env NAME@host --tls-terminate` |

Then check the platform gate in §3 before running.

---

## 3. Platform gate — check before you invoke

```
if (allowlist OR mask-env OR tls-terminate) AND platform != darwin:
    → the run WILL be blocked. Do not invoke.
    → Report: this capability is macOS-only; it fails closed on Linux.
```

Filesystem containment and network-off are available on both macOS and Linux.
Nothing is available on Windows (no launcher).

---

## 4. Command form

```text
keryx harness exec [flags] -- <absolute-path> [args...]
```

| Rule | Detail |
|---|---|
| `--` is mandatory | Without it the command path is empty and the run is refused. |
| The program must be an absolute path | `/usr/bin/curl`, not `curl`. |
| No shell metacharacters | The structural guard rejects them. `sh -c 'a > b'` is **blocked**. Put redirection inside a helper script and execute the script. |
| `--allow-env` takes ONE key | Repeat the flag. `--allow-env PATH,HOME` forwards one variable literally named `PATH,HOME`. |
| Contained stdout is not returned | To observe output, have the command write into the workspace and read that file afterwards. |

---

## 5. Reading the result

Parse the **last line** of stdout as JSON.

```ts
{
  outcome: { kind: "completed" | "blocked" | "timeout" | "output-overflow" | "cancelled",
             exitCode?: number, reason?: string },
  receipt?: {...}, evidenceRefs?: string[],
  network?: { restricted: true, allowedDomains: string[],
              decisions: { host: string, allowed: boolean, count: number }[] }
}
```

Decision table:

| Observed | Meaning | Do |
|---|---|---|
| `kind: "completed"`, `exitCode: 0`, no `network` | Ran and succeeded. | Proceed. |
| `kind: "completed"`, `exitCode != 0` | Ran and failed on its own terms. | Report the exit code. Do not blame the sandbox without evidence. |
| `kind: "blocked"` | keryx refused before running. `reason` says why. | **Stop.** Report the reason verbatim. Do not retry with containment weakened. |
| `kind: "timeout"` | Deadline hit. | Report; consider `--max-runtime-ms` only if the task justifies it. |
| `network.decisions` contains `allowed: false` | The allowlist denied a host. | Report which host. This is very likely the real cause of any downstream failure. |
| `network.decisions` is `[]` on a restricted run | Nothing reached the proxy. | The command never attempted a connection — or never started. Check `exitCode` before concluding anything. |

> **Critical:** a denied host produces a `403` from the proxy, and `curl` exits
> **0** on a `403`. `exitCode: 0` on a restricted run does **not** mean the
> request succeeded. `network.decisions` is the only reliable signal.

---

## 6. Credential masking contract

```text
--mask-env NAME@host1,host2 --tls-terminate
```

- keryx reads the real value of `NAME` from its own environment.
- The contained process receives `NAME=keryx-sentinel-<uuid>`.
- The proxy substitutes the real value in request headers, **only** for hosts
  matching `host1,host2`.
- `--mask-env` without `--tls-terminate` is rejected — the sentinel would leave
  the sandbox unchanged and authentication would fail confusingly.
- Do not add `NAME` to `--allow-env`. Masking injects the variable itself; adding
  it separately would forward the real value.

Go-based tools (`gh`, `terraform`, `kubectl`, `docker`) fail TLS under
`--tls-terminate` because Go ignores the CA-trust environment variables. If the
task needs one of those tools, use `--allowed-domains` without termination and
state that HTTPS credential masking is unavailable for it.

---

## 7. Reporting to a human

State, in this order:

1. What ran, and its exit code.
2. For a restricted run: which hosts were allowed and which were denied.
3. Any `blocked` reason, quoted verbatim.
4. Anything you could **not** determine, named as undetermined.

Never characterise a boundary as verified unless you observed the **pair**: the
denied case failing *and* the allowed case succeeding. A sandbox that fails to
launch blocks everything and is otherwise indistinguishable from one that works
perfectly. One-sided evidence is not evidence.

---

## 8. Agent shell (`shell_exec`) — separate surface

The interactive agent's shell tool is **not** contained by default. Every command
there passes through a human approval gate first.

| `KERYX_SANDBOX_SHELL` | Filesystem | Network |
|---|---|---|
| unset / `off` | uncontained | host |
| `workspace` \| `1` \| `on` | workspace-write | on |
| `strict` | workspace-write | off |

`KERYX_SANDBOX_ALLOW_WRITE=path1,path2` adds writable roots (`~/` expands).
`KERYX_SANDBOX_ALLOWED_DOMAINS` overrides the mode's network with `restricted`.

Do not change these variables on your own initiative — they are the operator's
choice, and per I1/I2 you must not weaken containment.

---

## 9. Escalation

Ask the human, rather than working around it, when:

- The command needs to write outside the workspace.
- The command needs unrestricted network.
- A run is `blocked` and the task cannot proceed without weakening containment.
- A capability you need is macOS-only and you are on Linux.

Present the exact restriction and the exact change you would need. Let them
decide.
