# Plan

## Approach

Model the ruleset as **data with no escape hatch**: `buildLandlockRuleset` either
returns a ruleset that enforces the *whole* profile, or it returns a list of
reasons why it cannot. There is deliberately no "partially enforced" field and no
`notEnforced` list — a field like that is where an approximation would hide, and
AC2 exists to prevent exactly that.

### Why the handled-access set is computed, not fixed

Landlock's `handled_access_fs` names what the ruleset *restricts*; anything not
handled stays unrestricted. So the profile's meaning maps directly:

| Profile fact | Handled | Allow-rules |
|---|---|---|
| broad read default (bwrap `--ro-bind / /`) | nothing read-ish is handled → reads stay unrestricted | none needed |
| `read-only` | every write-ish access right | none |
| `workspace-write` | every write-ish access right | one path-beneath rule per writable root |

Handling only what is restricted keeps the ruleset minimal and removes the need
for a synthetic `/` rule whose failure mode would be silent.

### Why an ABI floor falls out of that

`landlock_create_ruleset` rejects a `handled_access_fs` mask containing bits the
running kernel does not know. The usual workaround is to mask the request down to
the kernel's ABI — **best-effort**, and best-effort is approximation. So instead:
the required access-right set is derived from the profile, its minimum ABI is
`max()` over the rights it contains, and an ABI below that is an explicit AC2
failure naming the kernel (R6), never a downgraded ruleset.

Consequence, and it is a real finding: a write boundary needs
`LANDLOCK_ACCESS_FS_TRUNCATE`, which first exists at **ABI 3**. On ABI 1 or 2 a
contained command can `truncate()` a file outside the writable roots. So any
`read-only` / `workspace-write` profile needs ABI ≥ 3 (kernel 6.2+), not the
ABI ≥ 1 the specification's layer table implies.

### Why `readDenyList` is inexpressible

Landlock rules are allow-only and **cumulative along the path**: kernel docs,
*Layers of file path access rights* — "one policy layer grants access to a file
path if at least one of its rules encountered on the path grants the access". A
rule higher in the tree therefore cannot be narrowed by a deeper one, so a
deny-exception under a broad read default has no representation. Expressing it
would require enumerating every sibling on the path to each secret, which needs
`readdir` (impure), races the filesystem, and silently denies entries created
later. That is spec §4.3's "no mount view" paragraph, and it is fail-closed here.

### Why no profile emits network rules

Spec §4.3 / PRD R2: Landlock's network access types cover TCP `bind`/`connect`
only. `network: "off"` must select bubblewrap until a seccomp filter covers UDP,
raw and unix sockets. `network: "restricted"` needs the loopback proxy, which
Landlock cannot force traffic through. Both are AC2 failures. The ruleset type
still carries `handledNet` / `netRules` so the seccomp-paired future has a place
to land, and a test asserts they are empty for every profile — that test is the
guard against the second false green.

## Trade-offs

- **Stricter than the specification's ABI ≥ 1.** Accepted: AC2 outranks the
  layer table, and the discrepancy is reported for step 3/step 4 to reconcile.
- **The default policy-derived profile is inexpressible** whenever `home` is
  known, because `defaultReadDenyList` is then non-empty. Reported, not worked
  around. The path forward (sibling enumeration behind an injected `readdir`)
  is documented but not built — it is not pure and not in this lane.
- **PID/IPC/session isolation** (bwrap `--unshare-pid`, `--unshare-ipc`,
  `--new-session`) has no representation in `SandboxProfile`, so it is neither
  expressed nor claimed. Landlock ABI 6 scoping could carry part of it later.
