# T23 independent containment/SAC correctness review

Verdict: **REQUEST_CHANGES**

## Scope and method

This review covered the approved containment contract and the other-authored filesystem reader implementation in `src/lib/contained-read.ts`, `src/lib/descriptor-read.ts`, and `src/sac/secure-resource-read.ts`, plus the existing containment tests. It excluded the output validator, health work, production edits, network activity, model calls, dependency changes, and global tests.

The initial broader security-review attempt was stopped at the planned discovery-race probe by automatic risk review. No discovery-race or exploit probe was created or run. The review then continued under the narrowed correctness-only scope. The already-completed bounded temporary-file size check is retained as evidence because it exercised only this repository's local SAC wrapper and deleted its fixture.

## Stage 1: specification compliance

**Result: FAIL**

| Criterion | Result | Evidence |
| --- | --- | --- |
| Internal links remain readable while external/replaced owner or target identities are refused without disclosure | PASS for the shared contained reader | `readContainedFile` resolves inside the owner and pins root/target identities at `src/lib/contained-read.ts:47-72`; the descriptor chain rechecks the root and final descriptor at `src/lib/descriptor-read.ts:68-95`. Existing focused tests at `src/lib/contained-read.test.ts:37`, `:80`, and `:98` pass. The T17 owner-replacement probe returned `CONTAINED_READ_RACE`. |
| Regular-file, byte-limit, and supported-platform behavior is explicit, including SAC compatibility | FAIL | The shared contained reader defaults to 8 MiB and regular files at `src/lib/contained-read.ts:28` and `:42-68`; the descriptor implementation enforces supplied options and fails unavailable platforms at `src/lib/descriptor-read.ts:60-65`, `:89-95`, and `:140-159`. The SAC wrapper omits both options at `src/sac/secure-resource-read.ts:15`, so those guarantees do not reach SAC reads. Finding F-001. |
| Focused evidence covers the approved behavior | PARTIAL | The three approved containment suites pass 17/17. They cover the shared reader, MCP reads, and harness reads, but there is no SAC-wrapper regression asserting the regular-file and maximum-byte policy. |

### F-001 — blocker — SAC bypasses the mandatory regular-file and byte-limit policy

`readWorkspaceFileNoFollow` calls `readDescriptorChain(workspaceRoot, absolutePath)` with the permissive option defaults. The lower-level reader only adds `O_NONBLOCK` and checks `isFile()` when `requireRegularFile` is true, and only bounds allocation/read length when `maxBytes` is supplied. Therefore the SAC entrypoint preserves `O_NOFOLLOW` but does not preserve the file-type or size guarantees required by AC2.

Concrete evidence: a bounded local fixture containing exactly 8 MiB + 1 byte was accepted and returned all `8,388,609` bytes through `readWorkspaceFileNoFollow`. The command exited zero and removed its temporary directory. Immutable gdctx record: `.metaproject/data/gdctx/raw/2026-09-06T12-40-02-860Z_run.log`.

Impact: repository-controlled SAC evidence/resource inputs can bypass the shared 8 MiB limit. Non-regular inputs also reach a blocking final open because the SAC wrapper does not request the regular-file policy. This leaves an explicit acceptance criterion unimplemented at the SAC boundary.

Suggested fix: make the SAC wrapper pass a named bounded policy, including `requireRegularFile: true` and the approved maximum byte count, to `readDescriptorChain`. Add direct wrapper regressions for an over-limit regular file and a non-regular input while keeping the existing unsupported-platform behavior fail-closed. Do not replace its descriptor chain with a path-based read.

Class scope: the omission is centralized at `src/sac/secure-resource-read.ts:15`; every SAC caller of `readWorkspaceFileNoFollow` inherits it. Enumeration method: inspected the complete 16-line wrapper and the complete descriptor option/enforcement paths.

## Stage 2: logic/security quality

**Result: BLOCKED**

The local review workflow requires Stage 1 to pass before Stage 2. Because F-001 leaves AC2 incomplete, no complete Stage 2 quality verdict is claimed. Within the passing Stage 1 surface, the shared reader correctly compares stable directory/file identities, rejects unsupported descriptor capability explicitly, enforces regular-file/byte policy by default, closes descriptors in `finally`, and returns fixed error text rather than resolved target paths.

## Verification evidence

- Focused suites: 17 passed, 0 failed. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-39-33-931Z_run.log`.
- Existing owner replacement probe: `{"refused":true,"code":"CONTAINED_READ_RACE"}`. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-39-39-868Z_run.log`.
- Bounded SAC size check: accepted 8 MiB + 1 byte. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-40-02-860Z_run.log`.

Routing audit: `graph_used: yes` (reported 142 uncommitted code files, so it was treated as stale and not relied on for the verdict); `wiki_used: yes` (accepted containment/SAC component context); `ctx_used: yes`; `raw_rg_used: no`.
