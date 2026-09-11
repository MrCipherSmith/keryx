# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/mcp` opens the CONSUMER view — the MCP servers keryx connects to — and `/integrations` opens the installer view where keryx itself is registered into an editor. Both resolve from one predicate, and a test asserts the two commands open DIFFERENT views, not merely that each is accepted.
- AC2: `/mcps` is never registered (spec AC9). `agent-commands.confusable.test.ts` continues to pass with no new written exemption, and a test asserts `/mcps` is not accepted by either view's predicate.
- AC3: the consumer view lists every configured server with its name, source (user/project), transport, status and tool count; a server held at `needs-approval` shows the `keryx mcp trust <name>` instruction, and a `failed`/`needs_auth` one shows its reason. Asserted against a rendered model, not by reading the source.
- AC4: nothing the consumer view displays is raw third-party text. `ServerState.error` passes through `sanitiseForDisplay` before it reaches the view — the latent asymmetry the P1 security reviewer recorded as unreachable "until the surface that would display it exists". A test drives an error containing ANSI escapes and a bare carriage return and asserts neither survives, and that the readable text does.
- AC5: the consumer view never prints a credential. A server configured with `headers`, `bearer_token_env_var`, a `?api_key=` query or userinfo in its url renders with the values elided and the variable NAMES shown, and a test asserts the literal secrets are absent from the rendered output.
- AC6: the Tools-tab caption no longer sends the operator to the CLI as the only consumer surface (spec AC17). A test asserts the caption names `/mcp`.
- AC7: `use_tool` has its OWN approval rendering and never reaches `evaluateShellApproval` (F-032). A test asserts that approving a `use_tool` call offers no "Always allow"/exact-match grant and writes nothing to the shell permission store, and that the store is byte-identical before and after.
- AC8: the `use_tool` approval rendering names the SERVER and the TOOL where the operator cannot miss them, and shows the arguments in a form that cannot hide them behind a reassuring prefix (F-033). A test builds a call whose first JSON key is a benign `reason` long enough to exhaust the old 117-character budget and asserts the rendered output still contains the qualified tool name and the destructive argument.
- AC9: both approval surfaces — the readline shell and the TUI — call ONE shared renderer. A module invariant asserts neither `src/commands/shell.ts` nor `src/tui/tui-shell.ts` re-derives the description locally, and the renderer is pure enough to test with no terminal.
- AC10: the renderer is covered by a CLASS table using the shared `classTableProblems` rule from P1, with a BOUNDARY row in every class.
- AC11: mutation coverage over the diff. `bun scripts/mutation-sweep.ts --base main --tests <paths>` reports zero surviving mutants that are not equivalent, and every non-equivalent survivor found during the work is either killed by a new test or recorded with the reason it is equivalent.
- AC12: `bun test`, `bunx tsc --noEmit`, `bun run lint` and `bun src/cli.ts skills verify --bundled` all pass.
- AC13: the release is SMOKE-TESTED on the installed binary before it is announced — the practice P1 established after a green suite, a green mutation sweep and three green reviewers all missed a credential printed by `keryx mcp list`. The operator's own config is restored afterwards.
