# Flow Journal

- 2026-08-08T23:45:13.769Z - flow created
- 2026-08-08T23:49:17.705Z - task-added: T5: read the spike FFI reference, ADR-0010 and specification §4.4; produce the porting notes and the proposed grant set
- 2026-08-08T23:49:17.794Z - task-added: T6: tests for the grant model: AC1 profiles, AC2 refusals, deny-list-under-a-granted-root
- 2026-08-08T23:49:17.885Z - task-added: T7: rework landlock.ts to the grant model (handle read rights, grant roots, check the deny list)
- 2026-08-08T23:49:17.978Z - task-added: T8: tests for layer selection in wrap.ts and the resolved layer in detect.ts (AC3, AC8)
- 2026-08-08T23:49:18.071Z - task-added: T9: implement landlock-exec.ts: FFI applier, PATH resolution that refuses, execve, exit-status mapping
- 2026-08-08T23:49:18.161Z - task-added: T10: live enforcement tests with negative controls (AC4, AC5, AC6, AC7), skipped-with-reason below ABI 3
- 2026-08-08T23:49:18.250Z - task-added: T11: wire the Linux branch: wrap.ts layer choice, detect.ts layer field, adapter and callers unchanged
- 2026-08-08T23:49:18.342Z - task-added: T12: prebundle landlock-exec to a single .js in the build step and resolve its path for dev and installed runs
- 2026-08-08T23:49:18.433Z - task-added: T13: record the layer that ran in the run receipt and in sandbox status, from the parent (AC10)
- 2026-08-08T23:49:26.331Z - task-added: T14: measure the benign $HOME grant set against real commands; record each granted entry as a reviewed widening
- 2026-08-08T23:49:26.424Z - task-added: T15: decide and record the newer-kernel ABI-clamp position and the environment-forwarding position
- 2026-08-08T23:49:26.516Z - task-added: T16: correct every document this flow's own changes falsify (os-sandbox surface docs, wiki, guide)
- 2026-08-08T23:49:26.613Z - task-added: T17: quality gate and review-orchestrator until green (AC11)
- 2026-08-08T23:49:42.045Z - frozen: 11 criteria; checksum recorded
- 2026-08-08T23:49:42.218Z - started

## T5 — porting notes and the proposed grant set

Sources read: specification §4.1–4.4 and §10; implementation-plan "Step 3";
spike/README.md "What Step 3's implementer must know"; spike/landlock-ffi.ts in
full; `landlock.ts` (all 707 lines), `landlock-abi.ts`, `wrap.ts`, `detect.ts`,
`profile.ts`, `index.ts`; gdgraph blast radius for `detect.ts`.

### The translator as merged is write-only, and that is the thing that changes

`handledFs = WRITE_ACCESS_RIGHTS` (12 rights, no read-ish ones). The module
header states the reasoning explicitly — consequence (1), "the profile's read
default is broad … so no read-ish access right is handled" — and `readDenyList`
is refused because a deny-exception under a broad allow has no representation.
That reasoning is correct about Landlock and wrong about the product:
`defaultSandboxProfile` and `sandboxProfileFromPolicy` populate `readDenyList`
on every path except `danger-full-access`, so the layer as merged serves nothing.

§4.4 replaces it: handle read rights too, and grant. The header's consequence
(1) and `WRITE_ACCESS_RIGHTS`'s doc comment both assert the opposite of what the
module will do, so both must be rewritten with the change — a stale comment here
is a claim about a security boundary.

### Proposed grant set (T14 measures it; this is the starting point, not the answer)

| Hierarchy | Rights | onMissing | Source |
|---|---|---|---|
| each `writableRoots` entry (already includes cwd **and** the session temp dir — `sandboxProfileFromPolicy` puts both there) | read + write set | `fail` | §4.4 |
| the workspace, in `read-only` mode | read set | `fail` | `writableRoots` is empty there, so the path must be **injected**; the module cannot invent it |
| `/usr /bin /sbin /lib /lib64 /etc /proc /sys` | read set | `skip` | spike's measured minimum for a command to start; `skip` because `/lib64` does not exist on aarch64 |
| the Bun install directory | read set | `skip` | only needed when the contained command is itself Bun; injected, not guessed |
| `/dev` | `read_file`, `read_dir` | `skip` | reads become restricted, so the existing three-literal write carve-out is no longer sufficient on its own |
| `/dev/null`, `/dev/zero`, `/dev/tty` | `write_file`, `truncate` | `skip` | the existing carve-out, kept verbatim — nested, so `/dev` stays read-only apart from these three |
| `/dev/shm` | read + write set | `skip` | tmpfs where `shm_open`/`sem_open` create regular files; **nested**, never by widening `/dev` |
| `$HOME` | — | — | granted by nothing. This is the whole mechanism (§4.4). |

