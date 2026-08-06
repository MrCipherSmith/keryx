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

### What that gate will not remember

When you approve a `shell_exec` command the shell offers to remember it, either
exactly or as a `<word> *` prefix. Some prefixes are never offered, and a stored
one is **ignored on load** with its reason reported.

Loading does not rewrite the file, so a refused pattern is reported again every
time — but the next time you answer *always allow* to anything, the file is
written back **without** it. If you want to keep a record of what you had, copy
`permissions.json` before the next approval; the refusal is reported at least
once, and after that only until the next write.

Two different rules decide this, and the difference matters.

**A shape rule, which holds for anything.** A `<token> *` grant is offered only
when the token is recognisably a program name — letters, digits and `. _ + -`,
optionally with a path. So `\bash *`, `'bash' *`, `LC_ALL=C *` and `t*` are all
refused without asking what they are. That matters more than it looks: to
`/bin/sh` a leading backslash is nothing at all, so `\bash -c …` runs exactly as
`bash -c …` does, and an environment assignment puts caller-chosen *text* where
the program name should be — no list of program names could ever contain it.

**A positional rule, which is the one that does the heavy lifting.** A wildcard
may appear only in the **last** part of a pattern, and never in the first token.
The reason is that `*` matches whitespace: a wildcard in the program position
*is* a program, whatever letters it contains. `????? ctx run*` — five question
marks, no letters — matches `keryx ctx run …` purely by length, and no rule that
reads the letters in a token can ever see that. `bun test*`, `hostname *`,
`cat package.json*`, `rm build/*.tmp` and `ls k*` all still work; `t*`, `*x` and
`* ctx run*` do not.

**A word list, which is an expedient.** On top of the shape rule, some plain
program names are refused as bare grants: interpreters (`bash *`, `python3 *`),
shell builtins that source a file (`. *`, `source *`), generic wrappers (`env *`,
`xargs *`, `timeout *`, `setsid *`), remote-exec and download tools, container
runtimes, package/build runners, and programs with their own escape into a shell
(`git *`, `find *`, `psql *`, `sqlite3 *`, `tar *`, `gh *`, `aws *`).

**`keryx` gets a rule of its own.** `keryx ctx run -- <anything>` runs an
arbitrary program, and the destructive-command check reads the line it is given,
not the one after the `--`. Banning the bare `keryx *` grant was not enough,
because `keryx ctx run*` and `keryx c*` narrow the arguments and still cover it.
So a `keryx …` pattern is offered only when it literally pins a verb that cannot
execute what follows: `keryx flow status*` and `keryx ctx rg*` are fine,
`keryx ctx*` and `keryx ?*` are not.

**Where this leaves you in practice.** The approval prompt offers exactly two
grants: the exact command, and `<first token> *`. There is no free-form entry
yet, so for a keryx command the offered prefix is `keryx *`, which is refused —
and the narrower pattern this page recommends has to be written into
`permissions.json` by hand. If your project routes work through `keryx` (this one
does), expect the exact-command grant to be the one you use until free-form entry
exists.

For `keryx ctx run` and `keryx harness exec` specifically, **neither** grant is
offered — not the prefix and not the exact command. That is deliberate: those two
verbs take the program to run on their own command line, so a remembered pattern
covering them is a remembered grant of arbitrary execution. They prompt every
time, and there is no pattern you can hand-write that will stop them prompting.
`keryx health run` and `keryx test run` do stay offerable; they execute the
repository's own configured command, which comes from the checkout rather than
from the pattern.

**The word list is an expedient, not a boundary.** It is a list of words, so it
is incomplete by construction — a wrapper nobody has thought of is not on it. The
shape rule above is not a list and does not have that property. Three things
apply to *every* pattern regardless of its first word: the metacharacter rule,
the destructive classifier, and the refusal to remember anything that touches the
agent's own credential and permission files. Do not read the word list as a
guarantee about a category.

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
