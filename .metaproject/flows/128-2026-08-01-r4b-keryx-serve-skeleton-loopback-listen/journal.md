# Flow Journal

- 2026-08-01T09:32:04.039Z - flow created
- 2026-08-01T09:34:57.016Z - task-added: T5: Extract configDir into src/lib/config-dir.ts and repoint both existing copies
- 2026-08-01T09:34:57.165Z - task-added: T6: CLI wiring (src/commands/serve.ts + cli.ts) and command-registry verb classification
- 2026-08-01T09:34:57.320Z - task-added: T7: Mutation-check every guard and record what went red
- 2026-08-01T09:34:57.469Z - task-added: T8: Verification gates: tsc --noEmit, full bun test, keryx health run
- 2026-08-01T09:35:33.031Z - frozen: 12 criteria; checksum recorded
- 2026-08-01T09:35:33.213Z - started
- 2026-08-01T09:35:35.853Z - task-done: T1: Collect remaining context
- 2026-08-01T09:47:12.176Z - task-done: T5: Extract configDir into src/lib/config-dir.ts and repoint both existing copies
- 2026-08-01T09:47:12.342Z - task-done: T2: Implement per plan
- 2026-08-01T09:56:12.945Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-01T09:56:13.126Z - task-done: T6: CLI wiring (src/commands/serve.ts + cli.ts) and command-registry verb classification
- 2026-08-01T10:08:22.002Z - task-done: T7: Mutation-check every guard and record what went red

## Mutation-check record (T7)

Every guard in this slice was removed or inverted, the suite run, and the guard
restored. A guard that was never observed failing is decorative, so this table
is the evidence that each one is not. 21 mutations, 21 red.

| Mutation | What was changed | Tests that went red |
|---|---|---|
| naive `===` compare | `constantTimeEqual` replaced by an early-returning byte loop with a length short-circuit | 3 in `serve-credential.test.ts`: "reads every index even when the FIRST byte already differs", "reads the same indices whether the difference is first or last", "does not short-circuit on a length mismatch" |
| auth-before-routing | moved the 404 route check above the authentication check | "an unauthenticated request to an unknown path is indistinguishable from one to a known path" |
| route exact-match | `ROUTES.has(pathname)` → `startsWith` prefix match | "only two paths exist; everything else is 404 for an authenticated caller" |
| method guard | deleted the 405 branch | "a non-GET method on a real route is 405 and executes nothing" |
| non-loopback acknowledgement | disabled the acknowledgement check in `resolveServeStartup` | 6, across all three levels: unit, CLI status, and two real-subprocess AC3/AC4 tests |
| both acknowledgement halves | dropped `&& runtimeAck` from the CLI overlay | "a configuration acknowledgement alone is not enough" |
| loopback fails closed | unparseable address → `true` instead of `false` | 5 classification cases incl. `0177.0.0.1`, `2130706433`, `127.0.0.1.evil.com` |
| config whitelist projection | spread the raw input into the projected config | 3, incl. "an undeclared key never reaches the file, so a raw token cannot be persisted" |
| credentialRef must match | disabled the config↔store credential id check | 2, incl. the real-subprocess "nothing bound" case |
| issue refuses overwrite | allowed `issue` to replace a live credential | 2 |
| rotate invalidates | made rotate return the previous record without writing | 3 |
| token hashed, not stored | added the raw token to the persisted record | 2 |
| drain releases port | removed `await server.stop(true)` | 4, incl. both real-signal AC10 tests |
| refusal does not bind | made the refusal path bind a socket anyway before returning | 6, incl. 4 real-subprocess "nothing bound" probes |
| coverage exclusion | renamed the `serve` exclusion verb | 2 in `command-registry.coverage.test.ts` |
| sanitizer: unknown option | dropped `sanitizeForDisplay` | "an unknown option echoing hostile argv" |
| sanitizer: unexpected argument | dropped `sanitizeForDisplay` | "an unexpected positional argument echoing hostile argv" |
| sanitizer: unknown serve/token/config command | dropped `sanitizeForDisplay` (3 separate sites) | 3, one per site |
| sanitizer: printConfig profile | dropped `sanitizeForDisplay` | "config init accepting a hostile profile name, then showing it" |
| sanitizer: status bind address | dropped `sanitizeForDisplay` | "status rendering a hostile bind address" |
| sanitizer: refusal message | dropped `sanitizeForDisplay` | "the bind-failure message, which embeds the hostile hostname" |
| CLI port validation (both sites) | replaced with a bare `Number()` | 2, incl. the specific-message assertions |

