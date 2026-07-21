# Keryx OS Sandbox — Specification
Version: 1.0.0

## 1. Module identity

| Field | Value |
|---|---|
| Name | OS sandbox |
| Root | `src/harness/process/sandbox/` |
| Layer | Enforcement, below the policy engine and the structural command guard |
| Entry paths | `keryx harness exec` (default-on), agent `shell_exec` (opt-in) |
| External binaries | `sandbox-exec` (macOS), `bwrap` (Linux), `openssl` (TLS termination only) |
| npm dependencies added | none |

## 2. Storage structure

```text
src/harness/process/sandbox/
  profile.ts        SandboxProfile, policy→profile projection, default profile
  seatbelt.ts       macOS: SBPL profile text + command wrap
  bwrap.ts          Linux: bwrap argv builder + command wrap
  wrap.ts           platform dispatcher; refuses unsupported postures
  detect.ts         launcher detection; resolveSandboxAdapter
  adapter.ts        SandboxedProcessAdapter (decorates ProcessAdapter)
  proxy.ts          loopback allowlist proxy, allowlist matching, masking, MITM
  proxy-worker.ts   worker-thread entry for the proxy
  network-run.ts    restricted-run lifecycle: sentinels, CA trust env, decisions
  tls-ca.ts         ephemeral run CA + per-host leaf certificates via openssl
  index.ts          public surface
```

Tests sit beside their modules. Real-process tests are `*.smoke.test.ts` and are
gated behind `KERYX_ALLOW_REAL_SUBPROCESS=1`.

## 3. Core data contract — `SandboxProfile`

```ts
interface SandboxProfile {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  network: "off" | "on" | "restricted";
  /** Absolute roots writable in workspace-write (empty for read-only). */
  writableRoots: string[];
  /** Absolute paths whose READ is denied even under the broad read default. */
  readDenyList: string[];
  /** Allowed hosts when network === "restricted" (else empty). */
  allowedDomains: string[];
  /** Filled by the run wiring once the proxy is listening. Absent ⇒ deny all. */
  proxy?: { host: string; port: number };
  /** When true, an unavailable launcher MUST refuse rather than run uncontained. */
  required: boolean;
}
```

### Projection from policy

`sandboxProfileFromPolicy({ policy, cwd, tmpDir, home, allowedDomains, dangerFullAccess })`:

| Policy input | Profile result |
|---|---|
| `dangerFullAccess` | `danger-full-access`, network on, containment skipped entirely |
| `defaults.write === "deny"` | `read-only`, no writable roots |
| otherwise | `workspace-write`, writable = `[cwd, tmpDir]` |
| `defaults.network !== "allow"` | `network: "off"` |
| `defaults.network === "allow"` + no allowlist | `network: "on"` |
| `defaults.network === "allow"` + allowlist | `network: "restricted"` |
| `requiredControls.isolation === "required-fail-closed"` | `required: true` |

### Default profile

`defaultSandboxProfile(cwd, tmpDir, home)` — the v1 posture used by
`keryx harness exec`: `workspace-write`, network `off`, `required: false`.

### Secret read-deny list

Relative to home: `.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.config/keryx`,
`.netrc`.

## 4. Enforcement — macOS (Seatbelt)

Generated SBPL, allow-by-default with targeted denies:

```scheme
(version 1)
(allow default)
(deny file-write* (subpath "/"))
(allow file-write* (subpath "<writable root>"))          ; per root
(allow file-write-data (literal "/dev/null") ...)         ; stdio + tty devices
(deny file-read* (subpath "<secret>"))                    ; per secret path
(deny network*)                                           ; network off
(allow network-outbound (remote ip "localhost:<port>"))   ; network restricted
```

Wrapped as `sandbox-exec -p <profile> <cmd> [args...]`.

Two constraints that are not obvious:

- Seatbelt's `remote ip` host must be `*` or `localhost`. A literal `127.0.0.1`
  is a **parse error**, so the loopback proxy is allowed as `localhost:<port>`
  and the proxy env URL uses `localhost` to match.
- macOS `/tmp` and `/var` are symlinks and the sandbox matches the *real* path,
  so writable roots are canonicalized with `realpathSync` before use.

## 5. Enforcement — Linux (bubblewrap)

```text
--ro-bind / /                     whole host filesystem, read-only
--dev /dev --proc /proc           minimal device + proc
--tmpfs /tmp                      ephemeral scratch
--bind <root> <root>              re-bind each writable root RW
--tmpfs <secret-dir>              mask a secret DIRECTORY
--ro-bind /dev/null <secret-file> mask a secret FILE (reads as empty)
--unshare-net                     network off
--unshare-ipc --die-with-parent --new-session
```

