# Linux sandbox verification runbook

**Purpose.** Prove, on a real Linux host, that the keryx OS sandbox actually
contains a process: it cannot write outside the workspace, it cannot reach the
network when the network is off, it reaches only allowlisted hosts when the
network is restricted, and a masked credential never enters the contained
process.

**Why by hand.** CI covers two assertions on `ubuntu-latest`. This runbook covers
the rest, on a host you control, against the real internet.

This document is self-contained. It assumes nothing from any chat session.

**One caveat about the expected outputs below.** Every command here was rehearsed
end-to-end on macOS, where the launcher is Seatbelt; on Linux it is bubblewrap.
The CLI contract is identical and the expected results should match, but they are
predictions for Linux, not recordings. If something differs, trust what you
observe and report it — a mismatch here is a finding, not your mistake.

## Scope on Linux — read this before §6

| Capability | Linux (bubblewrap) | macOS (Seatbelt) |
|------------|--------------------|------------------|
| Filesystem containment (§4) | **yes** | yes |
| Network OFF (§5) | **yes** | yes |
| Domain allowlist, `--allowed-domains` (§6) | **not implemented — fails closed** | yes |
| Credential masking, `--mask-env` (§7) | **not implemented — fails closed** | yes |

`network: restricted` needs "deny all network except this one loopback socket".
Seatbelt can express that directly; bubblewrap cannot — `--unshare-net` gives the
process its *own* loopback, which is not the one the proxy listens on, so
reaching it requires a network namespace plus a relay. That work is not done.

Rather than silently downgrading "only these domains" to "the whole internet",
a restricted run on Linux **refuses to start**. On Linux, §6 and §7 therefore
verify *that refusal* — which is the security-relevant behaviour today — and
their full functionality is verifiable on macOS only.

---

## 0. The rule that makes this worth doing

Every check below has a **PASS** and a **FALSE PASS**.

A false pass is a result that *looks* like containment but was produced by
something else — a missing binary, a host with no outbound network, a sandbox
that never started. A sandbox that fails to launch blocks everything, which is
indistinguishable from perfect containment unless you check the control.

**If a check has a control step, do not skip it.** A check without its control
proves nothing.

---

## 1. Prerequisites

```bash
# Clone and install
git clone https://github.com/MrCipherSmith/keryx.git
cd keryx
bun install

# The Linux launcher
sudo apt-get update && sudo apt-get install -y bubblewrap
bwrap --version
```

Bubblewrap needs unprivileged user namespaces. Ubuntu 23.10+ restricts them via
AppArmor:

```bash
# Only if step 2 fails with a user-namespace error
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Also confirm outbound network exists at all — several checks below depend on the
host being able to reach the internet **without** the sandbox:

```bash
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://example.com
# expect: 200
```

If this is not 200, stop. On a host with no network, every network check below
would false-pass.

---

## 2. Launcher sanity — can bwrap contain anything at all?

```bash
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
      --unshare-ipc --unshare-net --die-with-parent --new-session \
      -- /bin/echo bwrap-can-run
```

- **PASS:** prints `bwrap-can-run`.
- **FAIL:** any `bwrap:` error. Fix this before continuing — every check below
  would otherwise "pass" for the wrong reason.

---

## 3. The automated smokes

These are the same tests CI runs. They are gated behind an explicit flag, so a
normal `bun test` skips them and spawns nothing.

```bash
KERYX_ALLOW_REAL_SUBPROCESS=1 bun test \
  src/harness/process/sandbox/sandbox.smoke.test.ts \
  src/harness/process/real-process-adapter.smoke.test.ts \
  src/commands/harness-exec.smoke.test.ts \
  --timeout 30000