The coverage guard also failed for real before it was updated: adding `serve` to
`CLI_ROUTES` turned `command-registry.coverage.test.ts` red with
`unclassified: ["serve"]`, which is the guard doing its job unprompted rather
than being told to.

### Gaps found by mutation and then closed

Four sanitizer sites survived their first mutation — the tests passed with the
sanitizer removed, so those call sites were not actually guarded:

1. `Unexpected argument` — no test drove a hostile positional. Test added.
2. The refusal message — no test reached a `bind-failed` message, which is the
   only refusal that embeds the operator's hostname. Test added.
3. Both `--port` validations — the schema projection caught the bad value one
   layer down, so the test passed either way and the CLI-level check was
   unverified. The tests now assert the specific message.
4. The `--json` warnings path — JSON escaping already neutralises a control
   character, so stripping was unobservable. Resolved by REMOVING the strip and
   following the R4a precedent (`emitProjectsJson`): JSON output escapes and the
   consumer decides; only the human path strips. A test now pins that the JSON
   stays parseable and carries no raw ESC.

Two sanitizer sites are provably unreachable by hostile input and are documented
as such in the source rather than counted as tested controls: the
`Option <flag> needs a value` message (the flag name is always a declared
literal) and the `listening on …` line (only reached after the kernel accepted
the address, and an address containing a control character does not resolve).

## Review round (project-local reviewers)

Three project-local reviewers ran against the staged diff:
`.metaproject/skills/gdskills/review/review-security-code`, `review-logic` and
`review-testing-practices`. All three returned `DONE_WITH_CONCERNS`. 3 major
findings, 21 minor/info. Every one is dispositioned below.

The flow-127 lesson says a fix round is new code deserving its own review, so
every behavioural fix here got a failing test first and every new guard was
mutation-checked (12 more mutations, all red — table at the end).

### Majors — fixed

