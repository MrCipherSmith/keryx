# Remote session operator runbook

## Install the correct component

Deploy the Hub server on its own machine/container using the existing Team Hub deployment instructions. Keep its data directory persistent and private, and preserve Cloudflare Access/session/Origin controls. The Hub holds shared project context and authority records. Application services, Docker development dependencies, checkouts and native agents remain on developer machines.

Install the **full Keryx executor distribution** on every machine that will run an agent. The small Hub server/context-client archive is insufficient. Configure an actual available native provider/profile and permission/containment policy locally. Do not copy another developer's credentials or include them in archives.

## Enroll and bind explicitly

1. Sign in to Hub as an authorized human operator. Open Machines and create a project-scoped pairing.
2. On the intended executor machine, place the one-use pairing code in a short-lived environment variable and invoke `keryx hub machine pair --url <hub-url> --code-env <variable-name>`. Do not paste credentials into chat, URLs or committed configuration.
3. Bind the intended local checkout and native profile explicitly with `keryx hub machine allow --project <project-id> --checkout <checkout-id> --path <absolute-checkout> --profile <profile-id>`.
4. Configure the local enrolled Hub identity using the full CLI help; preserve default conservative run limits and explicit ad-hoc permission. Start its authenticated headless serve connection using that installation's documented serve options.
5. In Hub, verify that the machine, checkout, profile, HEAD and availability match the actual local machine. Unavailable capabilities and their reasons are authoritative. Never infer that every shell command is remotely implemented from the presence of a catalogue.

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