```

- **PASS:** `0 fail`, and the output names both
  `write inside cwd succeeds; write outside the workspace is denied` and
  `the default profile denies network`.
- **FALSE PASS:** `0 fail` with those names **absent** — that means the whole
  block was skipped (no launcher, or the flag did not reach the test). Read the
  test names, not just the count.

Also run the full suite once, to be sure the checkout itself is sound:

```bash
bun run typecheck
bun test --timeout 30000     # expect 0 fail
```

---

## 4. Filesystem containment, by hand

The v1 posture is **workspace-write**: the working directory and the session
temp dir are writable, everything else on the host is read-only.

```bash
cd ~/keryx

# 4a. A write INSIDE the workspace must succeed
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  -- /usr/bin/touch ./sandbox-inside.txt
ls -l ./sandbox-inside.txt && rm -f ./sandbox-inside.txt

# 4b. A write OUTSIDE the workspace must be denied
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  -- /usr/bin/touch "$HOME/sandbox-OUTSIDE.txt"
ls -l "$HOME/sandbox-OUTSIDE.txt"     # expect: No such file or directory
```

- **PASS:** 4a creates the file (`outcome.exitCode` is `0`); 4b does **not**
  create it.
- **FALSE PASS on 4b:** the file is absent because 4a *also* failed. If 4a did
  not create its file, the sandbox is not containing — it is broken. Both halves
  must behave differently for this check to mean anything.

Every command prints one JSON blob. `exitCode` is the contained process's real
exit status.

---

## 5. Network OFF (the default)

```bash
# Sandboxed: must NOT reach the network
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  -- /usr/bin/curl -sS -m 10 -o ./net-sandboxed.txt https://example.com

# Control: the SAME command with containment disabled must reach it
KERYX_ALLOW_REAL_SUBPROCESS=1 KERYX_DANGEROUSLY_DISABLE_SANDBOX=1 \
bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  -- /usr/bin/curl -sS -m 10 -o ./net-control.txt https://example.com

ls -l ./net-sandboxed.txt ./net-control.txt 2>&1
rm -f ./net-sandboxed.txt ./net-control.txt
```

- **PASS:** the sandboxed run has a non-zero `exitCode` and produced no bytes;
  the control run has `exitCode: 0` and a non-empty file.
- **FALSE PASS:** both fail. Then the host simply has no network, and the
  sandboxed leg proves nothing. Go back to the prerequisite check in §1.

---

## 6. Network RESTRICTED — the domain allowlist

### 6-Linux. The check that applies on your server

On Linux this must **fail closed**. That is the whole check:

```bash
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  --allowed-domains example.com \
  -- /bin/echo hi