Deliberately narrower than the spike, which grants `DEVICE_ACCESS` (including
write) across all of `/dev`. `ioctl_dev` stays unhandled, so the spike's device
ioctl grant has no counterpart here.

### Purity: the module cannot learn these paths, so they are injected

`landlock.ts` may not read `process.env`, `os.homedir()` or the filesystem — the
source guard enforces it. So `buildLandlockRuleset` gains an options argument
carrying `readRoots`, `home` and the workspace path, with the system list as an
exported constant default. `wrap.ts` supplies them from `ContainedCommand`
(`{ path, argv, env, cwd }`) and from injected `WrapOptions`, which is also where
the ABI, the Bun path and the bundled child's path arrive.

### `readDenyList` is checked, not translated (AC2)

Every entry must lie beneath no granted hierarchy. Entries under `$HOME` pass by
construction; an entry elsewhere — `/etc/keryx/auth.json` would be beneath the
`/etc` read grant — fails the translation. This is the one case §4.4's argument
does not cover, and the specification says so in its own words.

### Fail-closed positions carried from the spike

- Apply failure ⇒ exit 125, command never started. Never degrade an axis.
- PATH resolution refuses on a miss; no bare-name fallback (raw `execve` would
  resolve it against the workspace); candidate must be a **regular** file.
- `handled_access_fs` clamped to the measured ABI; a kernel **newer** than the
  table under-restricts silently, so the outcome must surface `abiClamped`.
- The exit code is a channel the contained command controls: 125 and 128+N are
  forgeable, so the boundary result is reported from the parent's decision on the
  run receipt (AC10), never inferred from the child's status.
- 2026-08-08T23:51:22.013Z - task-done: T1: Collect remaining context
- 2026-08-08T23:51:22.176Z - task-done: T5: read the spike FFI reference, ADR-0010 and specification §4.4; produce the porting notes and the proposed grant set

## T6/T7 — the grant model, landed

`landlock.ts` now handles the fifteen read **and** write rights and grants:
writable roots read-write, the injected workspace read-only where it is not
already writable, the system roots and any measured extras read-only, `/dev`
read+list, `/dev/shm` read-write nested beneath it, and the three writable
character devices nested beside it. `$HOME` is granted by nothing.

`readDenyList` is checked rather than translated: a denied path that overlaps a
granted hierarchy **in either direction** fails with
`read-deny-list-requires-mount-view` (which still routes to the bubblewrap
layer); one that overlaps nothing is expressible, which is the point of §4.4.
Overlap is segment-wise, so `/etcfoo` is not `/etc`.

**Correction to the T5 note:** the workspace read root's `onMissing` is `skip`,
not `fail`. The disposition rule is now crisp — only a writable root is fatal
when missing; every granted-back path is skipped, because skipping a read grant
can only over-restrict and `/lib64` legitimately does not exist on aarch64.

Signature change: `buildLandlockRuleset(profile, abi, options?)` with
`BuildLandlockRulesetOptions { workspace, home, systemReadRoots, extraReadRoots }`
— the module may not read the host, so the grant paths are injected.
`LandlockInexpressible.field` gains `"readRoots"` so a malformed injected path is
reported against keryx rather than against the operator's policy.

Evidence: `bun test src/harness/process/sandbox` 316 pass / 5 skip / 0 fail
(branch baseline 243/5/0); `landlock.test.ts` 101 pass; `bunx tsc --noEmit`
clean; `bun run test:guards` 275 pass — the purity guard still holds, so the
module acquired no host access along with the grant list.
- 2026-08-08T23:58:46.288Z - task-done: T6: tests for the grant model: AC1 profiles, AC2 refusals, deny-list-under-a-granted-root
- 2026-08-08T23:58:46.378Z - task-done: T7: rework landlock.ts to the grant model (handle read rights, grant roots, check the deny list)
