# Run an agent against a repository without giving it my machine

**Read the platform matrix first.** Containment is not one feature, and the
difference between the tiers is not a footnote — Tier 2 does not exist on Linux
and does not degrade there. It refuses.

| Capability | macOS | Linux |
|---|---|---|
| Filesystem boundaries (workspace-write, secret read-deny) | Seatbelt | bubblewrap |
| Network off / on | yes | yes |
| Network **restricted** (domain allowlist) | yes | **refused** |
| Credential masking | yes | refused (needs restricted) |
| TLS termination | yes | refused (needs restricted) |

Linux needs `bubblewrap` installed. Without it, every contained spawn **fails
closed** — see the third example below.

Every command here was executed on Linux; the output is from those runs.

## The default is refusal

```console
$ keryx harness exec -- /bin/echo hi
keryx harness exec refuses to spawn a real subprocess without
--allow-real-subprocess (or KERYX_ALLOW_REAL_SUBPROCESS=1); no process was started.
```

Nothing was spawned. Authority to run a real subprocess is a separate,
explicit grant from anything else you configure.

## A contained run, and what a missing launcher looks like

```console
$ KERYX_ALLOW_REAL_SUBPROCESS=1 keryx harness exec --allow-real-subprocess -- /bin/echo hi
{"outcome":{"kind":"blocked","reason":"Contained spawn failed: OS sandbox launcher
unavailable on linux for program \"/bin/echo\"; failing closed (install bubblewrap
on Linux, or relax failIfUnavailable to run unsandboxed)."},
 "sandbox":{"launcher":"bwrap", …}}
```

That is the design working. The launcher was missing, so the command was
**blocked with a reason** rather than run uncontained. Install `bubblewrap` and
the same invocation runs inside the sandbox.

## Restricting the network — and a surprise worth knowing

```console
$ KERYX_ALLOW_REAL_SUBPROCESS=1 keryx harness exec --allow-real-subprocess \
    --allowed-domains api.example.com -- /bin/echo hi
{"outcome":{"kind":"blocked", …},
 "network":{"restricted":true,
   "allowedDomains":["api.example.com","openrouter.ai","api.deepseek.com",
                     "api.z.ai","api.groq.com"],
   "decisions":[]}}
```

**You asked for one domain and the allowlist has five.** The extra four are the
hosts of provider credentials saved on this machine. Once a run is restricted,
a masked credential's host has to be reachable or the mask is pointless — so
inject-hosts join the allowlist.

Two things make this acceptable rather than alarming, and you should check both:

- **It is disclosed.** `allowedDomains` in the output is the effective list, not
  the one you typed. Read it.
- **Credentials cannot cause restriction.** Since `0.2.2` the posture is decided
  only by what the operator asked for; a saved key that merely exists no longer
  turns an ordinary command into a restricted run. Before that, it did — on
  macOS it widened the run, and on Linux it blocked the command outright.

`decisions` is the proxy's allow/deny ruling per connection. It is empty here
because nothing connected.

## The layer doing the work in a default install

`shell_exec` containment defaults to **off**, so in a stock configuration the
load-bearing layer is the **approval gate**, not the sandbox. The policy engine
decides *what runs*; the sandbox bounds *what a run can touch*. If you have not
turned containment on, you are relying on the first of those.

## Verify

```console
$ keryx harness exec -- /bin/echo hi
```

You should see the refusal. If a process runs, the opt-in gate is not doing its
job and nothing else here can be trusted either.

On macOS, after installing nothing:

```console
$ KERYX_ALLOW_REAL_SUBPROCESS=1 keryx harness exec --allow-real-subprocess -- /bin/echo hi
```

should print `{"outcome":{"kind":"completed","exitCode":0, …}}`.

## Known limits, stated here rather than discovered later

- The deadline kill is **leader-only** — a contained process's grandchildren are
  not group-reaped.
- There is no macOS Seatbelt job in CI until `0.2.1`; from that release a
  macOS real-host job exercises Tier 2.
- The TLS-termination allowlist bypass fixed in `0.2.1` is worth knowing about
  if you are on an older build: the CONNECT target was checked and the
  decrypted request's `Host` header was not.

## Where to go next

- [Architecture › Containment](../architecture.md) — the tier diagram.
- [CLI reference › harness](../cli-reference.md) — every flag.