```

- **PASS:**
  `"outcome":{"kind":"blocked","reason":"... network=restricted is not yet
  enforced on Linux ..."}` — nothing was spawned.
- **FAIL (and this would be serious):** `"kind":"completed"`. That would mean the
  run proceeded with **full host network** while the caller asked for a
  single-domain allowlist — a silent downgrade from "only these domains" to
  "everything".

Report §6 and §7 as `PASS (fails closed)` and stop here; the rest of this section
documents the macOS behaviour for reference.

### 6-macOS. Full allowlist behaviour (reference)

`--allowed-domains` switches the run to `restricted`: the OS layer denies all
network except a loopback proxy, and the contained process is pointed at that
proxy. Only listed domains get through.

```bash
# 6a. An ALLOWED host
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  --allowed-domains example.com \
  -- /usr/bin/curl -sS -m 10 -o /dev/null http://example.com/

# 6b. A host NOT on the allowlist
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  --allowed-domains example.com \
  -- /usr/bin/curl -sS -m 10 -o /dev/null http://example.org/
```

Read the `network` key of the JSON output — that is the point of this check:

```json
6a → "network":{"restricted":true,"allowedDomains":["example.com"],
      "decisions":[{"host":"example.com","allowed":true,"count":1}]}

6b → "network":{"restricted":true,"allowedDomains":["example.com"],
      "decisions":[{"host":"example.org","allowed":false,"count":1}]}
```

- **PASS:** 6a shows `allowed: true` for `example.com`; 6b shows
  `allowed: false` for `example.org`.
- **Note — do not judge this by the exit code.** In 6b `curl` will often exit
  **0**: the proxy answers `403`, which is a perfectly successful HTTP
  transaction as far as `curl` is concerned. The `decisions` list is the only
  honest signal about what the allowlist did.
- **FALSE PASS:** `decisions` is empty in both. That means the contained process
  never reached the proxy at all (so nothing was ruled on), not that the
  allowlist worked.

Wildcards cover the apex domain too — `*.github.com` matches both `github.com`
and `api.github.com`:

```bash
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  --allowed-domains '*.github.com' \
  -- /usr/bin/curl -sS -m 10 -o /dev/null http://api.github.com/
# expect: decisions shows api.github.com allowed:true
```

---

## 7. Credential masking over HTTPS

> **On Linux:** masking rides on the restricted-network proxy, so it fails closed
> for the same reason as §6. The one thing worth running there is the argument
> guard at the end of this section (it is platform-independent). The rest is
> macOS reference.

The contained process receives a **sentinel** in the env var, never the real
secret. The proxy substitutes the real value on the wire, and only for the hosts
you name. This requires TLS termination (`--tls-terminate`), because a blind
`CONNECT` relay cannot rewrite encrypted bytes.

Set the secret in your shell first. It is read by keryx (the parent), never
forwarded as-is:

```bash
export DEMO_TOKEN='real-secret-do-not-log'
```

**7a — what the contained process can see.** This is the load-bearing check.

`harness exec` deliberately never prints the contained process's stdout (a
contained command may print secrets; the CLI reports the exit status and a
receipt, not the output). So have the contained process write into the
workspace, which is the one place it is allowed to write. A helper script also
keeps the redirect *inside* the script — the structural guard rejects shell
metacharacters in the command line, so `sh -c 'cmd > file'` would be blocked.

Note that `--mask-env` injects the variable itself, so `DEMO_TOKEN` does not need
to be in `--allow-env`:

```bash
cat > ./show-token.sh <<'EOF'
#!/bin/sh
printenv DEMO_TOKEN > ./token-seen.txt
EOF
chmod +x ./show-token.sh

KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  --allowed-domains postman-echo.com \
  --mask-env DEMO_TOKEN@postman-echo.com \
  --tls-terminate \
  -- "$PWD/show-token.sh"

cat ./token-seen.txt
rm -f ./show-token.sh ./token-seen.txt
```

- **PASS:** `token-seen.txt` contains a value starting with `keryx-sentinel-`,
  and **never** `real-secret-do-not-log`.
- **FALSE PASS:** the run was blocked or errored and the file is empty or
  missing, and you read "no secret appeared" as success. The sentinel must
  actually be *present*. Check `outcome.exitCode` is `0` first.

**7b — what the upstream server receives.** Quote the header single-quoted so
your shell does not expand it; curl expands it from the contained env
(`--variable`/`--expand-header` need curl 8.3+, so check `curl --version` first):

```bash
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH \
  --allowed-domains postman-echo.com \
  --mask-env DEMO_TOKEN@postman-echo.com \
  --tls-terminate \
  -- /usr/bin/curl -sS -m 15 https://postman-echo.com/headers \
       --variable '%DEMO_TOKEN' --expand-header 'X-Demo: {{DEMO_TOKEN}}'
```

- **PASS:** the echoed JSON shows `x-demo: real-secret-do-not-log` — the real
  value reached the remote server, while 7a proved the sandbox only ever held
  the sentinel. That combination is the whole point.
- **INCONCLUSIVE:** any non-200 from the echo service, or curl older than 8.3.
  An unreachable test host is **not** a pass — record it as untested and rely on
  7a, or retry against another echo service.

Masking without `--tls-terminate` is rejected on purpose: the sentinel would
leave the sandbox unchanged and authentication would silently fail. Confirm the
guard fires:

```bash
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allowed-domains x.com --mask-env T@x.com \
  -- /bin/echo hi
# expect: a message saying --mask-env requires --tls-terminate; nothing spawned
```