**Mask targets must be classified against the real filesystem.** bwrap mounts
over an *existing* mount point, and with `/` bound read-only it cannot create a
missing one. Masking a path that does not exist aborts the entire sandbox:

```text
bwrap: Can't mkdir /home/runner/.ssh: Read-only file system
```

So `buildBwrapArgs(profile, inspect?)` classifies each read-deny path as
`dir` → `--tmpfs`, `file` → `--ro-bind /dev/null`, `missing` → skipped. The
classifier is injectable so unit tests stay off the filesystem.

**Unsupported posture.** `network: "restricted"` is refused on Linux:

```text
network=restricted is not yet enforced on Linux (needs a network namespace +
proxy relay); use network off/on or run inside a container.
```

## 6. Fail-closed contract

`SandboxedProcessAdapter` decorates the real process adapter. Its rules, in
order:

1. `mode === "danger-full-access"` → containment skipped, delegate directly.
2. Launcher unavailable → refuse with a `spawn-error` observation (which
   `runContainedProcess` classifies as `blocked`), unless `failIfUnavailable` is
   explicitly relaxed **and** the profile is not `required`.
3. `wrapWithSandbox` refuses the posture → same refusal path.
4. Otherwise → delegate the wrapped command.

There is no path that silently runs an uncontained command when containment was
requested.

## 7. Restricted network

### Lifecycle

`setupNetworkRun(profile, { masks, tlsTerminate })`:

1. Non-`restricted` profile → no-op, empty decisions, no-op close.
2. For each mask with a non-empty value, generate `keryx-sentinel-<uuid>` and put
   the **sentinel** in the contained env; the real value goes only to the proxy.
3. Start the proxy **in a worker thread** and wait for its `ready` message.
4. If terminating TLS, write the CA certificate to a temp PEM and point the
   contained process at it via CA-trust variables.
5. Return the proxy-addressed profile, the env additions, the live `decisions`
   array, and a `close()` that tears down the worker and removes the PEM.

The proxy must run off the main thread: the contained command is spawned with
`spawnSync`, which blocks the main event loop for the whole run. An in-thread
proxy cannot accept the contained process's connections during that window.

### Allowlist matching

Case-insensitive, trailing-dot tolerant. `*.example.com` matches `example.com`,
`api.example.com` and `a.b.example.com`; it does **not** match `notexample.com`
or `example.com.evil.com`. An empty hostname is denied.

A `restricted` profile with an empty allowlist starts a proxy that denies
everything — reachable, but nothing allowed.

### Decision reporting

The worker posts one message per ruling, carrying **only** hostname, verdict and
kind — never headers or bodies:

```ts
interface ProxyDecision { host: string; allowed: boolean; kind: "connect" | "http" }
```

`summarizeDecisions()` collapses these per `(host, verdict)`, ordering denials
first, then by descending count.

This is load-bearing, not cosmetic: when the proxy denies a host it answers
`403`, which `curl` treats as a successful HTTP transaction. Without the
decisions list, a blocked request is indistinguishable from a fetched one.

### Credential masking

Substitution applies to request headers for hosts matching the mask's
`injectHosts`. It works on plaintext HTTP always, and on HTTPS **only** with TLS
termination — a blind `CONNECT` relay cannot rewrite encrypted bytes. Therefore
`--mask-env` without `--tls-terminate` is **rejected**, rather than silently
half-working.

### TLS termination

An ephemeral run CA and per-host leaf certificates are generated with the system
`openssl`. The CA private key never leaves the proxy worker. Trust is delivered
by environment variables only:

`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
`GIT_SSL_CAINFO`.

**Known limitation.** Go's `crypto/tls` ignores these variables and uses the
system pool, so Go-based tools (`gh`, `terraform`, `kubectl`, `docker`) fail TLS
under termination. This is expected behaviour, empirically confirmed, and not a
bug. Use the allowlist without `--tls-terminate` for such tools (blind relay, no
HTTPS masking).

Implementation notes forced by the Bun runtime: server-side socket injection
(`server.emit("connection")`), server-side `new tls.TLSSocket({ isServer: true })`
and `SNICallback` are all unusable, so termination is implemented as one internal
`https.createServer` per host, fed by piping the `CONNECT` socket.

## 8. CLI surface — `keryx harness exec`

```text
keryx harness exec [flags] -- <absolute-path> [args...]
```

The `--` terminator is required. A missing command is reported explicitly rather
than reaching the launcher as an empty path.

| Flag | Effect |
|---|---|
| `--allow-real-subprocess` | Required to spawn anything real. |
| `--allow-env KEY` | Forward one variable. Repeatable. **Not comma-separated** — `--allow-env PATH,HOME` forwards one variable literally named `PATH,HOME`. |
| `--max-runtime-ms N` | Deadline for the contained process. |
| `--allowed-domains a,b` | Switch to `restricted` and allow only these hosts. |
| `--mask-env NAME@host[,host]` | Mask a credential. Requires `--tls-terminate`. |
| `--tls-terminate` | Terminate allowlisted HTTPS with the run CA. |

### Output contract

One JSON blob on stdout, as the last line. The contained process's stdout is
**never** included — a contained command may print secrets.

```json
{
  "outcome": { "kind": "completed", "exitCode": 0 },
  "receipt": { "...": "..." },
  "evidenceRefs": ["..."],
  "network": {
    "restricted": true,
    "allowedDomains": ["example.com"],
    "decisions": [{ "host": "example.org", "allowed": false, "count": 1 }]
  }
}
```

`outcome.kind` is one of `completed`, `blocked`, `timeout`, `output-overflow`,
`cancelled`. The `network` key is present **only** for a restricted run.

## 9. Environment surface

| Variable | Path | Effect |
|---|---|---|
| `KERYX_ALLOW_REAL_SUBPROCESS=1` | both | Capability gate for spawning real processes. |
| `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` | both | No containment at all. Overrides everything, including `KERYX_SANDBOX_SHELL`. |
| `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` | `harness exec` | Run uncontained when no launcher exists instead of failing closed. |
| `KERYX_SANDBOX_ALLOWED_DOMAINS` | both | Same as `--allowed-domains` (comma-separated). |
| `KERYX_SANDBOX_MASK_ENV` | `harness exec` | Same as `--mask-env`, `;`-separated. |
| `KERYX_SANDBOX_TLS_TERMINATE=1` | `harness exec` | Same as `--tls-terminate`. |
| `KERYX_SANDBOX_SHELL` | agent `shell_exec` | `off` (default) / `workspace` / `1` / `on` / `strict`. |
| `KERYX_SANDBOX_ALLOW_WRITE` | agent `shell_exec` | Extra writable roots, comma-separated, `~/` expanded. |

### Agent `shell_exec` postures

| `KERYX_SANDBOX_SHELL` | Filesystem | Network |
|---|---|---|
| unset / `off` | uncontained | host |
| `workspace` \| `1` \| `on` | workspace-write | on |
| `strict` | workspace-write | off |

A domain allowlist via `KERYX_SANDBOX_ALLOWED_DOMAINS` overrides the mode's
network posture with `restricted`.

## 10. Integration points

| Point | Contract |
|---|---|
| `ProcessAdapter` | `SandboxedProcessAdapter` implements it, so `runContainedProcess` is unchanged. |
| `PolicyProfile` | Input to `sandboxProfileFromPolicy`; the OS layer never re-decides policy. |
| Structural guard / env allowlist / approval gate | Run on the ORIGINAL command, before wrapping. Approval semantics are untouched. |
| Receipts and evidence | Record command identity (path + argv hash), never output or env values. |

## 11. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| A1 | A write inside the workspace succeeds and a write outside is denied, on a real kernel. | `sandbox.smoke.test.ts`, run on macOS and in the `linux-sandbox` CI job. |
| A2 | Network off blocks the internet, proven against an unsandboxed control on the same host. | Same smoke; the control skips the assertion when the host has no network, rather than false-passing. |
| A3 | An allowlisted host is reachable; a non-allowlisted host is not. | `network-restricted.smoke.test.ts` and live runs against the real internet (macOS). |
| A4 | A masked credential never enters the contained process. | `network-run.test.ts` asserts the env holds a sentinel and never the real value; live-verified end to end. |
| A5 | Allow and deny rulings reach the caller. | `network-run.test.ts` drives real traffic through the worker; `harness-exec-restricted.smoke.test.ts` asserts the CLI field. |
| A6 | An unsupported posture refuses rather than downgrading. | `harness-exec-restricted.smoke.test.ts` asserts `blocked` with the reason on Linux. |
| A7 | A bundled build resolves the proxy worker. | `worker-resolution.test.ts`, verified to fail when the built worker is absent. |
| A8 | No new npm dependencies. | `package.json` `dependencies` remains empty. |
