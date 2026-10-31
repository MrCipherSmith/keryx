# Remote session operator runbook

## Install the correct component

Deploy the Hub server on its own machine/container using the existing Team Hub deployment instructions. Keep its data directory persistent and private, and preserve Cloudflare Access/session/Origin controls. The Hub holds shared project context and authority records. Application services, Docker development dependencies, checkouts and native agents remain on developer machines.

Install the **full Keryx executor distribution** on every machine that will run an agent. The small Hub server/context-client archive is insufficient. Configure an actual available native provider/profile and permission/containment policy locally. Do not copy another developer's credentials or include them in archives.

## Enroll and bind explicitly

1. Sign in to Hub as an authorized human operator. Open Machines and create a project-scoped pairing.
2. On the intended executor machine, place the one-use pairing code in a short-lived environment variable and invoke `keryx hub machine pair --url <hub-url> --code-env <variable-name>`. Do not paste credentials into chat, URLs or committed configuration. When the Hub is behind Cloudflare Access, first set the service-token variables described in the next section.
3. Bind the intended local checkout and native profile explicitly with `keryx hub machine allow --project <project-id> --checkout <checkout-id> --path <absolute-checkout> --profile <profile-id>`.
4. Configure the local enrolled Hub identity using the full CLI help; preserve default conservative run limits and explicit ad-hoc permission. Start its authenticated headless serve connection using that installation's documented serve options.
5. In Hub, verify that the machine, checkout, profile, HEAD and availability match the actual local machine. Unavailable capabilities and their reasons are authoritative. Never infer that every shell command is remotely implemented from the presence of a catalogue.

## Connect a machine through Cloudflare Access

A machine is not a browser, so it cannot complete the human email/SSO login. Cloudflare Access admits it when each request carries a service token as the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`. The Hub machine client (pairing, the machine socket, the Hub reads for sessions, Flows and shared context) sends them when these two environment variables are set, the same names the Hub MCP bridge reads:

- `KERYX_CF_ACCESS_CLIENT_ID`
- `KERYX_CF_ACCESS_CLIENT_SECRET`

Set both or neither. Unset both for a Hub that is not behind Access. If only one is set, or a value is empty, longer than 8192 characters or not printable ASCII without spaces, the client refuses with `cloudflare-access-incomplete` or `cloudflare-access-invalid` before it sends any request. The headers go only to a Hub URL the client already trusts: `https`, or loopback `http` for a local test. Redirects, such as to the Access login page, are never followed and surface as a failed request.

Owner steps in Cloudflare (Zero Trust dashboard):

1. Create a service token (Access, Service credentials) with a clear name such as `keryx-machine-<name>` and an expiry you will track. Copy the Client ID and Client Secret when shown; the secret is displayed once.
2. In the Access application that protects the Hub (for example `hub.example.com`), add a policy with action **Service Auth** that includes only that token. Keep the existing human SSO policies unchanged. Do not add a Bypass policy, and do not weaken the audience or assertion checks the Hub and edge already apply. The application must cover the machine routes under `/hub/v2/` (enrollment and the machine socket) and `/hub/v1/` (Flows and context reads).
3. Give the Client ID and Client Secret to the person running the machine through your secrets manager, never through chat.

On the machine, the token lives only in the environment of the processes that talk to the Hub: the shell that runs `keryx hub machine pair`, and the service environment (for example the launchd or systemd unit) of the process that serves the connection. Export them from a secrets manager or a private (mode 0600) env file, not typed into a shared shell history:

```sh
export KERYX_CF_ACCESS_CLIENT_ID='<client-id>'
export KERYX_CF_ACCESS_CLIENT_SECRET='<client-secret>'
keryx hub machine pair --url https://hub.example.com --code-env PAIRING_CODE
```

The token is never written to machine state, enrollment or any configuration file, never goes into `--url`, and is never shown in an error or log. To rotate, create a new token, replace the Access policy, update the environment and restart the machine process. The service token only gets the request past Access: the one-use pairing code, the machine secret and the Hub's own authorization still apply, and the token grants no Hub role.

A passing local test shows that the headers are sent. Whether Access admits the machine is established only by a real pairing through the public route, which is reported separately from local checks.

## Start and review work

Create/select a session with explicit machine/checkout/profile. Claim controller authority in this tab. Choose a ready frozen Flow with matching pinned specification and criteria, or explicitly consent to ad-hoc execution. Review cost/privacy confirmation when changing model/provider routing. Submit only after fresh versions and baseline are available.

During work, monitor state and active approvals. Recorded means Hub stored a request; delivered means the machine received it; applied means the local executor actually applied it. A timeout, stale reference or not-applied receipt does not authorize retrying a mutation blindly. Technical receipt details remain available for investigation. Cancellation waits for local cessation proof; it is not a cosmetic status switch.

Review-only result bundles are not publishable code revisions. Git selection/delivery remains blocked for those bundles. A human reviews Evidence and accepts the exact result; an agent cannot accept its own work.

## Recovery

An unknown run is unresolved until a fresh machine-provided reconciliation receipt identifies the exact native runtime. In Run details choose that authoritative proof and state a reason. Confirmed stopped may resolve lost; owned-running may reconcile only with matching identity. Lost resolution does not release locks or controller authority.

Controller takeover is a separate explicit action, using either the exact applied release receipt or an eligible fresh confirmed-stopped proof consumed by the lost resolution. Missing/expired proof disables recovery. Do not invent receipt IDs, attach arbitrary PIDs, delete ledger/lock state, or automatically restart work.

If local drafts conflict after an external change, retain them and explicitly use current versions before retrying. A successful configuration update displays its applied receipt; the next configuration edit currently requires explicit version rebasing. Verified same-tab periodic controller renewals preserve unsent drafts automatically.

## Release verification and pending gates

Use packaging.md for source/archive/compiled/minimum-Bun checks. Production native command coverage must have a validated packaged descriptor and actual production-assembly execution evidence before release. Protocol-only smoke, partial inventory and synthetic callback fixtures do not establish this gate. Public Cloudflare, real vendor trials and owner acceptance must be reported separately when unexecuted.
