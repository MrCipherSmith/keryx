# Run Keryx sessions on your machines from Team Hub

Team Hub can start a full, headless Keryx session on a developer machine. An
operator picks a machine, a checkout and a profile in the Hub web UI, writes a
message, and the machine's own `keryx serve` runs the session in that checkout
under that machine's local policy. Progress streams back to the Hub, tool calls
that need approval wait for an Allow once or Deny in the web UI, and the result
comes back as a review-only code revision.

The checkout, the provider credentials and every tool call stay on the machine.
The Hub coordinates; it never runs project code or a model.

!!! warning "Beta"
    The feature is built and has automated tests that use real local HTTP and
    WebSocket connections. Live checks across several machines, through a Hub
    behind public Cloudflare Access, and with real providers are still pending
    owner verification. Treat it as a beta and read
    [Known limitations](#known-limitations) before you rely on it.

## What it is, and what it is not

It is:

- a way to run a Keryx session on a machine you enrolled, from the Hub web UI,
  including from a phone;
- the native Keryx agent, with the machine's own hooks, command guards and
  containment, run without a terminal UI;
- limited to checkouts and profiles you allow **on the machine**. The Hub cannot
  widen them.

It is not:

- a remote shell or a browser terminal;
- a way to attach to a `keryx shell` that is already open;
- a runner for Codex, Claude or OpenCode. The native Keryx agent is the only
  executor;
- a Git publisher. It does not commit, push, merge or accept a Flow for you.

## Before you start

- **A Hub that runs a release with remote sessions.** Deploying the Hub is not
  covered here; see the [operator runbook](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/runbook.md).
- **A human operator login on the Hub.** Creating pairing codes, starting
  sessions, answering approvals and cancelling are operator actions. A reviewer
  can read machines and runs but not control them.
- **The full Keryx install on each machine** (macOS or Linux, `git` and `bun`
  1.3.14 or newer). The smaller Hub client package is not enough:
  `keryx hub machine` there stops with "Machine commands require the full Keryx
  executor installation".
- **A provider and model saved by `keryx shell`.** Run `keryx shell` once, connect
  a provider with `/connect` and pick a model. The `fake` provider is refused.
- **A checkout that is a Keryx project.** It must be a Git working copy with a
  `.metaproject/index.md` (`keryx init` creates it). For the first session it
  must be clean: no uncommitted, staged or untracked files.
- **An OS sandbox for the `remote-restricted` profile.** macOS has one built in.
  Linux needs `bwrap` (bubblewrap) on `PATH`. See [Platform support](../limitations.md#platform-support).
- **`keryx serve` set up once**, because it hosts the connection to the Hub. The
  commands are below the list.

```sh
keryx serve config init
keryx serve token issue
```

[Drive keryx from a bot or another product](drive-keryx-remotely.md) explains
what these two commands do.

To check that this build can serve remote sessions, run `keryx hub machine readiness`.
It needs no pairing or network, prints a JSON line and exits non-zero unless
`releaseReady` is `true`.

## 1. Enroll a machine

In the Hub web UI:

1. Select the project the machine may work on.
2. Open **Machines**, type a **Machine display name** and click **Create
   enrollment code**.
3. Copy the code. It is shown once, works once and expires after 10 minutes. It
   enrolls the machine for the selected project only.

On the machine, put the code in a short-lived environment variable. The command
reads it from there, so it never appears in an argument or in shell history:

```sh
export KERYX_HUB_PAIR_CODE='<code from the Hub>'
keryx hub machine pair --url https://hub.example.com --code-env KERYX_HUB_PAIR_CODE
unset KERYX_HUB_PAIR_CODE
```

On success it prints `Machine paired. Add an explicit local checkout allowance
before execution.`

- `--url` is the Hub origin only: `https://host[:port]`. Plain `http` is accepted
  only for `localhost`, `127.0.0.1` and `[::1]`. A path, query string or
  credentials in the URL are refused (`invalid-hub-url`).
- A machine can be enrolled once per Hub URL; a second `pair` for the same URL
  stops with `already-paired`.
- The machine secret and the enrollment live in `hub-machines/<hub-id>/` under
  the Keryx user directory (`~/.local/share/keryx`, or `$XDG_DATA_HOME/keryx`),
  in owner-only files. Nothing is written to your repository.
- `<hub-id>` is the SHA-256 of the Hub origin, which is also the name of the
  directory above. You only need it when the machine is enrolled with more than
  one Hub: then every later command needs `--hub <hub-id>`, or it stops with
  `hub-selection-required`.

```sh
printf '%s' https://hub.example.com | shasum -a 256    # sha256sum on Linux
```

Pairing alone lets the Hub run nothing. The machine now appears on the Machines
screen with its **Project scope**; that is the `<project-id>` you need next.

## 2. Allow a checkout and a profile

Allowing is a local action. The Hub cannot create or change it.

```sh
keryx hub machine allow \
  --project <project-id> \
  --checkout my-api \
  --path /Users/dev/code/my-api \
  --profile remote-restricted

keryx hub machine configure --candidate current --ad-hoc allow --max-runs 1
```

`allow` maps one Hub checkout id to one local checkout:

| Flag | Meaning |
|---|---|
| `--project` | The Hub project id (the machine card's Project scope). |
| `--checkout` | Your name for this checkout. Letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit, up to 200 characters. The Hub shows it as the checkout label. Each id and each path can be allowed once (`mapping-conflict`). |
| `--path` | The absolute path of the top of a Git working copy. A subdirectory is refused (`invalid-checkout`). |
| `--profile` | The remote policy profile for sessions in this checkout: `remote-restricted` or `remote-read-only`. |

The two profiles:

| Profile | Reads | Writes | Shell | Network | Needs an OS sandbox |
|---|---|---|---|---|---|
| `remote-restricted` | allowed | asks first | asks first | off | yes |
| `remote-read-only` | allowed | refused | refused | off | no |

`configure` writes the machine's local policy:

| Flag | Meaning |
|---|---|
| `--candidate current` | Allow the provider and model that `keryx shell` last saved. This is the only accepted value. |
| `--ad-hoc allow\|deny` | Whether a session may do work that is not tied to a Flow. |
| `--max-runs 1\|2` | How many runs this machine may have active at once. |

Run `allow` before `configure`, because `configure` builds the policy from the
allowances that exist at that moment. Run `configure` again after you add an
allowance or change the saved provider or model. Each run of `configure` raises
the profile's ad-hoc consent version by one (see
[Start a session](#3-start-a-session-from-the-web)).

`pair`, `allow`, `configure` and `unpair` take the same lock as a running
`keryx serve` and stop with `machine-busy` while it is up. Stop `keryx serve`,
make the change, then start it again.

Then start the listener, which connects to every Hub the machine is enrolled with:

```sh
keryx serve
```

It prints its listening line first and `machine bridges started: 1` when the Hub
connection is up. `Hub machine: machine-policy-required` means `configure` has
not been run for that Hub. `Hub machine: machine-busy` means another process
holds the machine, for example after a crash; see
[Recover after a crash](#recover-after-a-crash).

Back in the Hub, the machine's card should show **Online**, the checkout label,
its Git HEAD, whether it has uncommitted changes, and the profile as **Ready**.
A profile that is not ready says why:

| Reason | What to do |
|---|---|
| `provider-setup` | Save a real provider and model in `keryx shell`, then run `configure`. |
| `local-policy` | The checkout has no `.metaproject/index.md`, the profile name is unknown, or the saved provider and model are not in the policy. Fix it and run `configure`. |
| `containment-missing` | `remote-restricted` needs an OS sandbox; install `bwrap` on Linux. |
| `adapter-unsupported` | The native session runtime could not be set up on this build, for example because a command in its catalogue has no implementation. Run `keryx hub machine readiness`. |
| `checkout-unavailable` | The checkout path cannot be read as a Git working copy. |

## 3. Start a session from the web

1. Open **Sessions** and click **New session**.
2. Choose the **Machine**, **Checkout** and **Agent profile**, give it a **Title**
   and click **Create session**. Machines that are offline, revoked or waiting
   for recovery, checkouts that are dirty or busy, and profiles that are not
   ready cannot be selected. The Hub never picks the first online machine for you.
3. Open the session and click **Claim control**. Only the tab that holds control
   can send commands; every other tab is an observer. The tab renews control while
   it stays open, and **Release control** gives it up.
4. Write the **Message** and choose the **Work mode**:
    - **Managed Flow**: pick an in-progress Flow. The message is pinned to that
      Flow's specification and criteria. On a Flow's detail page, **Run on a
      machine** opens Sessions with that Flow preselected.
    - **Ad-hoc work**: work that is not tied to a Flow. It needs `--ad-hoc allow`
      on the machine, the consent checkbox, and the **Local profile consent
      version** field set to the machine's current version (1 after the first
      `configure`, then one more for each later `configure`).
5. Choose what happens **When busy**: Reject, or Queue the message. Click **Send
   message**.
6. Follow the work under **Runs**: the actual state, a redacted progress log, and
   the approvals and cancel controls below.

How the machine treats the checkout:

- The first session needs a clean checkout at the HEAD the Hub showed. The machine
  checks this itself and refuses a stale or dirty start.
- Later turns carry on from the session's own uncommitted changes. If someone
  else edits the checkout during a run, the run is marked for reconciliation and
  its result is not published automatically.
- Keryx does not stash, reset, pull or create worktrees.
- The agent has the tools the profile allows: reading and searching files,
  patching files, and shell commands. A turn is bounded; the specification sets
  30 minutes, and the production profile caps tool calls at 64 and model rounds
  at 16.

A session also has a history, an editable message queue, model and routing
settings that apply at the next idle point, a native command catalogue, and
**Resume session**, **Close when idle** and **Fork session**.

The result of a run is a review-only code revision with the machine's own check
reports, marked as self-reported. A person reviews it in the Hub. The agent
cannot accept its own work, and Git selection and delivery stay blocked for it.

## 4. Approvals

With `remote-restricted`, every write, shell command and delegation asks first.
The ask appears on the run as a **Tool approval** card: the tool, its risk class
and the exact arguments, the approval deadline, and a status line.

- Click **Allow once** or **Deny**. You need to hold control in that tab, and the
  machine must be online.
- **Allow once** covers that one call. Nothing becomes a standing grant. If the
  arguments, the policy or the run changed, the answer is refused.
- Read the status line, not only the button. **Recorded** means the Hub stored
  your answer, **delivered** means the machine received it, and **applied**
  means the machine used it. **Not applied** means it did not. An answer can be
  recorded and still not applied.
- An approval nobody answers expires after 120 seconds and counts as a Deny.
- Some confirmations can only be answered at the machine's own terminal. On those
  cards the buttons stay disabled.
- A card whose action text hides characters (bidirectional controls, zero-width or
  C1 characters) is not offered at all; the call is denied.

## 5. Cancel a run

Open the run and fill in a reason, then click **Request cancellation**. You need
control in that tab.

Cancellation is a request, not a switch:

1. **Requested**: the Hub recorded it.
2. **Cancelling**: the machine's live executor acknowledged it.
3. **Cancelled**: only after the machine verified that the run's own supervised
   processes stopped. If it cannot establish that, the run shows **Unknown**,
   with partial effects, and not Cancelled.

Pending approvals are denied. Files the agent already changed stay changed:
cancelling does not roll back or reset anything. If the run finished first, the
finish wins.

## Recover after a crash

Offline is not stopped. If the machine loses its connection, a running tool may
finish and the run then pauses at its next safe point; pending approvals expire
as denials. When the connection returns, the machine reconciles with the Hub and
the same run can go on. A duplicate start never resumes it.

If `keryx serve` itself dies mid-run (`kill -9`, power loss, out of memory), the
run stays non-terminal in the Hub and Keryx never restarts it by itself. Recover
in explicit steps. Replace `<hub-id>` as described in
[Enroll a machine](#1-enroll-a-machine); you can leave `--hub` out when the
machine has one Hub.

**Step 1. Read what is unresolved.** This only reads.

```sh
keryx hub machine recover --hub <hub-id>
```

**Step 2. Remove the dead daemon's lock.** Needed when `keryx serve` stops with
`machine-busy`. The lock goes only if the daemon that wrote it is proven gone.

```sh
keryx hub machine recover --hub <hub-id> --action release-stale-daemon
keryx serve
```

**Step 3. Prove the run's processes are gone.** Use a new request id and keep it.

```sh
keryx hub machine recover --hub <hub-id> --action confirm-run-absence \
  --run <run-id> --request-id <new-request-id>
```

**Step 4. Resolve the run in the Hub.** Open the run, choose the reconciliation
report under **Resolve run after local reconciliation**, enter a reason, tick the
confirmation and click **Mark confirmed stopped work as lost**. Do this within 30
seconds of the report. If that lapses, repeat step 3 with a new request id.

**Step 5. Release the local fences for that run.**

```sh
keryx hub machine recover --hub <hub-id> --action release-resolved-run \
  --run <run-id> --reconciliation <reconciliation-id> --request-id <new-request-id>
```

**Step 6. Only if step 1 listed an unresolved command with `"runId": null`**
(a queued message, a control claim or a settings change that the crash cut off),
settle it:

```sh
keryx hub machine recover --hub <hub-id> --action settle-crashed-command \
  --command <command-id> --request-id <new-request-id>
```

Its answer says whether to send the command again (`resubmit`: `no`, `yes` or
`if-absent`). Then, in the Hub, claim control of the session again and click
**Resume session**.

A step refused with `owned-process-live` means a process of the crashed run is
still running. Stop it yourself; the command will not guess. Never delete the
ledger, lock or socket files, invent a receipt id or attach to a process by its
PID to get past a refusal.

An expired, idle session can also be released locally with
`--action release-expired-idle`, followed by **Take over released control** in
the Hub. Every action, its pins and every refusal code are in the
[recovery runbook](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/recovery-runbook.md).

## Connect through Cloudflare Access

A machine cannot complete a browser login, so Cloudflare Access admits it with a
service token. The Hub client (pairing, the machine connection and the Hub reads)
sends the token as the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`
when both of these variables are set:

- `KERYX_CF_ACCESS_CLIENT_ID`
- `KERYX_CF_ACCESS_CLIENT_SECRET`

In Cloudflare, create a service token with a clear name and an expiry you will
track. In the Access application that protects the Hub, add a policy with action
**Service Auth** that includes only that token. Keep your human policies, add no
Bypass policy, and make sure the application covers `/hub/v2/` and `/hub/v1/`.
Hand the two values to the person running the machine through your secrets
manager, not through chat.

On the machine, export them in the shell that runs `pair` and in the environment
of the process that runs `keryx serve` (for example the launchd or systemd unit):

```sh
export KERYX_CF_ACCESS_CLIENT_ID='<client-id>'
export KERYX_CF_ACCESS_CLIENT_SECRET='<client-secret>'
keryx hub machine pair --url https://hub.example.com --code-env KERYX_HUB_PAIR_CODE
```

- Set both or neither. One alone, or an empty, over-long or non-printable value,
  stops the command before any request, with `cloudflare-access-incomplete` or
  `cloudflare-access-invalid`.
- The headers go only to a Hub URL Keryx already trusts (`https`, or loopback
  `http`). Redirects, such as to the Access login page, are never followed and
  show up as a failed request.
- The token is never written to the machine's state or any file, is never put in
  a URL, and is never shown in an error.
- To rotate it, create a new token, change the Access policy, update the
  environment and restart `keryx serve`.
- The token only gets the request past Access. The pairing code, the machine
  secret and the Hub's own checks still apply, and the token grants no Hub role.

Whether Access admits a machine through your public Hub URL is proven only by a
real pairing through that URL. The tests prove the headers are sent.

## Revoke a machine

In the Hub, open **Machines**, tick **I confirm revocation of this machine** on
its card and click **Revoke machine**. Within about 20 seconds the machine's open
connections close, no new work is dispatched, and local work pauses at its next
safe point. A tool that is already running is not undone, and data the machine
already downloaded is not erased.

Then, on the machine, stop `keryx serve` and remove the local enrollment:

```sh
keryx hub machine unpair
```

`unpair` removes the local enrollment and secret and keeps the ledger. It does
not revoke the machine in the Hub; do that in the web UI. It refuses with
`recovery-required` while a launch is unresolved, so finish
[recovery](#recover-after-a-crash) first.

## Known limitations

- **It is a beta.** Live multi-machine runs, a public Cloudflare Access route and
  real provider trials are pending owner verification.
- **macOS and Linux, one Hub process.** Windows is not supported. There is no
  multi-instance or multi-tenant Hub.
- **Only the native Keryx agent runs.** No Codex, Claude or OpenCode adapter, no
  arbitrary terminal, and no attaching to a session that is already open.
- **No provider secrets, permission-floor or trust changes from the web.** A
  profile cannot be widened remotely. A confirmation that needs the machine's own
  terminal cannot be answered in the web.
- **The web UI is basic.** There is a message box, history, queue and command
  forms, not a polished chat.
- **The first session needs a clean checkout.** Keryx will not stash, reset or
  clean for you, and a checkout leased by another Keryx process or Hub is refused.
- **Results are review-only.** There is no Git delivery, and nothing is accepted
  without a person.
- **Stopping is not instant.** A revoked approval grant can still apply for up to
  5 seconds, a running tool is not interrupted by revocation, and cancelling does
  not undo file changes.
- **Recovery is manual.** One outcome of `settle-crashed-command` can leave the
  Hub holding the session as busy, with no web action to release it yet.
- **There is no command to remove one allowance.** `keryx hub machine` can add a
  checkout, but to drop one you unpair and pair again.
- **Logs are bounded.** Under quota pressure the progress log shows a gap, and
  log content is kept for seven days after a run ends.
- **The HTTP `/v1/turns` route of `keryx serve` still runs no tools.** Tools run in
  Hub sessions on an enrolled machine, not there.

## Where to read more

All of these are in `docs/requirements/hub-remote-sessions/` on GitHub:

- [Overview and scope](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/README.md)
- [Specification and acceptance criteria](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/specification.md)
- [Operator runbook](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/runbook.md)
- [Recovery runbook](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/recovery-runbook.md)
- [Security and authority](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/security.md)
- [Packaging and what the Hub archive does not contain](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-remote-sessions/packaging.md)

The commands are listed in the [CLI reference](../cli-reference.md#hub-machine).
