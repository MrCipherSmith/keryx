# Keryx Cockpit — visual prototype

Open `index.html` directly in a browser. No server, build, network, dependencies or live session access is required.

Six scenarios in the top selector: working, human attention, recorded result, stale data, no Flow, unavailable source. Try narrow mode, plan status legend, evidence provenance, event details and terminal navigation preview. The pin button only demonstrates UI state.

All data is fictional and explicitly labelled demo. No approvals, shell commands or real terminal navigation are performed. This is an HTML design study, not a native Herdr mod or a publisher.

Tests: `bun test prototypes/keryx-cockpit/model.test.ts`

## Native Herdr mod: live read-only bridge

The HTML study stays demo-only. `herdr/main.js` reads real snapshots instead of
`demo.js`. Both TUI and readline Shell publish every 2 seconds while holding
the session lease. Binding is explicit: `HC_TERMINAL_ID → project + session`.
Session switches are followed automatically, without newest-session guessing.

- Snapshot: `$HERDR_APP_HOME/data/keryx-cockpit/<HC_TERMINAL_ID>.json`.
  Default app home: `~/.config/herdr-app`; snapshot permissions: `0600`.
- Flow source: `<shell-project>/.metaproject/flows`, through canonical readers.
  Slate `course.flowRef` narrows to the session Flow. Without it, project Flows
  are available in a separate, initially collapsed project block. The session
  block explicitly reports that no Flow is bound. Broken bindings report errors.
- Cockpit follows only the focused Keryx terminal in Herdr. It has no agent
  list or manual session selector; missing/ambiguous focus never guesses a session.
- For global work, Shell's project context must be `~/.keryx`. Global tasks
  are not mixed into unrelated projects or matched by numeric ID alone.
- Plan: canonical `getExecutionPlan`, the same source as Shell's plan modal.
- Missing snapshots are unavailable; snapshots older than 10 seconds are stale.
  Stopped/unbound publishers remove their own snapshot. Remote terminals are unsupported.
- Only the initiating and latest operator requests are included (bounded to 8000
  characters each). No task/plan/Slate writes, full transcripts, credentials, or fictional test/review evidence.

Copy `herdr/{main.js,live.js,mod.json}` into `~/.config/herdr-app/mods/keryx-cockpit/`
(or `$HERDR_APP_HOME/mods/keryx-cockpit/`), reload the mod/layout, and restart Shell
with this Keryx build inside Herdr. An already running old Shell cannot publish.

## Consumer-independent Keryx state export

Both Shell surfaces now use a shared read-only state exporter. Herdr is one
adapter, not the owner of the state schema. Outside Herdr, explicitly opt in:

```sh
KERYX_STATE_EXPORT_FILE=/absolute/private/path/keryx-state.json keryx shell
```

Use a distinct file for each simultaneous Shell. The destination must be absolute;
there is no implicit global export or newest-session lookup. The parent directory
is created with mode 0700 (existing directories are not chmodded), the file with
0600, and each update uses atomic rename. Consumers should read the complete JSON
file again, rather than watch the old inode. Treat `updatedAt` older than 10 seconds
as stale; a missing file is unavailable. Normal shutdown/unbinding removes the
publisher's own file; abrupt process death can leave a stale snapshot.

Schema `version: 1` contains `projectPath`, `sessionId`, `updatedAt`, `sourcePath`,
`scope`, `request`, `plan`, `flows`, `issues`, and publication `ownerId`. The generic
schema has no terminal identity. Plan is the canonical execution plan (including
revision); tasks include `description`, `criteria`, `criteriaScope`, `results`.
Project scope excludes `done` Flows; an explicitly bound session Flow is retained
even when closed. A broken binding does not fall back to unrelated project Flows.
`issues` describes partial/degraded source reads. Requests are the first and latest
operator messages, bounded to 8000 characters each, not a transcript. Task details
also have a bounded content budget; this is a state summary, not a backup API.

The generic file and Herdr file can be enabled together. The Herdr adapter adds
`terminalId`, keeps the original destination and 1,000,000-byte read limit; the
neutral transport has no Herdr-specific size limit. Do not point the neutral
export at the Herdr adapter's own file. No Herdr mod changes are required.

Internal extension points: `state-snapshot.ts` assembles canonical state;
`startStateExport({ file, getSession, intervalMs?, maxBytes?, onError? })` owns the
file transport and lifecycle. A different transport can consume
`buildStateSnapshot(session)` directly. These are internal source APIs, not new
package exports. A consumer must check schema version, identity, freshness and
`issues`; it must not treat these files as approval or command channels.
Snapshots contain private request/project data: keep destinations local and
private. Changes require a newly started Shell build; reloading a panel cannot
replace code already loaded by a running Shell.
