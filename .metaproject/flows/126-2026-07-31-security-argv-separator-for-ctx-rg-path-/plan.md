# Implementation Plan

Status: formalized 2026-07-31

## Approach

Two independent fixes, each with a regression test proven to fail when the guard
is removed rather than merely asserted to.

### S-001 — allowlist the options, then separate

A `--` separator alone is not enough. Callers legitimately pass ripgrep flags
(`rgListMode` already inspects for `--files-with-matches` and friends), and
everything after `--` is positional — so a blanket separator would break them.
Conversely, flags alone are not enough, because a pattern that begins with `-`
is positionally indistinguishable from an option.

So both, in this shape:

```text
rg <keryx flags> <allowlisted caller flags> -- <pattern> [paths]
```

The allowlist is the part that fails closed. An unrecognised `-…` is refused
rather than forwarded, so an option added to a future ripgrep — including a new
way to execute something — is denied by default instead of inherited. That is
the difference between fixing this instance and fixing the class.

The refusal names the option and points at the escape hatch: a caller who
genuinely wants to search for a dash-leading literal writes `keryx ctx rg --
"--whatever"`, and the operand lands after the separator where ripgrep can only
read it as a pattern.

Assertions are on the constructed argv, not on observed behaviour. Behaviour
tests would prove less here: ripgrep is not installed on this host, and a given
build may not carry the dangerous option, so such a test could pass for the
wrong reason and keep passing after the guard was deleted.

### S-003 — resolve, then contain

One shared helper takes the project root and a caller path, resolves it to a
real path, and returns the contained path or a typed refusal.

Two properties that are not optional:

- The check runs on the **real** path. A symlink inside the project pointing
  outside satisfies a string-prefix check and still reads the target.
- The comparison is segment-aware. `<root>-secrets` is not inside `<root>`,
  though its path string starts with it.

Containment is checked **before** existence, so a traversal to a non-existent
path is refused as an escape rather than reported as not-found — otherwise the
refusal doubles as an existence oracle for files the caller may not ask about.

### Which commands get containment, and which does not

| Command | Contained | Why |
|---|---|---|
| `test suggest` | yes | Sends the file's contents to a third-party model provider. An uncontained path does not merely read locally, it ships the file off the machine. |
| `security scan` | yes | Reads whatever it is pointed at and renders findings from the content; it is a scanner for *this project*. |
| `agents monitor` | **no** | Reverted after implementing it. Its event stream is a harness artifact that legitimately lives outside the repository — temp dirs, CI artifacts — and containment broke exactly that in the existing tests. It transmits nothing and parses a strict typed format, so the cost was real and the benefit was not. |

The `agents monitor` exclusion is a correction to this flow's own first
acceptance criterion, which named all three before the actual usage was checked.
Recorded rather than quietly dropped.

## Steps

1. Containment helper (async + sync twin) with its own unit tests.
2. Wire it into `test suggest` and `security scan`, ahead of every read.
3. Allowlist + `--` separator in the ripgrep argv builder.
4. Mutation-check both guards: remove each, confirm tests fail, restore.
5. Typecheck, full suite, health; read exit codes directly, not through a pipe.

## Risks

- **Breaking a legitimate search.** The allowlist is generous and the refusal
  names the option plus the escape. Existing behaviour (match mode vs list mode
  flags) is covered by explicit tests.
- **Breaking a legitimate path.** A project reached through a symlinked working
  directory is normal; both sides are real-path resolved before comparison, and
  AC6 covers it. The `agents monitor` case already proved this risk is real.
- **Guards that look right and do nothing.** Answered by mutation-checking each
  one rather than trusting a green suite — the lesson from flow 087, where a
  coverage guard passed while guarding nothing.
- **Ripgrep absent on the dev host.** Behaviour-level checks would skip; the
  argv-level assertions carry the guarantee.
