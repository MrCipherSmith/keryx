# Implementation Plan

Status: approved by runner (autonomous, create-pr-and-merge)

## Approach

Four disjoint lanes run in parallel:

- Lane A (R700-01/02 + hooks.ts part of R700-04/05): project hook trust gate modelled on `src/mcp-servers/trust.ts`: digest-keyed trust record in the operator's config dir, `keryx hooks trust/untrust`, fail-closed on non-interactive surfaces, tighten-only merge of project overrides over built-ins, acknowledged user-scope gate disables. Designed by an opus designer (decisions summarised in the journal), implemented by a sonnet worker.
- Lane B (R700-03/04): append-safe contained write helper; observer + impact-evidence through it; ratchet widened, exemptions justified; learning docs.
- Lane C1 (R700-05 registry, 07, 08, 09, 13, 18): CLI help/usage/registry/docs.
- Lane C2 (R700-06, 10, 11, 12, 14): update idempotence, gitignore/seeded labels, bundle import provenance, update.ts containment.

Then: integration check, targeted tests, the 12-step manual test plan in a scratch repo, draft PR into feat/agent-platform-expansion, opus adversarial review/fix loop (threshold minor, at most 3 attempts, owner standing rule), CI, merge.

## Risks

- Lane A changes loadHookConfig's contract (warnings that do not fail the load); every caller and test must be updated together.
- Source-text audit tests read src/commands/shell.ts.
- Changing managed gitignore block text must not duplicate the block on upgrade.
