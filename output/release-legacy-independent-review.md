# One-time legacy adoption: independent review

STATUS: DONE

Current verdict: APPROVE for the reviewed repaired helper/lock integration, bundle inclusion and owner instructions. The earlier failing snapshot is preserved below as history. This is code-ready draft-PR evidence, not authorization or proof of merge, release publication or production cutover.

## Historical confirmed findings — repaired

### R-LEGACY-001 — adoption lock does not exclude hubctl operations

Severity: major. `adoption_lock` checks `state/lock` once, then owns a different `state/legacy-adoption.lock`. Existing hubctl `lock_try` does not inspect that second lock. Another release operation can therefore start after the check, racing the adoption backup/configuration/pointer switch. The helper's own new-tool child calls also need explicit delegation rather than bypassing the mutual exclusion globally.

Independent disposable probe imports the actual Python lock and executes the actual shell `lock_try` with no Docker/network. The shell acquired its lock while adoption was held: RED. Full probe: `output/release-adoption-independent-probe.py`; raw `.metaproject/data/gdctx/raw/2026-11-01T15-56-42-387Z-13c5ec_run.log`.

### R-LEGACY-002 — applied receipt with pending session projection is omitted from unresolved work

Severity: major. `info_for` counts unfinished runs, queue entries and commands whose status is not applied/terminal. It does not inspect `remote_session.pending`. The existing protocol explicitly allows an applied command receipt while the matching session projection is still pending; the Hub's idle fence remains unresolved until that projection arrives. Adoption must refuse this state before its maintenance shutdown.

The independent SQLite probe creates that session/pending-command state. `info_for` reports `unresolvedWork=0`: RED, same raw evidence/probe above. No production records were used.

### R-LEGACY-003 — selected local tree is not bound to the inspected Compose installation

Severity: major. `main` validates the selected local legacy tree, while `inspect_service` locates a fixed global Compose project. Neither compares the project's working-directory/config-file labels to the selected `root/current`. With a copied legacy tree, rehearsal can report success against the live Hub while an apply would stop the live global project and switch only the copied tree. The process/service identity and local deployment pointer are not a single verified target.

Independent `main` probe provides a valid copied tree with deliberately different live Compose identity and mocked external rehearsal operations. The actual main function returns `REHEARSAL_PASSED` instead of refusing. The probe now has3RED cases; raw `.metaproject/data/gdctx/raw/2026-11-01T16-02-36-417Z-08b17c_run.log`. Bind all relevant service labels to the chosen current tree before prepare/apply, and revalidate identity before mutation.

## Historical observations — repaired/disposition recorded

- Root execution is permitted, but the helper executes the selected old hubctl without the trusted-owner/type/mode guard required of the new CLI. Apply the same explicit UID policy or restrict this helper to the known service user. No privileged process or real ownership change was used to investigate this observation.
- Semantic `stateDigest` covers `hub_state` only. The copy retains the entire SQLite image, but current rehearsal evidence does not independently establish remote-machine/session/run table retention. Avoid broadening the proof claim without additional stable remote invariants.

## Reviewed clean boundaries so far

Release checksums, official pinned image, stable version, bundle root/path/type/size quotas and updater protocol are checked before extraction/use. Snapshot uses serialized SQLite rather than copying an open database alone; trial replaces copied DB/WAL with that consistent image. It runs an own random-name volume/container without networking or published ports, fresh bootstrap credentials and read-only role/agent bindings. Cleanup names only its own generated resources. Runtime credentials, role contents, raw Docker inspect/logs and subprocess stderr are not printed. Apply preserves a private configuration/full-volume backup; post-candidate failure never automatically restores older data.

Missing Idempotency-Key in the new write probe was already identified by the coordinator/worker and is not duplicated as a new finding here.

No runtime source edits or production mutation by reviewer. Root's actual Docker E2E/rehearsal are separate evidence and do not replace the negative probes above.

Routing: index, testing context and local review skills read; graph used earlier for bounded orientation only; wiki index read for deployment/auth flow context; ctx used; raw rg not used.

Existing helper/API regression wrapper passed3tests/11assertions (including the5Python leaf tests); raw `.metaproject/data/gdctx/raw/2026-11-01T16-02-54-668Z-52b49d_run.log`. These green existing cases do not cover the three failing independent negative cases. The known idempotency header correction is present and exercised against the actual API.

## Final repair verification

All five scoped items were addressed. The helper now atomically owns the same `state/lock` used by hubctl. A private nonce plus direct-parent PID permits only explicitly dispatched helper children to borrow it; the child does not acquire ownership or remove the parent's lock. Pending session projections contribute to unresolved-work refusal. `bind_installation` checks project/service labels, physical working directory and contained expected Compose files for all three services, and main rebinds immediately before mutation. Source tool/directories/current-link enforce trusted UID0 or invoking UID plus expected type/mode. SQLite retention evidence streams every remote table's ordered columns/rows into per-table hashes/counts and an overall digest; only the writer-version marker is excluded. JSON body, IDs, ownership columns and row deletion therefore remain observable.

Executed independently after repair:

- Original3negative probes nowGREEN: raw `.metaproject/data/gdctx/raw/2026-11-01T16-11-00-673Z-a0af3e_run.log`. The unchanged copied-root main fixture can now refuse earlier on its simulated-UID mismatch on macOS; that fact alone was not accepted as causal root-binding proof.
- Separate reviewer-authored final-guard suite4/4PASS: positive same-tree identity followed by mismatching each service and an external config file; positive root/invoker UID and negative foreign UID; non-body remote ownership-column change/deletion and writer2→3 exclusion; delegated direct child retains parent lock while a token-inheriting grandchild cannot borrow it. Raw `.metaproject/data/gdctx/raw/2026-11-01T16-13-45-735Z-a8da88_run.log`; source `output/release-adoption-final-guards.py`.
- Permanent Python suite10/10PASS; raw `.metaproject/data/gdctx/raw/2026-11-01T16-13-51-037Z-28f172_run.log`.
- Bun helper/API/release-tool suite10/10PASS,45assertions across2files; raw `.metaproject/data/gdctx/raw/2026-11-01T16-11-03-306Z-e3c724_run.log`. This includes the actual schema-valid idempotent HTTP write, not only string inspection.

No remaining actionable finding in this repaired scope. No runtime code edits, real credentials or production mutation by reviewer. No unrelated hardening was added.

## Evidence boundary for draft PR1113

The owner now wants a draft PR for review, without merge, tag, release or production cutover. Because the successor release must not be published yet, a complete helper entrypoint run against official published successor artifacts remains a post-review/release gate. No fake official digest or bypass of archive verification was accepted. The coordinator separately runs real Docker lifecycle E2E and production-copy component rehearsal with the final helper/history comparison; those results must be recorded separately, not inferred from these local tests. Owner-run apply remains an explicit later action.

Reviewed SHA256: helper `0a6c111f5c55e00e2909f0fbaefbda5a94c48c3e34ac4a2458e7266d49e55fae`; hubctl `8ba102f734558bb09bf2ae86881fba0904391cc17a4030c9a2b4989ed8ed7afa`; bundle `e81ef9d428745a5f4184e8e101c8f3b2c5381897a7bb6a337c9e425fc30ee645`; owner runbook `186b22b81edd61112bea215ab4b3b40a928a3b6246186f08ed33ef91b4fb3ad2`. Later runtime changes invalidate this exact snapshot's approval until affected-scope verification.
