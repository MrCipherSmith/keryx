# Shell exit preservation and recovery

On handled shell exit, keryx stops new work, quiesces the foreground operation,
checkpoints the session and preserves an immutable snapshot before releasing
session ownership. Terminal progress distinguishes local preservation from
workspace delivery. A failed checkpoint is not reported as a successful save.

Preserved evidence includes available history, Notes, Trail, Course and Seeds.
Notes are retained even when there are no Seeds. Preservation is deterministic
and local: it does not require a model call or permission to send data externally.
Optional hooks do not replace the checkpoint or its pending-delivery receipt.

## Workspace proposals are not accepted memory

For a bound workspace, replay can create a pending `follow-up` proposal containing
the preserved evidence. It checks current authorization and security policy;
retrying a delivered snapshot does not create another proposal. A human must
review and accept it through the normal workspace review procedure. No exit
handler automatically accepts memory, wiki or other workspace changes.

Without a bound workspace, the snapshot remains local. Keryx does not silently
choose or create a workspace. Unbound or rejected-by-policy evidence is not lost
merely because a proposal cannot be delivered.

## Explicit retry

Run `keryx workspace catch-up --retry-preservation` from the original project,
or append `--json` for the `preservationReplay` counts (proposed/deferred/unbound).
This is an offline, project-wide bounded pass, using the same data directory as
the shell (`KERYX_DATA_DIR`, when set). Repeat to continue larger queues.
`--workspace` filters the catch-up report, not the project-wide retry.
Without the retry flag, catch-up remains read-only. `--retry-preservation=false`
also leaves outboxes unchanged. Startup replay likewise retains deferred work.

SIGKILL, power loss and storage failure cannot run an exit handler. Recovery can
use only the last successfully written checkpoint; unseen or unwritten streaming
data is not guaranteed. Keep backups: local preservation is not a backup service.
