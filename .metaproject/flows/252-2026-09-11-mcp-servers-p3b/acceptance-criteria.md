# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Tokens are written ONLY through `writeOwnerOnlyFile`/`writeOwnerOnlyFileAtomic` into `{keryxConfigDir()}/mcp-credentials.json`, and a test asserts the file's mode is owner-only (0600) after a write. Spec AC14.
- AC2: Tokens are keyed `{serverName}:{serverUrl}`, so the same server name at a different url does not reuse a token and a renamed server does not silently inherit one. Asserted with both halves.
- AC3: NO token value is ever printed. `keryx mcp list`, `list --json`, `doctor`, `doctor --json`, the `/mcp` view and any error message show at most that a token is present and when it expires. A test drives a stored access token and refresh token through every one of those surfaces and asserts neither string appears.
- AC4: `keryx mcp auth <name>` in a NON-TTY process exits non-zero WITHOUT opening a browser and without hanging. Asserted by running the command with no TTY and a browser-opener that records invocation: exit code non-zero, opener never called, and the call returns rather than waiting. Spec AC20.
- AC5: A remote server whose credential is absent reports `needs_auth` naming the command to run, rather than dialling and reporting somebody else's 401.
- AC6: The loopback callback binds 127.0.0.1 only — never 0.0.0.0 — on an ephemeral port, and a test asserts the bound address. A callback listening on every interface is a token handed to whoever is on the network.
- AC7: The callback validates `state` and rejects a mismatch without exchanging the code. Tested with a wrong state, a missing state, and a replayed state after the flow completed.
- AC8: The callback serves exactly one request and then closes, so a second request with the same code reaches nothing. Asserted by issuing two.
- AC9: An error returned by the authorisation server (`?error=access_denied`) is reported to the operator as that error, not as a timeout or a generic failure, and no token is written.
- AC10: The whole flow is bounded: if the operator never completes it, `keryx mcp auth` gives up with a stated reason rather than waiting forever. Asserted by timing, with real margin between the budget and the assertion — not the same number twice.
- AC11: Dynamic client registration happens only when `oauth.clientId` is absent; when it is present the configured id is used and no registration request is made. Both directions asserted against a mock authorisation server that records what it received.
- AC12: A refresh token is used when the access token has expired, and a refresh failure degrades to `needs_auth` rather than to a crash or to a silent unauthenticated call.
- AC13: `keryx mcp auth` on a server that needs no OAuth (it has a header or a bearer variable) says so and changes nothing, rather than starting a flow that cannot help.
- AC14: OAuth state — tokens, client information, code verifier, discovery — never reaches a compat file or a native config file. Only `mcp-credentials.json` is written; a test asserts every other config file is byte-identical after a completed flow.
- AC15: The credential store is covered by a CLASS table using the shared `classTableProblems` rule, with a BOUNDARY in every class.
- AC16: Mutation coverage over the diff: every non-equivalent survivor is killed by a new test or recorded with the reason it is equivalent. Run in slices.
- AC17: `bun test`, `bunx tsc --noEmit`, `bun run lint` and `bun src/cli.ts skills verify --bundled` all pass.
- AC18: The release is smoke-tested on the INSTALLED binary before merge, and `CHANGELOG.md` has a section for the version being tagged — the two things that were missing when the previous phases were called "released" and were not.
