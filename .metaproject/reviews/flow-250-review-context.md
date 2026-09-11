# Review context — flow 250, MCP servers P3b (OAuth)

Read this before reviewing. It exists so you spend your budget on
finding defects rather than rediscovering constraints.

## Request

- Branch: `feat/mcp-servers-p3b`
- Merge-base: `1571131fc123e9b32ed57e0f7f41329c896f3250`
- Scope mode: diff (`git diff 1571131f...HEAD -- src/ scripts/`)
- 20 files, ~3740 insertions, ~10 deletions
- Version being released: 0.2.95

## What the change does

`keryx mcp auth <name>` — OAuth for remote MCP servers, so a server
needing a login can be used without pasting a bearer token into a
config file. New modules:

| File | Role |
|---|---|
| `src/mcp-servers/credentials.ts` | The owner-only token store. One file, `mcp-credentials.json`, keyed `{name}:{url}`. |
| `src/mcp-servers/oauth-callback.ts` | The loopback listener that catches the authorisation redirect. |
| `src/mcp-servers/oauth-provider.ts` | keryx's `OAuthClientProvider` for the MCP SDK. |
| `src/commands/mcp-servers.ts` | The `auth` subcommand and `runOAuthFlow`. |
| `src/mcp-servers/runtime.ts` | Session-time wiring (`sessionAuthProviderOptions`). |
| `src/mcp-servers/doctor.ts` | `needs_auth` diagnosis and `needsAuthorisation`. |

## Constraints that are DECISIONS, not oversights

Do not report these as findings. If you believe one is wrong, say so
explicitly as a challenge to the decision, with the concrete failure
it causes.

1. **Sessions never start an OAuth flow.** Only `keryx mcp auth` may
   open a browser. `sessionAuthProviderOptions` hard-codes
   `interactive: false`. A session that launched a consent screen
   nobody asked for, or blocked a headless shell, is worse than a
   refusal naming the command.
2. **Interactivity is passed in, never sniffed at the point of use.**
   A function checking `process.stdout.isTTY` deep inside itself
   cannot be tested for the headless case without lying to the
   process.
3. **403 is deliberately NOT `needs_auth`.** Authenticated and not
   permitted: re-running `keryx mcp auth` grants no scope.
4. **`server_error`/`temporarily_unavailable` are NOT `needs_auth`.**
   Same endpoint would fail the same way.
5. **The pre-emptive `needs_auth` branch in `doctor` fires only for an
   explicitly declared `oauth` block.** Using `usesOAuth` as the gate
   would stop doctor dialling every PUBLIC remote server. This was a
   real regression, caught and reverted.
6. **`usesOAuth` reads the RAW declared headers, not resolved ones.**
   Resolution fails exactly when a credential variable is unset, which
   is when the question is asked.
7. **A corrupt credential store is refused, never reset.** Losing
   every other server's token to save one is not a trade the operator
   agreed to.
8. **The SDK is never statically imported under `src/`** (boundary
   C0-2, enforced by `src/mcp/boundary.test.ts`) so it stays out of
   cold start. Test files included.
9. **`keryx ctx rg` replaces bare `rg`/`grep`** in this repository.

## Known-and-recorded, do not re-report

- 8 surviving mutants are recorded as equivalent with per-entry
  reasoning in `docs/requirements/keryx-mcp-servers/mutation-equivalents.md`.
  The weakest entry is named as such (`oauth-callback.ts:156`).
- `oauth-callback.ts:166` (`if (done) return;`) is a clarity guard;
  a second `resolve` on a settled promise is a no-op.

## Verification already performed

- `bun test`: 9505 pass, 19 skip, 0 fail, 738 files
- `bunx tsc --noEmit`, `bun run lint`, `skills verify --bundled`: clean
- Mutation sweep over the diff: 116 mutants, 108 killed, 8 equivalent,
  0 unexplained survivors, 0 hangs — confirmed by a re-run after the
  killing tests landed
- Smoke test on the INSTALLED binary (npm pack → clean-room install →
  isolated HOME/XDG): version, headless refusal, bearer/stdio
  refusals, `needs_auth` for absent and expired credentials,
  `oauth: false` still dialled, zero token occurrences across 66KB of
  output from seven surfaces, 0600 mode throughout

## What I most want you to attack

The verification above is broad, which is exactly why I distrust it.
Specifically:

- **The token's lifetime in memory and on disk.** Is there any path
  where a token, refresh token, code verifier or authorisation code
  reaches a log, an error message, a thrown `Error.message`, a
  process argument, or a file other than `mcp-credentials.json`?
- **The callback listener as an attacker sees it.** It is a real HTTP
  server on the operator's machine holding an authorisation code.
  What can a local process, or a web page the operator visits, do to
  it? Is `state` validation sufficient? Is one-shot serving actually
  one-shot?
- **Failure modes that report success.** This diff had five of them,
  all found by mutation rather than by review. Are there more?
- **Concurrency.** Two `keryx mcp auth` runs at once; a session
  refreshing while `auth` writes; read-modify-write on the shared
  credential file.
- **The `oauth` field's validation** (`src/mcp-servers/config.ts`)
  against what `sessionAuthProviderOptions` and `runOAuthFlow`
  actually read from it.

## Acceptance criteria

All 18 are frozen and confirmed; see
`.metaproject/flows/250-2026-09-11-mcp-servers-p3b/acceptance-criteria.md`.
A finding that a criterion is confirmed but not actually met is a
blocker, and is the single most valuable thing you can return.
