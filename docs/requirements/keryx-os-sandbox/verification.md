# OS Sandbox — Verification Record
Version: 1.0.0

What was actually proven, by what evidence, and — equally important — what was
not proven. Claims here are limited to what was observed.

## Method

Every boundary claim is verified as a **pair**: the denied case must fail *and*
the corresponding allowed case must succeed. A sandbox that fails to launch
blocks everything, which is indistinguishable from perfect containment when only
the denied half is checked. One-sided results are recorded as inconclusive, not
as passes.

## Automated coverage

| Area | Test | Gate |
|---|---|---|
| Profile projection from policy | `profile.test.ts` | always |
| Seatbelt profile text | `seatbelt.test.ts` | always |
| bwrap argv, including mask-target classification | `bwrap.test.ts` | always |
| Platform dispatch + unsupported-posture refusal | `wrap.test.ts` | always |
| Launcher detection / adapter resolution | `detect.test.ts` | always |
| Allowlist matching, masking, proxy behaviour | `proxy.test.ts`, `proxy-tls.test.ts` | always |
| Run CA + leaf issuance | `tls-ca.test.ts` | always |
| Sentinel injection, CA-trust env, decision delivery | `network-run.test.ts` | always |
| Bundled-build worker resolution | `worker-resolution.test.ts` | always |
| FS containment + network-off on a real kernel | `sandbox.smoke.test.ts` | `KERYX_ALLOW_REAL_SUBPROCESS=1` |
| Restricted network through the real CLI | `harness-exec-restricted.smoke.test.ts` | same |
| Linux fail-closed refusal | same file, Linux-only block | same |

CI runs two jobs: the standard `check` job (typecheck, full suite, standard
checks) and a `linux-sandbox` job on `ubuntu-latest` that installs bubblewrap and
runs the gated smokes with a real kernel.

## Verified — macOS (Seatbelt)

| Claim | Evidence |
|---|---|
| Write inside the workspace succeeds; write outside is denied | Live smoke, both halves observed differing. |
| Network off blocks the internet | Sandboxed run failed; the same command with containment disabled succeeded (control). |
| Allowlisted host reachable, non-allowlisted host not | Live against the real internet: `example.com` → `allowed:true`; `example.org` → `allowed:false`. |
| A denied host is reported, not merely blocked | Both runs exited `0`; only `network.decisions` distinguished them. This is why the field exists. |
| Wildcards cover the apex | `*.github.com` matched both `github.com` and `api.github.com`. |
| A masked credential never enters the contained process | The contained process read `keryx-sentinel-<uuid>` from its own environment; the real value never appeared. |
| A masked credential reaches the real upstream | Verified against a live echo service, which received the real value while the sandbox held only the sentinel. |
| Masking is rejected without TLS termination | The guard fired with an explicit message; nothing spawned. |
| Go tools fail under TLS termination | `kubectl` produced a certificate-trust error under `--tls-terminate`, with a clean control run without it. |

## Verified — Linux (bubblewrap, CI)

| Claim | Evidence |
|---|---|
| bubblewrap can contain a process on the runner | Dedicated sanity step, so a broken launcher cannot masquerade as containment. |
| Write inside succeeds; write outside is denied | `sandbox.smoke.test.ts`, both halves. |
| Network off blocks the internet | Same smoke, with an unsandboxed control. |
| A restricted-network run fails closed | Asserted: `outcome.kind === "blocked"` with a reason naming the Linux limitation. Never silently unrestricted. |

## Not verified

| Item | Status |
|---|---|
| Restricted network, masking, TLS termination on Linux | **Not implemented.** Fails closed; the refusal is what is tested. |
| Any capability on Windows | No launcher. Contained runs are refused. |
| Landlock/seccomp hardening | Not implemented. Linux containment currently rests on mount namespaces plus `--unshare-net`. |
| Behaviour under an adversarial process actively trying to escape | Not attempted. The boundary is tested for correct enforcement, not against a determined attacker. |
| Manual runbook execution on a real (non-CI) Linux host | Pending. The [runbook](../../verification/linux-sandbox-verification.md) exists; its expected outputs on Linux are predictions rehearsed on macOS, not recordings. |

## Defects found and fixed during verification

| Defect | Why it mattered |
|---|---|
| bwrap masked every secret path unconditionally; mounting over a non-existent path aborts the sandbox with `Can't mkdir …: Read-only file system` because `/` is read-only. | The Linux sandbox failed to start on any host lacking `~/.aws`, `~/.gnupg` or `~/.netrc` — i.e. most hosts. Found only because CI exercised a real kernel. |
| A bundled build could not resolve the proxy worker (`ModuleNotFound … proxy-worker.ts`). | Every restricted-network run failed in a built `keryx`. Fixed with a separate build entry plus a `.ts`→`.js` fallback, with a regression test confirmed to fail when the built file is removed. |
| A missing `-- <path>` reached the launcher as an empty command path and surfaced as an opaque exit `71`. | Misdiagnosed as a sandbox failure during this very verification. Now reported explicitly. |
| Allow/deny rulings were enforced but never surfaced. | A denied host returned `exitCode: 0`, indistinguishable from success. |

## Reproducing

```bash
bun run typecheck
bun test --timeout 30000

KERYX_ALLOW_REAL_SUBPROCESS=1 bun test \
  src/harness/process/sandbox/sandbox.smoke.test.ts \
  src/harness/process/real-process-adapter.smoke.test.ts \
  src/commands/harness-exec.smoke.test.ts \
  src/commands/harness-exec-restricted.smoke.test.ts \
  --timeout 30000
```

Read the test **names** in the gated run. A skipped block also prints `0 fail`,
and that is not a pass.

For end-to-end validation on a real host, follow the
[Linux verification runbook](../../verification/linux-sandbox-verification.md).
