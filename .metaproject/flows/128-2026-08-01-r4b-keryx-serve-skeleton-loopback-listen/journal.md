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