**SEC-1 — `token revoke` and `token rotate` had no effect on a running
listener.** The credential was resolved once in `resolveServeStartup` and closed
over. The reviewer executed it: revoke printed success, the store on disk went
to `active: null`, and the old token kept returning 200 for the life of the
process; after rotate the OLD token worked and the NEW one did not. Directly
contradicts `security-policy.md` ("Revocation takes effect … immediately for new
[requests]"; rotation "does not silently keep both valid"), and it is the exact
control an operator reaches for after a token leak.
*Fix:* `ServeContext.credential` became `resolveCredential: () =>
ServeCredentialResult`, read per request. `absent` and `unreadable` both deny,
so deleting or corrupting the store is neither a way to keep the last-known-good
credential alive nor a way to turn authentication off.

**SEC-2 — mode 0600/0700 was applied only at creation.** `writeFileSync`'s and
`mkdirSync`'s `mode` are creation-time only, and the shared user-global
directory is normally created first by `saveShellConfig` with no mode at all —
so under the common `umask 002` it is already 0775 (group-writable) by the time
serve runs, and the mode argument is a no-op. The reviewer demonstrated the
consequence end to end: on a 0775 directory an attacker replaces
`serve-credentials.json` with a salt and hash of a token they chose, repoints
`serve.json`, authenticates as the operator, and locks the operator out. The
existing mode tests could not catch it — they stat a file the test itself just
created.
*Fix:* `chmod` the directory to 0700 and the file to 0600 after every write, and
fail closed in `readServeCredential` when the store is group- or
other-accessible, because a widened mode means something outside keryx touched
it and it may already have been replaced. `rotate` is the documented recovery
and is now tested as one.

**LOGIC-1 — a failed configuration repoint exited 0.** `token issue`/`rotate`
persist the credential first and then repoint `serve.json`. When that second
write failed the code printed a bullet on **stdout** and returned without
setting an exit code — leaving a dead old token, a new token the server refuses,
a config that will not start, and a success exit status.
*Fix:* routed through `fail()` (exit 1) with a message naming the file and the
two commands that recover.

### Minors and info — fixed

| Finding | Disposition |
|---|---|
| SEC-3: `/v1/projects` forwarded R4a's terminal-facing warnings, disclosing the config-directory absolute path (and so the OS username) | Warnings are now projected to bounded codes (`registry-entries-dropped`, `registry-unreadable`, fallback `registry-warning`) by an ALLOWLIST, so an upstream warning added later cannot leak by default. Project paths stay — those are the addressing the schema defines. |
| SEC-4: the credential store was written unlocked, unsynced, in place; 8 concurrent `issue` runs printed 6 tokens of which 1 worked | `withRegistryLock` extracted to `src/lib/file-lock.ts` and reused; the store is now temp+fsync+rename. A real 8-subprocess test asserts exactly one token is printed and that it is the one that works. |
| SEC-5: the "a hostname is never resolved" comment was false — `Bun.serve` resolves `localhost` | Comment corrected: `localhost` is the one name accepted, by RFC 6761 reservation rather than by resolution; the `/etc/hosts` caveat is stated as an accepted residual. |
| SEC-6: the module header claimed no branch binds then degrades, but the `bind-failed` port check does | Header corrected to state the exception and that the socket is closed before the refusal is returned. |
| LOGIC-2: `state = "draining"` was decorative — removing it broke nothing | A test now observes it on a REAL listener (the flip is synchronous, so it is deterministic). The comment now states that the 503 window is empty by construction today and becomes reachable when a route does asynchronous work. |
| LOGIC-3: three escape tests asserted that a FIXED literal contains no control characters | Renamed and re-scoped to assert the real property — those paths echo *nothing* of the hostile input — with a marker that fails if they start echoing. |
| LOGIC-4: `src/session/paths.ts` has a third resolver (`keryxDataDir`) with a `KERYX_DATA_DIR` override, so the "existed twice" header was wrong | Header corrected and the divergence recorded. Deliberately NOT unified: teaching `keryxConfigDir` about `KERYX_DATA_DIR` would relocate the `auth.json` of any install that sets it. That is a migration, not a cleanup. **Left open.** |
| LOGIC-5: `credentialRef.store: "os-credential-store"` was accepted and silently ignored | New terminal refusal reason `unsupported-credential-store`, named in the message, covered at unit and process level. |
| LOGIC-6: duplicate value flags silently last-wins | Repeats of any flag, value or boolean, are now refused. |
| LOGIC-7: `--profile ""` / `--bind "  "` produced the generic writer message | CLI-level validation with a message naming the flag. |
| LOGIC-8: an unbracketed IPv6 bind printed an unparseable URL, and the process harness's port regex assumed IPv4 | Authority is bracketed; the regex accepts a bracketed literal; a real `::1` listener test asserts the printed line parses. |
| LOGIC-9: `/v1/status` omitted the trailing newline every other response has | Framed like the rest. |
| LOGIC-10: `fail()` did not sanitize while `warn()` did | Sanitizes at the source now, not per call site. |
| LOGIC-13: `&& expected.length === 32` in `verifyServeToken` was dead | Removed; the comment explains why the length is already folded into the accumulator. |
| TEST-1: `expect(startup.ok && startup.nonLoopback).toBe(false)` is satisfied by a refusal | Split into the two assertions it meant. |
| TEST-2: AC4 covered 5 of 6 refusal reasons, and 2 of them asserted no message | `bind-failed` and `unsupported-credential-store` now have process-level tests; `disabled` and the credential mismatch assert their messages. |
| TEST-3: the credential-shape assertion passed on an empty projection | Project count pinned first. |
| TEST-4: the 401-body test could not fail | A positive control now proves those values ARE reachable when authenticated. |
| TEST-6 / LOGIC-11: a comment claimed a non-vacuity the line did not have | Comment corrected to say what the line actually asserts. |
| TEST-7: `config-dir.ts` had no test, and the "one resolver" guard compared same-argument paths | New `src/lib/config-dir.test.ts` exercises the no-argument form and pins all four consumers against it; mutation-checked with a divergent fourth resolver. |
| TEST-9: five escape tests asserted only `captured.length > 0` | Each now pins the exact sanitized residue (`sub]0;PWNED[2Jcmd`), which also documents that the sanitizer strips control BYTES and leaves printable text. |
| TEST-10: the escape guard was blind to newline injection | Two tests added: `sanitizeForDisplay` fuses across `\n`, and a forged output line cannot be produced from argv. |
| TEST-11: one escape test could have bound the fixed default port 7377 | Given `--port 0`. |
| TEST-12: near-tautologies on freshly produced values | Replaced with exact-value assertions; the random-independence assertion on the fingerprint was replaced with the property that actually matters (it is not a prefix of the hash). |
| TEST-13: the 401-identity test never pinned the status code | Pinned. |
| TEST-14: four headers claimed "the suite runs concurrently"; measurement shows bun runs files sequentially in one process | Corrected everywhere, including `context.md` and `plan.md`. The port-0 rule stands on the reasons that are true. |
| Missing negatives: lowercase `bearer` scheme accepted; 404/405 over a real socket | Both added. |
| TEST-8 / F-012: the borrowed-port race, and an AC3 guard that fails by 30s timeout | Documented as accepted residuals rather than designed away. A refusal has no port of its own to report, and the alternative is asserting on a log line, which AC4 forbids. |

### Deliberately left open

- **The `keryxDataDir` divergence** (LOGIC-4). Recorded in `config-dir.ts` and
  above. Unifying it is a migration of existing installs, not part of this slice.
- **`sanitizeForDisplay` strips C0/C1 only**, so U+202E (right-to-left override)
  passes through. Pre-existing R4a behaviour, not introduced here, and it affects
  every command that renders a filesystem-derived string — a fix belongs at that
  level, not inside `keryx serve`.
- **The residual two-write window** between minting a credential and repointing
  `serve.json`. A crash between them now produces a loud, actionable, non-zero
  failure rather than a silent one, which is the property that matters; making it
  a single atomic write would mean the credential module writing the config file.

### Fix-round mutation checks (12 more, all red)

| Mutation | Tests that went red |
|---|---|
| credential resolved once at startup instead of per request | 3 (revoke on a live listener, rotate on a live listener, unreadable store) |
| authentication accepts a non-`ok` credential result | 2 |
| forward R4a warning strings verbatim instead of codes | 2 |
| disable the `os-credential-store` refusal | 2 (unit + real subprocess) |
| remove `state = "draining"` | 1 (now observed on a real listener) |
| remove the duplicate value-flag rejection | 1 |
| remove the duplicate boolean-flag rejection | 1 |
| make `requireNonBlank` always true | 2 |
| repoint failure warns instead of failing | 1 |
| remove the IPv6 bracketing | 1 (real `::1` listener) |
| a divergent fourth config-dir resolver | 2 |
| remove the credential lock | 1 (8-subprocess concurrency) |
| remove the store permission check | 2 |
| remove the directory chmod | 1 |
| truncating store write instead of temp+rename | 1 |

One tightening survived its mutation and is documented as untested rather than
claimed: the post-rename `chmod` of the store file. `openSync(…, 0o600)` cannot
produce anything wider under an ordinary umask, so no test here can fail when it
is removed; it is kept for filesystems carrying a default POSIX ACL, which grant
group access to new files whatever mode the caller asked for.
- 2026-08-01T10:51:28.522Z - task-done: T8: Verification gates: tsc --noEmit, full bun test, keryx health run
- 2026-08-01T10:51:28.605Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-01T10:52:33.662Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/216
- 2026-08-01T10:52:49.731Z - ac-confirmed: AC1: Ran 'bun run src/cli.ts serve status' as a real subprocess with XDG_DATA_HOME pointed at an empty temp dir (serve.process.test.ts 'a fresh install reports stopped at exit 0 and binds nothing'): exit code 0 from proc.exited, stdout contained 'stopped', and Bun.file(serve.json).exists() and Bun.file(serve-credentials.json).exists() were both false. In-process (serve.cli.test.ts) the same run left filesUnder(configDir) === [] — no file written at all — and 'serve status --json' returned {state:'stopped', pendingApprovals:0, credential:'absent'}.
- 2026-08-01T10:52:49.811Z - ac-confirmed: AC2: serve-server.test.ts drove six 401 variants (no header, 'Bearer', 'Basic abc', 'Bearer ' empty, wrong token, token minus last char) and collected {status, body, sorted headers} into a Set: size was 1, i.e. byte-identical. The body parsed to exactly {error:{code:'unauthorized',message:'Unauthorized.'}} and contained none of the token, credential id, hash, salt, the distinctive profile name, the project name, the workspace path or the config dir — with a positive control first proving 'alpha' and that profile name ARE returned to an authenticated caller, so the absence is meaningful. A correct token returned 200, and lowercase/mixed-case 'bearer' also returned 200. Constant-time: index-counting proxies show all 32 indices of both sides read when byte 0 differs, equal read counts for first-byte vs last-byte differences, and all 32 indices of the longer side read on a length mismatch. Mutation: replacing the body with an early-returning === loop turned those three tests red.
- 2026-08-01T10:52:49.892Z - ac-confirmed: AC3: Real subprocesses (serve.process.test.ts). Config acknowledgement alone: exit != 0, stdout named --acknowledge-non-loopback, Bun.connect to the configured port refused. Run flag alone: exit != 0, connection refused. Both halves: the process bound, GET /v1/status returned 200 with nonLoopback true, and 'serve status --json' afterwards reported {state:'configured', nonLoopback:true}. The non-loopback fixture address is 0177.0.0.1 — the classifier fails closed on leading-zero octets and calls it non-loopback while the kernel resolves it to 127.0.0.1, so security-policy.md's ban on a fixture opening a real non-loopback listener is honoured. Mutation: disabling the acknowledgement check turned 6 tests red across unit, CLI-status and subprocess levels; dropping '&& runtimeAck' from the CLI overlay turned the config-alone test red.
- 2026-08-01T10:53:07.451Z - ac-confirmed: AC4: All six ServeRefusalReason members have a real-subprocess test in serve.process.test.ts. For each: exit code read from 'await proc.exited' (never through a pipe), the message asserted, and Bun.connect to the configured port asserted to fail. no-configuration -> 'keryx serve config init'; no-credential -> 'keryx serve token issue'; unreadable-credential -> 'unreadable'; disabled -> 'disabled' + 'keryx serve config init'; non-loopback-not-acknowledged -> 'acknowledge'; credential-mismatch -> 'does not match the credential in the store'; unsupported-credential-store -> names both stores; bind-failed -> 'could not bind', with the occupying server still answering 'occupant' on its port afterwards. Mutation: making the refusal path bind a socket anyway before returning turned 6 tests red including 4 subprocess no-socket probes.
- 2026-08-01T10:53:07.531Z - ac-confirmed: AC5: serve.cli.test.ts counted occurrences of the issued token in the whole captured transcript: exactly 1 (transcript.split(token).length - 1 === 1), on a line matching /^\s*token:\s*(\S+)$/ accompanied by 'shown once'. Reading serve-credentials.json back showed keys exactly [algorithm, createdAt, hash, id, salt] with hash and salt each /^[0-9a-f]{64}$/ and the token absent from the bytes. Running status, status --json, config show, --help, 'token' with no subcommand and an unknown subcommand afterwards produced >200 chars of output containing the token zero times; a real-subprocess repeat of the same sequence agreed. rotate: the new token verifies, the old one does not, exactly one 'active' id is present, the old token is absent from the file, and both take effect on an ALREADY-RUNNING listener (old -> 401, new -> 200). revoke: loadServeCredential returns null, the token is gone from the file, and a live listener returns 401 for it. A second 'issue' refuses with a message naming 'rotate' rather than silently invalidating.
- 2026-08-01T10:53:07.616Z - ac-confirmed: AC6: serve.cli.test.ts runs a full lifecycle (config init, a refused serve, token issue, status, status --json, config show, token rotate, status, config show, token revoke), then walks every file under the fixture config dir and reads its bytes: files.length > 0 and neither the issued nor the rotated token appears in any of them. Every captured stdout+stderr line after the two issue/rotate lines is asserted not to contain either token. At the library level serve-config.test.ts writes a config polluted with a 'token' key and reads the file back: the secret is absent and 'cred-1' survives. serve-credential.test.ts asserts the raw store bytes never contain the token. Nothing under .metaproject is written at all (AC11), so there is no artifact for it to reach. Mutation: spreading the raw input into the projected config turned 3 tests red including 'an undeclared key never reaches the file'; adding the raw token to the persisted record turned 2 red.
- 2026-08-01T10:53:23.726Z - ac-confirmed: AC7: GET /v1/projects is in the path set of the indistinguishability test, so an unauthenticated call gets the same 401 as every other path; authenticated it returns 200. With two projects registered the body carried schemaVersion 1 and both entries with their displayName, absolute path and state 'active'; a project whose directory was removed came back present with state 'missing' rather than dropped. hasSecretShapedField(body) is false with the project count pinned to 1 first, so the check cannot pass on an empty list, and the body contains neither the token nor the stored hash. The route calls listProjects/emitProjectsJson from R4a rather than reimplementing them. Warnings are projected to bounded codes: a registry with a malformed entry yields exactly [{code:'registry-entries-dropped',count:1}] and an unparseable one [{code:'registry-unreadable',count:1}], with the config-dir path and the string 'projects.json' both absent from the response; a healthy registry yields []. Mutation: forwarding the raw R4a warning strings turned 2 tests red.
- 2026-08-01T10:53:23.808Z - ac-confirmed: AC8: Authenticated GET /v1/status returned 200 with state 'listening', profile 'remote-restricted', bind {address:'127.0.0.1', port: <the BOUND port>} — proven to be the bound and not the configured port by overriding boundPort to 54321 in the context and by an end-to-end fetch on a port-0 listener where body.bind.port equalled listener.port — nonLoopback false, and pendingApprovals exactly 0. With an acknowledged non-loopback bind the same route reported nonLoopback true. The raw response text contains none of the token, the stored hash, the salt or the credential id. Unauthenticated it returns the same fixed 401 as every other path.
- 2026-08-01T10:53:23.890Z - ac-confirmed: AC9: Authenticated, nine other paths (/, /health, /v1, /v1/, /v1/status/, /v1/statusx, /v1/turns, /v1/projects/1, /V1/STATUS) each returned 404 with body exactly {error:{code:'not-found',message:'Not found.'}}; POST/PUT/PATCH/DELETE/HEAD/OPTIONS on both real routes each returned 405 with {error:{code:'method-not-allowed',message:'Method not allowed.'}}. Both hold over a REAL socket too, HEAD included. Unauthenticated, 6 paths x 3 methods produced a single distinct {status, body, sorted-headers} shape with the status pinned to 401, so an unknown path is indistinguishable from a known one. Mutation: moving the route check above authentication turned the indistinguishability test red; changing ROUTES.has to a startsWith prefix match turned the 404 test red; deleting the 405 branch turned the method test red.
- 2026-08-01T10:53:38.101Z - ac-confirmed: AC10: Real subprocess, '--port 0', port read from the process's own 'listening on' line. SIGTERM: exit code 0 from proc.exited, Bun.connect to the port then failed, and Bun.serve rebound that exact port and answered 'rebound' to a fetch — the port is genuinely released, not merely closed to us. SIGINT: same, exit 0 and the port no longer accepts. In-process, drain() flips a REAL listener to 'draining' synchronously (observed before awaiting the returned promise), then to 'stopped'; a second drain() is a no-op. The 503 branch is exercised against the handler and documented in the source as unreachable-by-construction today (the handler is synchronous and stop(true) force-closes), becoming reachable the moment a route does asynchronous work. Mutation: removing 'await server.stop(true)' turned 4 tests red including both real-signal ones; removing the draining flip turned the real-listener state test red.
- 2026-08-01T10:53:38.184Z - ac-confirmed: AC11: serve-server.test.ts builds a fixture project containing .metaproject/flows/001/flow.json, registers it, and takes a full recursive inventory of path -> 'size:mtimeMs' for every file under it. It pins that flow.json is actually in that map (so the inventory is not empty), then exercises /v1/status, /v1/projects and an unknown path, each with GET and POST, authenticated and unauthenticated, and compares the inventory with toEqual — which catches additions and deletions as well as modifications. The maps are identical. This is an inventory-and-mtime comparison, not an inspection of the code; the fixture tree is used rather than the repo's own .metaproject so the result cannot be perturbed by anything else running.
- 2026-08-01T10:53:38.269Z - ac-confirmed: AC12: Run after the fix round, on the committed tree: 'bunx tsc --noEmit' exited 0 with no output; 'bun test' reported 2540 pass / 14 skip / 0 fail across 269 files; 'keryx health run' printed '# Code Health: PASS', score 93, trend stable, 'PASS: no gate conditions triggered'. The command-registry coverage guard is green with 'serve' classified in EXCLUSIONS with a stated reason; it is not decorative — adding 'serve' to CLI_ROUTES turned it red unprompted with unclassified: ['serve'] before the exclusion was written, and renaming the exclusion verb turns two of its tests red.
- 2026-08-01T10:53:43.233Z - completing
- 2026-08-01T10:53:44.826Z - done: all gates passed
