# Local owner recovery runbook

This runbook covers the explicit local recoveries this release supports:

- closing an **expired, idle** native session on the executor machine that owns it, so a human can take over its controller in Hub;
- recovering a run left **uncertain by a `serve` crash**, in two operator steps with a human Hub resolution between them (see [After a serve crash](#after-a-serve-crash)).

Both are local-owner actions, separate from Hub machine credentials and from Hub human authority. Neither ever stops or releases work because a lease expired, a process looks old, or a PID is missing, and neither force-unlocks anything.

## How the channel is set up

`keryx serve` starts the owner channel automatically after its existing gates pass and at least one enrolled Hub bridge has started (an enrollment with an enabled local policy). There is nothing extra to configure.

- The channel is a Unix socket at `<keryx config dir>/owner-control.sock`. It is not a TCP port and no Hub or `serve` HTTP route reaches it.
- The config directory must be owner-only (mode `0700`, owned by you, no symlinked ancestors). The socket itself is mode `0600`. Both the server and the client refuse an unsafe directory, a symlinked endpoint, or a socket owned by another user.
- One socket serves the whole installation. Each request names an exact Hub identity (`hubId`) and reaches only the live bridge enrolled for that Hub. A request for any other Hub is refused with `scope-denied`.
- The request carries no bearer, cookie or machine secret, and extra fields are refused before anything runs. Being able to open the socket as its owning user is the whole authorization.
- The socket path must fit the Unix limit of 103 bytes. A longer config path reports `local-control-path-too-long`; the bridges keep running without the channel.
- If `serve` finds an existing file at the socket path, it reports `local-control-busy` and does not replace it. After a crash, first confirm that no `serve` process for this config directory is still running, then remove the stale `owner-control.sock` yourself and restart `serve`. The per-Hub daemon lock a crash leaves is released by an explicit command instead, see [After a serve crash](#after-a-serve-crash).
- On shutdown `serve` closes the owner channel first, waits for an in-flight recovery to finish, then stops the bridges. It removes only the socket it created: if the path now points to a different file, that file is left alone.

## Inspect

```sh
keryx hub machine recover --hub <hub-id>
keryx hub machine recover --hub <hub-id> --session <session-id>
```

Inspection only reads state. It does not attach, retry, unlock or replay anything. With a running `serve` it prints one JSON object:

| Field | Meaning |
|---|---|
| `sessions[].session` | The host's actual `SessionRecord`: state, versions, controller lease, history version, workspace baseline. |
| `sessions[].nativeSessionId` | The local native session identity. It is only ever shown locally, never sent to Hub. |
| `sessions[].checkoutOwned` | Whether this `serve` process still holds the checkout lease. |
| `unresolved` | Ledger commands still `received` or `unknown`. |
| `recoveryClaims` | Earlier expired-idle recovery requests and whether each is `complete` or `unknown`. |
| `uncertainRuns` | Runs whose capacity another daemon of this installation still reserves, with that daemon id: what a crash, or an unproven stop, left fenced. |
| `truncated` | `true` when some entries did not fit the bounded reply. Narrow with `--session` to see the rest. |

If `serve` is not running, the command falls back to reading the durable ledger offline: unresolved commands and recovery claims only. That output is evidence. It does not change any lease or command tombstone.

## Release an expired idle session

Copy the pins from the inspection output. Choose a new request id and keep it: it is the request's durable identity.

```sh
keryx hub machine recover --hub <hub-id> --action release-expired-idle \
  --request-id <new-request-id> \
  --session <sessionId> --native-session <nativeSessionId> \
  --controller-lease <controller.controllerLeaseId> --controller-version <controller.version> \
  --session-version <version> --history-version <historyVersion> \
  --workspace-baseline <workspaceBaseline>
```

The release runs only when all of the following hold:

1. Every pin matches the live host exactly: session, native session, controller lease id and version, session version, history version and workspace baseline. Any mismatch returns `stale-reference`.
2. The controller lease has actually expired. A live lease returns `controller-live`.
3. The session is `idle`, with no active run, routing selection or inspection. Anything else returns `session-not-idle`. The bridge also refuses `session-busy` for a run it has not seen finish.
4. No uncertain work is known: no run that ended `unknown` and no unresolved ledger command for this checkout (`recovery-required`).
5. This process still holds the checkout lease and the native session lease.

When those hold, the host stops every job the native session owns and waits for that stop to settle, using the same proof required when `serve` disposes a session. Only when that stop is measured complete does it:

- save the history and release the native session lease,
- publish the measured `closed` session snapshot, with the lapsed controller lease unchanged,
- publish the released `ControllerReceipt` as the very next event: same lease id, actor and expiry, lease version plus one, session version plus one.

Both go to Hub through the existing session event stream. No human operation, run or operation receipt is created on anyone's behalf. Hub accepts the release only as a causally closed, expired, never-run or known-terminal session with no uncertain work. After that, a human takes over normally in Hub with `mode: takeover` and the release receipt id. Resuming the closed conversation afterwards goes through the ordinary resume flow and its own checks; this recovery does not change them.

Developer changes in the checkout, the conversation history and the audit history are not touched. The checkout lease stays with this `serve` process, exactly as it does after an ordinary close, so a later resume can use it.

The command prints the released result: `stopped: true`, the measured closed `session`, and the released `controller` receipt.

## Replay and request identity

- Repeating the same request id with the same pins returns the recorded result exactly. It does not stop anything a second time.
- Reusing a request id with different pins is refused with `payload-conflict`.
- A refusal that happened before any stop, for example `controller-live` or `stale-reference`, is recorded as `complete`. After you fix the cause, retry with a **new** request id and fresh pins.
- At most 1000 recovery claims are kept per Hub ledger. After that new claims return `quota-exceeded`.

## What stays fenced

These are never released by the expired-idle release, and expiry alone never changes them:

- a session in `recovery-required`,
- a live, paused or selecting run,
- an unresolved `received` or `unknown` ledger command,
- an owned stop or a session service (MCP, bus) close that could not be proven, for example a process that survived its kill,
- a recovery claim left `unknown`.

A fenced session refuses controller claims, renewals and takeovers, and refuses resume, until recovery is proven. That includes this same process opening the native session again, where the session lease would otherwise hand back the handle this process still holds: a host re-opened on that handle starts `recovery-required`, and disposing it never releases the lease. Hub likewise refuses a takeover without an exact applied release. The only release for a run a `serve` crash left uncertain is the explicit sequence in [After a serve crash](#after-a-serve-crash).

`serve` shutdown disposes every session within a bound: a routing selection or run that does not settle in two seconds, or a session service that does not confirm its close, leaves that session `recovery-required` with its native lease held, instead of hanging shutdown.

## Unknown outcomes

If the stop could not be proven, the request returns `recovery-required`, the session becomes `recovery-required`, and the native session lease stays held. The claim is recorded `unknown`:

- the same request id returns `recovery-required` and never runs again,
- any new request id for that session is refused with `recovery-required` while the unknown claim exists,
- `serve` crashing between the claim and its outcome also leaves the claim `unknown`.

No command clears an unknown expired-idle claim or unlocks a session left `recovery-required` in a running `serve`. Leave the state as it is, keep the evidence from `recover`, and investigate the actual processes on the machine yourself. Do not delete the ledger, the lease files or the socket of a running `serve` to get past the fence. Runs left uncertain by a crash of `serve` itself have their own path, below.

## After a serve crash

When `serve` dies mid-run (for example `SIGKILL`, a power loss or an out-of-memory kill), the run's Hub record stays non-terminal and three local fences stay in place: the run's capacity reservation, the session's checkout lease and the launch tombstone in the ledger. Supervised tool processes may still be running in their own process groups. Nothing below releases any of them automatically.

### What identity is recorded

- Each daemon records its own identity in the ledger when it starts, before it can launch anything: PID, process group and the operating-system process start time, bound to the nonce of the daemon lock it holds.
- Every owned process spawn first records an intent, then the process identity (PID, process group, start time) once the process exists. A crash between the two leaves the intent, which keeps the run uncertain.
- A process counts as gone only on that identity: the recorded PID no longer runs a process with the recorded start time and, for a process-group leader, no member of the recorded group exists. A PID alone, a lock's age or a missing heartbeat never count. A reused PID while the group still exists stays uncertain.

### 1. Release the stale daemon lock

After the crash, `serve` cannot start the bridge for that Hub (`machine-busy`): the crashed daemon's lock is still there.

```sh
keryx hub machine recover --hub <hub-id> --action release-stale-daemon
```

This runs offline, on the protected files only. It removes the lock only when the ledger holds the identity bound to that exact lock nonce and that daemon process is proven gone. It prints `{"kind":"daemon-lock","state":"released","daemonId":"..."}`, or `"state":"absent"` when there is no lock. A live daemon is refused with `daemon-live`; a lock without a recorded identity, or uncertain evidence, with `recovery-required`. It touches no run, lease or tombstone. Then restart `serve` (and remove a stale `owner-control.sock` as described above, if needed).

### 2. Confirm the absence of the run's processes

Find the run in `recover` output (`uncertainRuns`) or in Hub. Choose a new request id and keep it.

```sh
keryx hub machine recover --hub <hub-id> --action confirm-run-absence --run <runId> --request-id <new-request-id>
```

The running `serve` checks that the run is not terminal in Hub, that no live run of this daemon holds it, that the ledger's launch tombstone names the crashed daemon, and that the crashed daemon and every process it recorded for the checkout are gone by identity. A live process or group is refused with `owned-process-live`; a spawn intent without identity, a launch without a recorded daemon, or any uncertain evidence with `recovery-required`. Only then does it show the run `unknown` in Hub (restating the native identity this ledger already published, never a new one), measure the identities once more and submit a `confirmed-stopped` reconciliation report. It prints `"kind":"run-absence-confirmed"` with the `reconciliationId`, `expectedRunVersion` and `receivedAt`.

This step releases nothing.

### 3. Human resolution in Hub

A human with project authority resolves the run through the existing `resolve-run` request, as `reconciled` or `lost`, with `localReconciliationId` set to the printed `reconciliationId` and the printed `expectedRunVersion`. Hub accepts the receipt for 30 seconds after `receivedAt`; after that, repeat step 2 with a new request id. A `confirmed-stopped` receipt always resolves the run to `lost`, and Hub audits the resolution.

### 4. Release the local fences

```sh
keryx hub machine recover --hub <hub-id> --action release-resolved-run --run <runId> --reconciliation <reconciliationId> --request-id <new-request-id>
```

It runs only when Hub shows exactly that resolution: the run `lost`, one version after the local receipt, with the same command, session and checkout, and no other uncertain run of the same session. Then, each step durable and exact-owner, it marks the launch tombstone `lost` (the tombstone is kept and the run's logs enter retention), releases the crashed daemon's capacity reservation for that run, and removes the checkout lease the crashed daemon left for that session. Another owner of either is refused with `lease-owner-mismatch`, never overwritten. It prints `"kind":"released-resolved-run"` with `capacityReleased` and `checkoutLeaseReleased`. Resuming the session afterwards is an ordinary resume with its own checks.

### Replay

- Repeating a request id with the same pins returns the recorded result exactly and does nothing again. Reusing it with other pins is refused with `payload-conflict`.
- A refusal is recorded as `complete`. After you fix its cause (the process group finally exited, or the human resolved the run), use a **new** request id.
- A step interrupted by `machine-offline`, a Hub error or a crash is not recorded; repeating the same request id resumes it. Step 2 only observes and each release in step 4 is idempotent, so a resumed step never acts twice.
- At most 1000 crash-run recovery requests are kept per Hub ledger. After that new requests return `quota-exceeded`.

## Ledger retention and storage limits

- The local `control.sqlite` keeps log content for seven days after its run is terminal, and only once Hub acknowledged it. Older log content is retired into durable retired ranges (sequence range, digest and byte count). Critical events, command tombstones, launch identities and logs Hub never acknowledged are kept. Retired content is never replayed or regenerated: a Hub that asks for it again gets `replay-gap`.
- Near the event cap (100000 retained events, 2000 of them kept as headroom), new launches (a turn, a run-scoped command, a queued message, a new or forked session) are refused with `quota-exceeded`, visibly in Hub. Approval, terminal, result and session events of runs already admitted are always stored, and their log content becomes explicit gap metadata instead of being lost.

## Refusal codes

| Code | Meaning |
|---|---|
| `scope-denied` | The request names a Hub this installation's live bridges do not serve. |
| `local-control-unavailable` | No running `serve` owner channel, or the bridge is stopping. |
| `owned-process-live` | The crashed daemon, or a process it recorded for the checkout, still runs with its recorded start time or process group. |
| `daemon-live` | `release-stale-daemon`: the daemon that wrote the lock still runs. |
| `machine-offline` | `serve` is not connected to Hub. The step is not recorded; retry the same request id later. |
| `stale-reference` | A pin does not match, or the session is not hosted by this `serve`. |
| `controller-live` | The controller lease has not expired. |
| `session-not-idle`, `session-busy` | Active, paused, selecting or recovery-required work. |
| `recovery-required` | Uncertain work is known, an unknown claim exists, the stop (or a session service close) was not proven, process identity is missing or uncertain, or, for `release-resolved-run`, Hub does not show the exact human resolution yet. |
| `lease-owner-mismatch`, `native-lease-lost` | This process no longer holds the checkout or native lease. |
| `payload-conflict` | The request id was already used with different pins. |
| `quota-exceeded` | A recovery request limit, the bounded request or reply size, or (for a new launch) the ledger event cap was reached. |
| `unsafe-config-path`, `unsafe-local-control`, `local-control-owner-mismatch` | Filesystem ownership, permission or identity checks failed. Nothing was sent. |
