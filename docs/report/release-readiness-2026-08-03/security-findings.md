# Security findings — 2026-08-03

Found by the documentation pass, not by a security review: an analyst reading
`src/harness/process/sandbox/` for the architecture refresh reported two
containment concerns. Both were then **verified directly in the source** before
being written down here.

These are code defects, not documentation gaps. They are recorded here because
this is where the release audit lives; closing them belongs in a flow.

---

## SF-1 — the domain allowlist is bypassable while TLS termination is on

> **CLOSED in `0.2.1` by PR #210 (`648897cc`)** — and it was already fixed when
> this section was written. The pull request had been open since 2026-07-26 with
> all checks green; this audit reported the defect as open work without first
> checking the open pull requests. The finding below is accurate about the code
> as it stood; the recommendation at the bottom of this file was not.
>
> The fix matches the mechanism described here: `proxy.ts:214` now reads the
> inner `Host`, `:221` matches it against the allowlist, and it passes through
> `decide(...)` — closing the bypass and the blind spot together. It ships with
> the planted counter-example this section asked for
> (`proxy-tls.test.ts`, a foreign `Host` set inside the tunnel), and it adds the
> macOS real-host CI job whose absence is noted under "What was not verified"
> below (`.github/workflows/ci.yml:148`).

**Severity: high.** Platform: macOS only, because TLS termination is macOS only.
Requires `--tls-terminate` (or `maskMode=auto` deriving it).

### What is enforced

`src/harness/process/sandbox/proxy.ts:238-246` — the `connect` handler takes the
hostname from the **CONNECT target**, checks it against the allowlist, and
refuses with `403` when it does not match:

```ts
const [reqHost, reqPort] = (req.url ?? "").split(":");
const hostname = reqHost ?? "";
if (!decide({ host: hostname, allowed: matchesAllowlist(hostname, allowed), kind: "connect" })) {
  clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
```

### What is not

When termination is on, the connection is handed to a per-host HTTPS terminator
(`:251-254`) whose handler is `mitmHandler`. That handler takes the upstream
host from the **decrypted request's `Host` header** and forwards to it —
`proxy.ts:196-207`:

```ts
const hostHeader = req.headers.host ?? "";
const [rawHost, rawPort] = hostHeader.split(":");
const hostname = rawHost ?? "";
const upstreamPort = Number(rawPort) || 443;
...
const upstreamReq = https.request({ host: hostname, port: upstreamPort, ... });
```

There is no second allowlist check, and **no `decide(...)` call** — so the egress
is also absent from the reported rulings.

### The sequence

1. Contained process opens `CONNECT allowed.example:443` — passes the allowlist.
2. TLS handshake completes against the leaf issued for `allowed.example`; the
   process trusts the run CA because containment installed it.
3. Inside the tunnel it sends `Host: not-allowed.example`.
4. `mitmHandler` forwards the request to `not-allowed.example`.

The allowlist held on the outer hop and was never consulted on the inner one.

### Scope

Real credentials are **not** leaked: `applyMasks` still filters on `injectHosts`
(`proxy.ts:200`), so a mask for `allowed.example` is not injected toward another
host. The failure is containment and observability, not credential disclosure.

Secondary: the upstream port comes from the inner `Host` header and defaults to
443 (`proxy.ts:199`), rather than from the CONNECT target port (`:241`).

No test covers this path.

### Why it matters more than the mechanism suggests

The adversary here **is** the contained process. An allowlist that only holds
against a process that is not trying is not a boundary. This repository already
records that lesson — `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
— from the shell allowlist, and the same shape has recurred one layer down.

---

## SF-2 — an ambient credential silently promotes `harness exec` to a restricted-network run

> **CLOSED in `0.2.2`.** The posture is now decided by
> `resolveNetworkRestriction` (`src/commands/harness.ts`), which takes the
> operator's intent and **nothing derived from the ambient environment** —
> credentials are not a parameter, so they cannot reach the decision. Inject
> hosts still join the allowlist once a restricted run has been asked for; they
> no longer cause one.
>
> The five ways to ask are a discriminated union with a total `switch` over it.
> That exhaustiveness was verified rather than assumed: planting a sixth member
> fails `tsc` with `TS2366`, so a new way to ask cannot be added without
> handling it. Nine unit tests cover each way, the empty-list cases
> (`--allowed-domains ""` is not a request for "restrict with no domains"), the
> fixed precedence, and the regression itself.

**Severity: high.** Behavioural, both platforms, opposite outcomes.

`src/commands/harness.ts:587-596` resolves credential masks unconditionally
against `envWithSavedApiKeys(env)` — that is, against provider keys present in
the environment **or saved in the user-global `auth.json`**, whether or not this
invocation has anything to do with a provider.

`src/commands/harness.ts:611-616` then lets the resulting inject-hosts decide the
network posture on their own:

```ts
const maskHosts = masks.flatMap((m) => m.injectHosts);
const baseDomains = allowedDomains ?? envOrPolicyDomains;
const restrictedDomains =
  baseDomains === undefined && maskHosts.length === 0
    ? undefined
    : [...new Set([...(baseDomains ?? []), ...maskHosts])];
