# OS Sandbox — Operator Guide (human)
Version: 1.0.0

This guide is for a person running keryx. It answers: which posture do I want,
what will I see when something is blocked, and how do I tell a real denial from
a broken setup.

You do not need to read the specification to use this. If you want the exact
data shapes, that is [specification.md](specification.md).

---

## 1. The one-paragraph mental model

Keryx already asks *whether* a command may run — via the policy engine, the
command guard, and (in interactive mode) your own approval. The OS sandbox is a
different thing: it constrains what the process can do **after** it starts, using
the operating system's own enforcement. Approving a command no longer means
handing it your whole machine.

Two paths, two defaults:

- **`keryx harness exec`** — contained **by default**. No human sees each command
  here, so containment is not optional.
- **The agent's shell tool** — **off by default**. You already approve every
  command, and forcing containment breaks tools that write to `~/.bun`,
  `~/.npm`, `~/.cargo`. Turn it on when you want it.

---

## 2. Which posture do I want?

| Situation | What to do |
|---|---|
| Running something automated and you have no strong opinion | Nothing. `harness exec` is already workspace-write + network off. |
| The command needs to write outside the project (a global cache) | Add that path: `KERYX_SANDBOX_ALLOW_WRITE=~/.bun` (agent shell), or run it in the workspace. |
| The command needs the internet, but only one service | `--allowed-domains api.example.com`. **macOS only** — see §6. |
| The command needs a token for that service, and you would rather it never hold the token | `--mask-env TOKEN@api.example.com --tls-terminate`. **macOS only.** |
| You want the agent's shell contained too | `export KERYX_SANDBOX_SHELL=workspace` (or `strict` to also cut the network). |
| Something is broken and you need to rule the sandbox out | `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1`, once, deliberately. Do not leave it set. |

---

## 3. Reading the output

`keryx harness exec` prints exactly one JSON object. It never prints the
contained command's own output — a contained command can print secrets, so the
CLI reports status, not text.

The three things worth looking at:

**`outcome.kind`** — `completed` means the process ran to the end. It says
nothing about success; check `exitCode` for that. `blocked` means keryx refused
before running anything, and `outcome.reason` says why.

**`outcome.exitCode`** — the contained process's real exit status.

**`network`** — present only when you used a domain allowlist:

```json
"network": {
  "restricted": true,
  "allowedDomains": ["example.com"],
  "decisions": [{ "host": "example.org", "allowed": false, "count": 1 }]
}
```

> **Read `decisions`, not the exit code, to learn what the allowlist did.**
> When the allowlist denies a host, the proxy answers `403`. `curl` considers a
> `403` a perfectly successful HTTP transaction and exits **0**. Without the
> `decisions` list, a blocked request looks exactly like a successful one.

---

## 4. What a denial actually looks like

### A blocked write

The command runs and fails on its own terms — `touch` reports permission denied,
the file is simply not there. There is no keryx-level error. Containment is the
kernel refusing the syscall, not keryx intercepting it.

### A blocked network connection

With network **off**, DNS and sockets fail inside the process. `curl` exits
non-zero (commonly `6`, could not resolve host) and writes nothing.

With an **allowlist**, a denied host gets a `403` body reading
`blocked by keryx sandbox network allowlist`. As noted above, the exit code will
often be `0`.

### A refused run

```json
{"outcome":{"kind":"blocked","reason":"OS sandbox launcher unavailable; failing closed ..."}}
```

This is keryx refusing to start the process at all, because it could not
guarantee containment. It is deliberate: the alternative would be running your
command with no boundary and not telling you.

---

## 5. The trap: a broken sandbox looks like a perfect one

This is the single most important thing in this guide.

A sandbox that fails to launch blocks **everything**. Every write fails, every
connection fails. That is indistinguishable from flawless containment if you only
look at the thing you expected to be blocked.

**So never test a boundary with one command.** Always test the pair:

- Filesystem: the write outside must fail **and** the write inside must succeed.
  If both fail, the sandbox is broken, not strict.
- Network: the sandboxed run must fail **and** the same command with
  `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` must succeed. If both fail, your host has
  no network and you have proven nothing.

The [Linux verification runbook](../../verification/linux-sandbox-verification.md)
is built entirely around this rule, and names the false pass for every check.

---

## 6. What does not work on Linux

Filesystem containment and network-off work on both macOS and Linux.

**The domain allowlist, credential masking and TLS termination are macOS-only.**
On Linux such a run is refused:

```
"kind":"blocked","reason":"... network=restricted is not yet enforced on Linux ..."
```

The reason is technical: this needs "deny all network except this one loopback
socket". macOS Seatbelt says that directly; bubblewrap cannot — `--unshare-net`
gives the process its own private loopback, which is not the one the proxy is
listening on. Making it work needs a network namespace plus a relay, and that is
not built.

Refusing is the correct behaviour. Quietly turning "only this one domain" into
"the entire internet" would be far worse than not running.

---

## 7. What does not work under TLS termination

`--tls-terminate` makes keryx a deliberate man-in-the-middle for allowlisted
HTTPS, so it can rewrite requests (which is how credential masking works over
HTTPS at all).

Trust in that MITM certificate is handed to the contained process through
environment variables (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`,
`REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`) — never by installing anything into your
system trust store, because a per-run certificate must not become a machine-wide
trust decision.

**Go ignores those variables.** So `gh`, `terraform`, `kubectl` and `docker` fail
with certificate errors under `--tls-terminate`. That is expected. If you need
one of those tools, use `--allowed-domains` **without** `--tls-terminate`; you
keep the domain restriction and lose HTTPS credential masking.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no command. Put the program after a --` | Flags given but no `-- <path>`. | Add the `--` terminator and an absolute path. |
| Everything fails, including things that should work | The sandbox is not launching. | macOS: check `sandbox-exec` exists. Linux: `bwrap --version`, and on Ubuntu 23.10+ `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. |
| `blocked: OS sandbox launcher unavailable` | No launcher installed. | Linux: `sudo apt-get install -y bubblewrap`. Or accept the refusal — it is protecting you. |
| `--mask-env requires --tls-terminate` | Masking over HTTPS cannot work without termination. | Add `--tls-terminate`, or drop the mask. |
| A Go tool reports `x509: certificate signed by unknown authority` | `--tls-terminate` is on. | Drop `--tls-terminate` (see §7). |
| Only one env var reached the command, named `PATH,HOME` | `--allow-env` takes one key. | Use `--allow-env PATH --allow-env HOME`. |
| The whole run is refused on Linux with a restricted network | Expected — see §6. | Use network off/on, or run on macOS. |

---

## 9. Verifying it yourself

To actually prove the sandbox works on a machine you control, follow the
[Linux verification runbook](../../verification/linux-sandbox-verification.md).
It takes about fifteen minutes and every step tells you both what a pass looks
like and what a false pass looks like.

Quick confidence check, any platform:

```bash
KERYX_ALLOW_REAL_SUBPROCESS=1 bun test \
  src/harness/process/sandbox/sandbox.smoke.test.ts --timeout 30000
```

Read the **test names** in the output, not just the pass count — if the block was
skipped (no launcher, missing flag) you will see `0 fail` with no tests run,
which is not the same as passing.
