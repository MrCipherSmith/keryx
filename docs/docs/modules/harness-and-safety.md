# Harness and safety

The harness is the execution core under every Keryx agent turn: a policy engine that answers allow, ask or deny for each action, an operating-system sandbox beneath it, lifecycle hooks, record and replay, and a security scanner for secrets and unsafe content. It exists so that an agent's power is bounded by rules you can read and by the kernel, not by the agent's own good behaviour.

## When to use it

- You want to know exactly what an agent may do, and which actions stop to ask you first.
- You need to run an untrusted script with no network, a confined file system, or a masked credential.
- You want to check that a recorded run still matches the fixture you saved from it.
- You want a command to run before or after agent tool calls, such as a secret check on output.
- You want to scan a path, a prompt or an agent configuration for secrets and injection patterns.

## Quick example

These commands run in any directory. `sandbox status` is a report and always exits 0.

```bash
keryx sandbox status
keryx harness exec -- /bin/echo hi
keryx harness exec --allow-real-subprocess -- /bin/echo hi
keryx security scan .env
```

```text
keryx sandbox status
Platform: darwin
Launcher: available (Seatbelt (sandbox-exec) at /usr/bin/sandbox-exec)
Capability matrix (this platform):
  - Filesystem containment: available.
  - Network OFF: available.
  - Domain allowlist (--allowed-domains): available.
  - Credential masking (--mask-env): available.
…
keryx harness exec refuses to spawn a real subprocess without --allow-real-subprocess (or KERYX_ALLOW_REAL_SUBPROCESS=1); no process was started.
{"outcome":{"kind":"completed","exitCode":0},"receipt":{…},"sandbox":{"launcher":"seatbelt"}}
keryx security scan
  .env

  gate: FAIL
  action: block
  findings: 1
    ✗ secret/secrets.aws-access-key → block (line 1)
  coverage: complete (1 scanned)
```

The scan example assumes a `.env` file containing a key-shaped value. `harness exec` refuses to start a real process until you opt in, so a typo cannot launch one.

## How it works

**Policy engine.** Every action is classified into one of seven risk classes (read, write, shell, network, credential, delegate, destructive) and answered `allow`, `ask` or `deny`, with path and command rules underneath. Shell and destructive actions are denied by default. A hard deny is final, an approval authorizes exactly one action, and an `ask` with nobody to answer becomes a `deny`, so a headless run never silently allows. In the interactive shell a session-level approval mode (`ask`, `trust`, `auto`) decides whether the approval is requested at all; see [Choose an approval mode](../guides/permission-modes.md). That layer never reaches `harness run`, `harness exec` or `keryx serve`.

**OS sandbox.** Below the policy engine, contained runs go through the kernel: Seatbelt on macOS, bubblewrap (`bwrap` on `PATH`) on Linux. A missing launcher or a posture the platform cannot enforce fails closed instead of quietly doing less.

| Capability | macOS | Linux |
|---|---|---|
| Filesystem containment | yes | yes |
| Network off | yes | yes |
| Domain allowlist (`--allowed-domains`) | yes | refuses to run |
| Credential masking (`--mask-env`), TLS termination | yes | refuses to run |

Windows has no sandbox launcher; contained runs fail closed there. See [Limitations](../limitations.md#platform-support).

**`harness run`, `exec`, `replay`.** `keryx harness run --provider <name> --model <id> "<prompt>"` runs one provider turn and prints structured events; add `--record <path>` to write a replayable record. Today it is a single text turn: tools run in the interactive shell, not here. `keryx harness exec [--allow-env KEY]… -- <path> [args…]` runs one process under the sandbox, needs `--allow-real-subprocess`, and passes through only the environment variables you name. `keryx harness replay --record <path> [--fixture <path>] [--write-fixture <path>]` checks a record against a fixture and names the field that diverged. It re-executes nothing and contacts no provider, so it is an integrity check, not a regression test of model behaviour. `harness extension --spec` and `harness wave --spec` run declared extensions and multi-agent waves.

**Lifecycle hooks.** `keryx hooks list` shows the merged registrations. Five built-ins are on by default: a compact-context guard, input and output security checks, a learning observer and impact evidence. You add your own in `.metaproject/hooks.json` (project) or `~/.keryx/hooks.json` (user). Project command hooks run only after `keryx hooks trust`, and any edit to the file revokes that trust. A project file can never disable a built-in gate; only `keryx hooks disable <id> --user --acknowledge-gate-risk` can, for you alone. `keryx hooks test <id>` runs one hook against a synthetic payload. See [Lifecycle hooks](../hooks.md).

**Security scanning.** `keryx security` scans with deterministic rules plus entropy analysis, with no model and no network. `scan <path>` reports findings and a pass or fail gate; `check-input` and `check-output` guard text going into or out of an agent; `redact` writes a redacted copy; `audit-harness` audits an agent configuration; `scan-mcp` checks an MCP server manifest. The default mode is advisory, with policies that block secrets, redact personal data and require approval for prompt-injection patterns. See [Security model](../concepts/security-model.md).

## Common tasks

| I want to… | Command or page |
|---|---|
| See which sandbox features this machine has | `keryx sandbox status` |
| Run a script with network off | `keryx harness exec --allow-real-subprocess -- <path>` |
| Allow one domain from the sandbox (macOS) | `keryx harness exec --allow-real-subprocess --allowed-domains <host> -- <path>` |
| Record a run and check it later | `keryx harness run … --record run.json`, then `keryx harness replay --record run.json` |
| Add a command hook | edit `.metaproject/hooks.json`, then `keryx hooks validate` and `keryx hooks trust` |
| Scan a path for secrets | `keryx security scan <path>` |
| Run an agent without giving it my machine | [Run an agent without your machine](../guides/contain-an-agent.md) |

## Status

Stable: the policy engine, the sandbox where a launcher exists, `harness run`, `exec` and `replay`, hooks and the security scanner. Linux has no domain allowlist or credential masking. Replay validates records and does not re-execute them. See [Project status](../project/status.md).

## Reference

- CLI: [harness](../cli-reference.md#harness), [sandbox](../cli-reference.md#sandbox), [hooks](../cli-reference.md#hooks), [security](../cli-reference.md#security)
- Concepts: [The agent harness](../harness.md), [Security model](../concepts/security-model.md)
- Guides: [Choose an approval mode](../guides/permission-modes.md), [Run an agent without your machine](../guides/contain-an-agent.md)