```

So with any provider key set or saved, `keryx harness exec -- /bin/echo hi`:

- on **macOS** runs with restricted networking and TLS termination on — a
  *wider* posture than the documented network-off default, entered without the
  operator asking for it;
- on **Linux** is **blocked**, because `restricted` is refused there
  (`sandbox/wrap.ts:49-55`) — so the same command works or fails depending on
  whether an unrelated API key exists.

`KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` does not help in that state
(`src/commands/harness.ts:94`).

`shell_exec` does not behave this way, so the two paths diverge — an asymmetry
the parity claim does not cover.

The defect is the same one this project keeps finding: **branching on a value
whose domain was never written down.** `maskHosts.length > 0` was read as "the
operator wants restricted networking"; it also means "an unrelated credential
happens to exist on this machine."

---

## SF-3 — the wiki overstates fail-closed containment

**Severity: medium (documentation, but a security claim).**

`.metaproject/wiki/architecture/os-sandbox.md:132-133` states:

> There is no code path that runs a command uncontained after containment was
> requested.

`src/harness/process/sandbox/adapter.ts:72,85` contradicts it: under
`KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` the **original, unwrapped** command runs,
while proxy environment variables are still injected.

The escape hatch may well be wanted. The absolute claim is what has to go.

---

## Lesser drifts, verified and worth fixing with the above

| Claim | Reality |
|---|---|
| "session temp dir" (`sandbox/profile.ts:59`) | the shared OS `tmpdir()` — `harness.ts:93`, `shell-exec-tool.ts:141` |
| "reports every allow/deny ruling" | true for `harness exec` only; `shell_exec` discards `net.decisions` (`shell-exec-tool.ts:232-238`) |
| dead secret-key loop | `src/lib/sandbox-config.ts:54-58` |
| `serve-server.ts:20-27` header: "two routes, both reads" | five routes since R4c, including turn submission |
| `package.json` `build` externalizes `@xenova/transformers` | that runtime was removed; the flag is dead |

---

## What was not verified

**Nothing was executed.** Kernel-level enforcement is unverified here — these are
source-level findings. Only the Linux bubblewrap half runs in CI
(`.github/workflows/ci.yml:209-217`); there is **no macOS Seatbelt job**, which
means the platform where SF-1 applies is the platform with no live containment
test.

That gap is itself worth recording: the domain allowlist, credential masking and
TLS termination are macOS-only *and* untested in CI.

## Recommendation

1. ~~SF-1 needs a flow, closed with a planted, executed counter-example.~~
   **Already done** — PR #210, merged as `648897cc` in `0.2.1`, with exactly that
   counter-example. See the note at the top of SF-1.
2. ~~SF-2 needs a flow.~~ **Closed in `0.2.2`** — see the note at the top of
   SF-2. The fix is a written-down domain, not a patched condition.
3. SF-3 and the drift table can ride along with the documentation refresh.
4. ~~Add a macOS containment job to CI.~~ **Already done** in the same pull
   request (`.github/workflows/ci.yml:148`).

## Method note, worth more than the findings

Two of the four recommendations above were closed a week before they were
written. The audit read the source carefully and did not read the open pull
requests, so it reported finished work as outstanding.

That is the same failure this repository keeps recording, pointed the other way:
not *a claim stronger than its evidence*, but **a claim that never checked the
cheapest available evidence**. `gh pr list` costs one command and would have
prevented it. The check now belongs before any finding is written up, not after.
