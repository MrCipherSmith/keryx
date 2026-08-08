# Linux containment step 3: the Landlock launcher — apply the ruleset in a child and exec the real command

Status: formalized
Source: user description (continuation of `docs/requirements/keryx-linux-containment`, step 3)

## Problem

Steps 1 and 2 landed on `feat/linux-containment-landlock`: the probe reports
containment honestly (flow 144), the `bun:ffi` spike proved the syscalls reach
the kernel and survive `execve` (flow 143), and the pure translator turns a
`SandboxProfile` into a Landlock ruleset (flow 145). Nothing applies one.

Two consequences, both live on the branch today:

1. **No Linux command is contained by Landlock.** `wrap.ts` still dispatches
   Linux to bubblewrap only; `detect.ts` still answers "is `bwrap` on `PATH`"
   with a boolean. The layer exists as data and as a decision record, and as
   nothing a process ever runs under.
2. **The translator as merged serves no profile the product builds.**
   `buildLandlockRuleset` refuses any profile with a non-empty `readDenyList`
   (`read-deny-list-requires-mount-view`), and `defaultSandboxProfile` and
   `sandboxProfileFromPolicy` both populate it on every real path. Specification
   §4.4 — written after flow 145's review found this — replaces the translation
   with a **grant** model: grant the workspace, the session temp dir and the
   system roots; never grant `$HOME`; the deny list is then satisfied by
   construction rather than by translation. That rework is part of this flow,
   because without it the launcher would have nothing to launch.

## Expected Outcome

On a Linux host with Landlock ABI ≥ 3, a contained command runs under a
Landlock ruleset applied by a short-lived child, with no privilege, no
namespace, no LSM profile and no `bwrap` installed:

- `landlock.ts` translates the profiles the product actually builds, by granting
  rather than denying, and still refuses — explicitly, never partially — every
  profile whose boundary Landlock cannot carry;
- `landlock-exec.ts` restricts itself and `execve`s the real command, so the
  restriction is inherited by everything the command spawns and no Bun process
  stays resident in the tree;
- `wrap.ts` selects the layer per profile: Landlock when it is expressible,
  bubblewrap when it is not and `bwrap` can serve it, fail-closed when neither;
- `detect.ts` reports a resolved layer instead of a presence boolean, without
  changing its callers;
- the run receipt and `sandbox status` name the layer that actually ran, from
  the parent's decision — never from the child's exit code, which a contained
  command can forge.

## Out of Scope

- **Step 4** — the documentation sweep across `keryx-os-sandbox`, the
  verification runbook and the roadmap. This flow updates only the documents its
  own changes make wrong.
- **Step 5** — live verification on a stock Ubuntu host with no AppArmor profile
  (AC10/AC11 of the specification). This machine no longer qualifies: the
  `bwrap` AppArmor profile was installed here on 2026-08-08.
- **`network: "off"` under Landlock** — needs a seccomp filter for UDP, raw and
  unix sockets (specification §4.3). That profile keeps selecting bubblewrap.
- **The container layer, rootless podman, domain allowlists and credential
  masking on Linux** — deferred whole in ADR-0010.
- **macOS.** `seatbelt.ts` and its tests are not touched.
