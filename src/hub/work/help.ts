// Kept apart from cli.ts so the intercepted `keryx hub work --help` does not load the client.
export const WORK_HELP = `keryx hub work — Managed work metadata
  status                                     Show local binding; no network or credentials
  capabilities                               Show enabled features and permitted commands
  flow list | flow show <id>                  Read managed Flows
  intent list --flow <id> | intent show <id>
  attempt list --intent <id> | attempt show <id>
  document show <id> --version <n> --digest <sha256>  Fetch exact immutable Hub content
  context show <id> | subject show <id>        Fetch exact immutable metadata
  subject observe <id> --input <file|->       Refresh configured read-only Git/CI metadata
  observation list --subject <id>             Read immutable observation history
  evidence list --attempt <id> | decision list [--target <id>]
  submission show <id> | flow-submission show <id> | amendment show <id>
  revision show --flow <id> --revision <id>    Exact Flow revision (or --intent)
  attention | snapshot [--cursor <opaque>] | events [--after <opaque>]
  operation show <operationId>                Poll own original operation outcome
  command --input <file|->                    Send contributor command envelope JSON
  <flow|intent|attempt|context|subject|evidence|revision> <action> --input <file|->
                                             Alias for matching contributor command
Read pagination: --limit <n> --after-id <opaque>; token: --token-env <name>.
Uses the trusted project connection from keryx hub connect. Input is at most 64 KiB.
Supply operationId, expectedVersions, command and payload; reuse identical input after an uncertain result.
No approval, selection, acceptance, waiver, amendment, cancellation or execution dispatch commands.
`;
