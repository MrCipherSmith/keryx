# Implementation Plan

Status: formalized

## Approach

Five thin modules, each with one job, so every security property has exactly one
place it can be broken and exactly one place it can be tested.

```
src/lib/config-dir.ts        the one cross-platform user-global dir resolver
src/lib/serve-config.ts      serve.json: whitelist projection of the schema
src/lib/serve-credential.ts  salted-hash credential store + constant-time verify
src/lib/serve-server.ts      startup preconditions, Bun.serve, auth, 2 routes
src/commands/serve.ts        CLI: serve | serve status | serve token | serve config
```

The layering is strict and one-directional: `serve-server` knows nothing about
argv or terminals, `commands/serve` knows nothing about HTTP framing, and neither
`serve-config` nor `serve-credential` imports the other. Startup precondition
resolution is a **pure function** (`resolveServeStartup`) separate from the act of
binding, so refusal can be tested without a socket and binding cannot happen
without the function having returned `ok`.

### Why refusal is structurally terminal

`startServeListener` calls `Bun.serve` on exactly one line, and that line is
reachable only after `resolveServeStartup` returned `{ ok: true }`. There is no
branch that binds and then degrades. The test proves the property from outside —
by attempting a TCP connection to the configured address after the process exits
— rather than by reading a log line, because a log line is the implementation's
own claim about itself.

### Why authentication precedes routing

`api-protocol.md` requires an unauthenticated caller to learn nothing about what
exists. The fetch handler therefore authenticates before it looks at the URL: one
fixed 401 for missing, malformed and wrong tokens, on every path and every method.
Route dispatch is an exact-match lookup over a closed two-entry table — not a
prefix or pattern match, per the `allowlist-not-a-boundary` lesson.

### Why the constant-time compare is length-independent

The presented token is hashed with the stored salt before comparison, so the
compared values are always 32 bytes and the token's own length never reaches the
loop. The comparison itself still iterates the full width with no early return
and folds any length difference into the accumulator, so it is correct even if a
future caller hands it two raw values.

Testing it: a timing assertion is flaky in CI, so the guarantee is asserted
**structurally** — the comparison is fed index-counting proxies and must be shown
to read every index on both sides even when byte 0 already differs. That
assertion is then mutation-checked by substituting `===` and confirming it fails.

### Why the config is a whitelist projection

`stripSecretShapedFields` from R4a would delete `credentialRef` (see description
D2). Instead the writer projects only the keys the schema declares, so a raw
token cannot be persisted under any key name. AC6 then verifies the outcome
rather than the mechanism: a full lifecycle run scans the actual bytes of every
file written and every stream captured.

## Steps

1. **T1 — extract `configDir`.** New `src/lib/config-dir.ts`; `shell-config.ts`
   and `project-registry.ts` import it and lose their private copies. Existing
   tests must stay green with no edits — that is the regression proof.
2. **T2 — tests first.** Write `serve-credential.test.ts`,
   `serve-config.test.ts`, `serve-server.test.ts`, `serve.escape.test.ts` and
   `serve.cli.test.ts` against the intended API and confirm each fails for the
   stated reason (module missing, then behaviour missing).
3. **T3 — `serve-config.ts`.** Types, path, whitelist projection, load/save at
   0600, loopback classification.
4. **T4 — `serve-credential.ts`.** `constantTimeEqual`, issue/rotate/revoke/verify
   over a 0600 store holding `{ id, algorithm, salt, hash, createdAt }`.
5. **T5 — `serve-server.ts`.** `resolveServeStartup` (pure) + `startServeListener`
   + the fetch handler + `drain()`.
6. **T6 — `src/commands/serve.ts`** and the `cli.ts` wiring, mirroring the
   `projects.ts` argv discipline.
7. **T7 — classify the verb.** Add `serve` to `EXCLUSIONS` with its reason.
8. **T8 — mutation-check every guard**, record what went red, restore.
9. **T9 — verification.** `tsc --noEmit`, full `bun test`, `keryx health run`,
   then the project-local reviewers including security and logic.

## Risks

| Risk | Mitigation |
|---|---|
| Extracting `configDir` silently changes where an existing install looks for `auth.json` / `projects.json`. | The extracted function is byte-for-byte the same logic; the existing `shell-config.test.ts` and `project-registry.test.ts` suites run unchanged and are the regression proof. |
| A test binds a fixed port and collides with something else on the machine or a second CI job on the same runner. | Every test binds `port: 0` and reads the assigned port back from the server object. (Measured during review: bun runs test FILES sequentially in one process, so the original "the suite runs concurrently" justification was wrong; the rule is right for the other reasons.) |
| A drain test rebinds the just-released ephemeral port and races another process. | The rebind is attempted on the port the OS just released, which is not a fixed port; the assertion is that the bind succeeds, and a genuine failure to release would fail it deterministically. |
| `process.exitCode` does not reset between in-process command tests in Bun. | Exit codes for refusal are read from a real subprocess via `Bun.spawn().exited`, never through a pipe. |
| A signal handler registered by `keryx serve` leaks into the test process. | Signal handling lives in `src/commands/serve.ts` and is exercised only by subprocess tests; `startServeListener` itself registers nothing. |
| The token leaks into a `.metaproject` artifact through some path nobody thought of. | AC6 is verified by inventorying and reading the bytes of every file under the fixture config dir and `.metaproject` after a full lifecycle run, plus every captured stream — an outcome check, not a mechanism check. |
