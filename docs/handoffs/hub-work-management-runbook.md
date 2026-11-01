# Hub work management candidate: operator runbook
Version: 0.2.0

Status: integrated candidate for isolated operator testing; owner product acceptance and public production upgrade are pending. Backend branch feat-hub-work-management, worktree /path/to/backend-worktree/keryx. UI source lane feat-hub-workspace-design is integrated as reviewed patches; do not merge the old dirty prototype branch.

## Local trial

The coordinator runs a disposable loopback Hub on http://127.0.0.1:18792 with project work-demo-project and registered repository demo-repository (SHA1). This is synthetic local data, not the production project. The fixture launcher scripts/smoke/team-hub-work.ts contains explicitly dummy fixture credentials, never real operator credentials. Existing production Cloudflare login is separate. The UI must label demo/synthetic data; a failed live API request must not fall back to simulated success.

Start another fresh isolated trial from this checkout:

```sh
bun --no-env-file scripts/smoke/team-hub-work.ts --fresh 18792
```

Use an unused loopback port if an instance already runs. The launcher prints the temporary database directory. To reopen that fixture after stopping the owning process, pass that exact directory instead of --fresh. Do not open two writers over the same trial database.

## What to exercise

1. Create a Flow with explicit problem/outcome/scope/criteria, then at least one required Intent and exact criterion mappings. Review both immutable requirement revisions before approving them as a human.
2. Start Flow and Attempt with exact context. A manual Attempt needs no machine. A native run keeps existing controller and tool permission checks; metadata association is separate.
3. Submit an immutable Git commit from a registered repository, a document version or bounded report. Record exact-subject criterion Evidence and a knowledge proposal or no-update reason.
4. Submit Attempt, select it as a human, then accept/request changes separately. Final Flow review requires current accepted required Intents and complete Flow criterion coverage. Agent/MCP tokens cannot make human decisions.
5. Inspect historical decisions and old context after document updates. Late contradictory Evidence must create an attention item, block current acceptance and preserve history. Remediation uses a human amendment and new Attempt.
6. Exercise two browser clients, stale versions, offline/unknown receipt reconciliation and navigation between Flows without carrying the wrong prepared decision.

## Existing Hub configuration

Managed work is disabled unless explicitly enabled. Keep existing authorization, Cloudflare Access, origin, token and machine configuration. Do not put credentials into the browser or Git.

The new administrator settings are KERYX_HUB_WORK_ENABLED=true and optional KERYX_HUB_WORK_REPOSITORIES, a JSON array of closed project-scoped repository configuration. For example, substituting the actual authorized project ID:

```json
[{"projectId":"YOUR_PROJECT_ID","id":"keryx","objectFormat":"sha1"}]
```

This permits manual exact Git references with contributor provenance. Optional GitHub metadata verification requires the explicit configured stable provider identity and workflow policy described in docs/requirements/hub-work-management/observer.md. Configure any read credential on the server only; do not paste it into chat or commit it. No Git write, push or merge is performed by observations or product acceptance.

## Upgrade and rollback boundary

Back up the stopped/quiescent Hub SQLite database consistently, including retained attachments, before activation; test restore into a separate directory. Managed metadata uses the same database. The first committed managed write/conversion activates the existing minimum-writer marker3. Older0.4.x writers reject startup thereafter: rolling back to an unaware binary is unsafe. Use this compatible guarded candidate/forward fix, or restore the complete preactivation backup only after explicitly accounting for any new work you would remove. Feature-off preserves data; it is not a down-migration.

Legacy revision payloads now live in a content-addressed SQLite blob table, and revision replay receipts store immutable references. Exact file bytes and previously accepted base64 spellings remain unchanged on explicit reads/replays. The first normalized revision write or migration activates minimum writer **4** atomically. Writers supporting only markers 2 or 3 must refuse startup; feature-off does not undo this format. The adoption/rollback trial compares hydrated exact revisions and receipts plus verified historical document content, rather than treating a storage-layout change as data loss.

Durable history is never silently deleted: the prototype refuses new growth above 64 MiB of legacy metadata, 100,000 records per legacy collection or replay entries, 512 MiB/100,000 encoded revision blobs, or 512 MiB/100,000 archived document versions. Existing larger histories remain intact during migration and require an explicit archival plan before further growth. Only transient transport windows expire: 10,000 invalidation events and 5,000 document deltas. A stale context cursor returns a complete current snapshot; an expired nonzero event cursor returns `resync-required`. All old exact document versions remain in the archive and are included in migration preservation checks.

Legacy Flows remain readable and functional unless explicitly converted. Preview and confirm conversion only for eligible idle unfinished work. Conversion creates draft managed requirements requiring new human approval and makes the old Flow read-only. Active legacy work should finish under its original lifecycle.

## Distribution and review

The candidate source archive and its SHA256SUMS are generated under artifacts/team-hub-work-management. Verify that checksum file after copying the archive; it identifies the packaged bytes rather than an earlier UI snapshot. A branch existing only on this laptop cannot be cloned on another machine until explicitly published; use the verified archive rather than assuming a remote branch exists. No production rollout is implied by local fixture or automated tests.

Final verification evidence lives in the companion candidate handoff and output/work-quality-gate-reload.md; independent backend/UI reports identify their exact reviewed source scopes. Known operational boundaries: single-process SQLite Hub, explicit Git refresh rather than a background scheduler, unverified actual runtime context consumption, contributor reports not elevated to CI trust, and no automatic machine-result Evidence ingestion.

## Private Linux preview

The isolated preview on operator@hub-host binds 127.0.0.1:19879. Source: /path/to/isolated-preview/team-hub-prototype. It uses its own disposable database and runtime dependencies. Production Hub, Cloudflare configuration and production data remain separate.

From a laptop with the existing operator@hub-host SSH configuration, run:

```sh
ssh -N -L 18794:127.0.0.1:19879 operator@hub-host
```

Open http://localhost:18794 and use the deliberately public fixture operator token below. It authorizes only this synthetic preview and must never configure a public Hub:

```text
work-demo-human-operator-0000000000000000000000
```

Choose project work-demo-project → Work. Exercise the lifecycle above. For unknown request recovery, reload the same tab: pending requests retain their original ID and body and require an explicit check/retry; they never dispatch automatically. A failed original retry does not settle an earlier uncertain result. A different authenticated principal cannot replay that tab's request. Signing out clears pending envelopes; ordinary form drafts are not durable. A browser that blocks/quota-fails session storage blocks new managed mutations with a visible error rather than sending an unrecoverable operation.
