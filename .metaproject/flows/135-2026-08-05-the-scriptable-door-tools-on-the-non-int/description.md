# The scriptable door: tools on the non-interactive path, providers from the registry, declared model ids

Status: formalized
Source: `docs/requirements/keryx-shell-remediation/implementation/flow-3-scriptable-door.md`
(Phase 2 of `docs/requirements/keryx-shell-remediation/specification.md`; defects
D3, D4, D5 of `docs/requirements/keryx-shell-benchmark/run-2026-08-05.md`.)

## Problem

`keryx harness run` is the only non-interactive door into the agent loop, and
three things make it unusable for anything but a single text turn:

- **D3** — it registers no tools. `toToolDefinitions(METAPROJECT_OPERATIONS)`
  exists and has no production consumer; the CLI installs an empty
  `ToolRegistry` and a `denyingExecutor` whose comment says "Release 0 CLI runs
  register no tools". So the differentiator keryx has — graph, memory, wiki,
  search — is reachable only through the TUI.
- **D4** — the provider is validated against a literal
  `new Set(["fake","anthropic","ollama"])` while `docs/docs/cli-reference.md`
  already tells the reader the OpenAI-compatible gateways are accepted. DeepSeek
  is reachable through the shell and refused here. Code and documentation
  disagree, with the documentation being the optimistic one — the same class of
  defect the 0.2.15 audit was about.
- **D5** — the DeepSeek registry entry's curated ids (`deepseek-chat`,
  `deepseek-reasoner`) are not ids the DeepSeek API lists; the API declares
  `deepseek-v4-flash` and `deepseek-v4-pro`. `models[0]` is what
  `defaultModelFor` hands a caller who named no model, so keryx defaults to an
  undeclared alias: it answers until one day it does not.

## Expected Outcome

- A non-interactive run can execute a read-only metaproject tool and the caller
  can read the tool's result out of the printed JSON blob.
- Every provider the registry declares is accepted by `harness run`, and an
  unknown one is still refused with the usage message.
- A provider that needs a credential still aborts before any network call when
  the credential is absent — for every accepted provider, not just anthropic.
- `docs/docs/cli-reference.md` states the accepted providers correctly, in the
  same pull request.
- No registry entry defaults to a model id its provider does not declare.

## Out of Scope

- Feeding tool results back to the model for a second turn. `runOffline` is a
  single-turn loop; making it multi-turn is a different flow.
- Auto-rewriting a `shell_exec` into a tool call (explicitly excluded by the
  specification).
- The interactive shell's tool surface and system instructions (flow 1 of the
  same remediation package owns `agent.ts`, `shell.ts`, `policy/**`,
  `metaproject-operations.ts` and `docs/docs/harness.md`).