---

## 8. Known limitation — Go-based tools under TLS termination

> **On Linux:** TLS termination also rides on the restricted-network proxy, so
> this section is macOS-only reference material. Skip it and report §8 as `N/A`.


The run CA is delivered through env vars (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`) and never
installed into the system trust store — deliberately, because a run-scoped MITM
CA must not become a host-wide trust decision.

Go's crypto/tls ignores those variables and uses the system pool. So Go-based
tools (`gh`, `terraform`, `kubectl`, `docker`) **fail TLS** under
`--tls-terminate`. This is expected, not a bug.

```bash
`--allow-env` takes ONE key and is repeatable — `--allow-env PATH,HOME` would
forward a single variable literally named `PATH,HOME`.

```bash
# Under TLS termination: expect a certificate-trust failure
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH --allow-env HOME \
  --allowed-domains '*.github.com' --tls-terminate \
  -- /usr/bin/kubectl version --output=json

# Control: the same command WITHOUT termination should get through
KERYX_ALLOW_REAL_SUBPROCESS=1 bun src/cli.ts harness exec \
  --allow-real-subprocess --allow-env PATH --allow-env HOME \
  --allowed-domains '*.github.com' \
  -- /usr/bin/kubectl version --output=json
```

- **PASS:** the first run fails with an x509 / "certificate signed by unknown
  authority" style error and the second does not. Run both — the control is what
  proves it is the MITM and not a broken invocation.

If you need a Go tool inside the sandbox, use the allowlist **without**
`--tls-terminate` (blind relay, no credential masking on HTTPS).

---

## 9. What to report back

For each section, one line: `PASS`, `FAIL`, or `INCONCLUSIVE` with the reason.
`INCONCLUSIVE` is a legitimate and useful answer — an unreachable test host is
not a passing sandbox.

```
§2  launcher sanity            :
§3  automated smokes           :
§4  filesystem containment     :
§5  network off                :
§6  allowlist fails closed     :
§7  mask-env argument guard    :
§8  Go tools under MITM        : N/A on Linux
```

The load-bearing evidence on Linux is: the two differing results in §4, the
sandboxed-vs-control pair in §5, and the exact `blocked` reason string from §6.
Paste those verbatim.

---

## Appendix — command shape

```
keryx harness exec [flags] -- <absolute-path> [args...]
```

The `--` terminator is required; the program must be an absolute path. Flags:

| Flag | Meaning |
|------|---------|
| `--allow-real-subprocess` | Required to spawn anything real (or `KERYX_ALLOW_REAL_SUBPROCESS=1`). |
| `--allow-env KEY` | Forward one env var into the contained process. Repeatable. Nothing else is forwarded. |
| `--allowed-domains a,b` | Switch the network to `restricted` and allow only these hosts. `*.d.com` covers `d.com` too. |
| `--mask-env NAME@host[,host]` | Replace `NAME`'s value with a sentinel inside the sandbox; the proxy restores the real value for those hosts. Requires `--tls-terminate`. |
| `--tls-terminate` | Terminate allowlisted HTTPS with a run-scoped CA so requests are inspectable. |
| `--max-runtime-ms N` | Deadline for the contained process. |

Environment escape hatches (all opt-in, all off by default):

| Variable | Effect |
|----------|--------|
| `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` | No OS containment at all. Use only as the control in §5. |
| `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` | Run unsandboxed when no launcher is installed, instead of failing closed. |
| `KERYX_SANDBOX_ALLOWED_DOMAINS` | Same as `--allowed-domains`. |
| `KERYX_SANDBOX_MASK_ENV` | Same as `--mask-env`, `;`-separated. |
| `KERYX_SANDBOX_TLS_TERMINATE=1` | Same as `--tls-terminate`. |

Without `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1`, a missing launcher makes the run
**fail closed**: it refuses to start rather than silently running uncontained.
