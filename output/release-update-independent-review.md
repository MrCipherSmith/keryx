# Release-backed Hub update CLI: independent review

STATUS: DONE

Current verdict: APPROVE for the reviewed CLI and hubctl delta after the two reproduced findings below were corrected. Actual Docker install/upgrade/rollback E2E and production-data migration rehearsal remain separate required release gates.

## Stage1: contract coverage

CLI modes match the authorized specification. Apply/check/dry-run route to argument-array delegation of the explicitly resolved installation-owned tool; no project URL/token/MCP operation is used. Input rejects unknown/conflicting/duplicate flags, malformed versions, URL-like paths and control characters before execution. Existing Hub commands remain routed through their original client. Dedicated help is reachable without installation. Missing/legacy layouts return explicit errors. The CLI does not implement network operations or rebuild the server.

## Historical finding R-CLI-001 — foreign-owned installation tool/directories lack the specified ownership guard

Severity: major. Source sites: `src/commands/hub-update.ts:48` and `src/commands/hub-update.ts:57`. Enumeration: installationTool has one executable lstat and one directory-stat loop covering root/releases/current; both inspect type/mode but neither inspects uid.

The agreed trusted-owner policy is UID0 or the invoking UID. Mode0700/0755 does not establish that policy: a foreign owner retains write authority over its own executable or directory. A privileged operator selecting such an installation can therefore execute code controlled by a different UID despite the purported release-owned guard. This is a local administrative boundary, not an HTTP/MCP privilege claim.

Independent probe `output/release-update-owner-probe.test.ts` supplies foreign executable uid metadata while preserving actual file/layout/mode. It expected refusal but the original implementation executed successfully: RED,1failure. Raw evidence `.metaproject/data/gdctx/raw/2026-11-01T15-20-02-805Z-0144bf_run.log`. No actual chown/sudo/server changes were made. Fix expected: apply explicit trusted-owner checks to the tool and the root/releases/current directories, preserving existing type/mode/containment rules and mixed invoking-user/root legitimate cases.

## Executed independent checks

- Existing focused CLI/machine/reference/help suite:88passed,0failed,3069assertions across4files. Raw `.metaproject/data/gdctx/raw/2026-11-01T15-17-00-886Z-da90cc_run.log`.
- Independent full-CLI subprocess probe:5cases passed. It verifies actual process exit42 propagation, exact check/dry-run argv, invalid version nonexecution, world-writable tool refusal and help without installation. A deliberately synthetic contributor-token canary was not printed and did not affect administrative delegation. Raw `.metaproject/data/gdctx/raw/2026-11-01T15-18-50-239Z-960592_run.log`.

No source fixes by reviewer. Worker applied the root/current-invoking-UID policy to the tool and every checked directory. The unchanged independent owner probe is now GREEN: `.metaproject/data/gdctx/raw/2026-11-01T15-21-34-444Z-26037c_run.log`. Normal CLI tests passed13/13 with57assertions; raw `.metaproject/data/gdctx/raw/2026-11-01T15-21-38-590Z-c1b3fb_run.log`. The independent full-CLI subprocess5case probe passed again after the fix; raw `.metaproject/data/gdctx/raw/2026-11-01T15-22-13-495Z-19315e_run.log`. Ownership probe uses module mocking and must run in its own process, never combined with normal CLI filesystem tests.

Routing: index/local review skills/testing context read; graph_used=yes (orientation predates new CLI); wiki_used=not-relevant (narrow CLI filesystem/argv contract; no new architecture inference); ctx_used=yes; raw_rg_used=no.

## Hubctl stage1 and correctness/security pass

Reviewed changed update inspection, download validation, compose pass-through/staging, trial settings parser, compatibility preflight and recovery branches. Read-only check/dry-run download into a disposable directory outside the installation, never acquire its state lock or call Docker. Required artifacts/checksums/pinned image and archive regular-member rules are validated before use. Version/image values inserted into JSON are character-constrained. Public arguments and mount settings are passed as arrays/quoted arguments, without shell interpolation of credential values.

Configured Work settings reach the released Compose. Installed custom Access overlay is copied into the next release; global install override retains precedence. Trial config selects only bounded named settings and the configured role-file bind mount, forces that mount read-only, generates fresh operator/agent tokens and runs a copied volume without networking/ports. Normalized Compose JSON and generated env remain private temporary files; no operator/agent/reviewer credential is forwarded by the settings whitelist or printed. The Work repository registry may itself contain configured provider credentials, so it remains private configuration rather than public report data.

Plain rollback performs a consistent online SQLite snapshot and target-image trial before stopping current service, then a final quiescent-copy trial before switching. Failed post-switch upgrade saves latest data and tests the prior image against that latest snapshot; it never automatically restores pre-upgrade data. An incompatible prior image leaves the candidate selected/stopped for forward repair, with latest data and safety backup intact. Destructive restore remains a separate explicit operation with current-data backup.

### Historical finding R-HUBCTL-001 — explicit older target through upgrade bypassed pre-stop downgrade refusal

Severity: major, spec compliance/availability. Class scope: two downgrade entry paths, cmd_rollback and cmd_upgrade. The initial implementation guarded only rollback online. Independent probe executing actual cmd_upgrade against synthetic shell ports observed actions `[stop,trial,start]` for an incompatible older target. The current data/pointer were preserved, but live service was unnecessarily stopped before discovering incompatibility. RED raw `.metaproject/data/gdctx/raw/2026-11-01T15-26-10-094Z-7ad53e_run.log`.

Worker now rejects non-newer upgrade targets before Docker/lock/service mutation and directs explicit downgrade to the compatibility-checked rollback path. The unchanged independent probe is GREEN with actions `[]`; raw `.metaproject/data/gdctx/raw/2026-11-01T15-27-28-973Z-c58412_run.log`. Source semantic-version comparison and call ordering were inspected; no remaining bypass found in these two entry paths.

### Additional independent executions

- Actual hubctl + local checksummed synthetic release:3casesPASS. Check and dry-run preserve a complete recursive installation manifest (files, modes, symlink pointer); a tampered artifact refuses without changes. Docker stub was never called. Raw `.metaproject/data/gdctx/raw/2026-11-01T15-28-16-822Z-f0b3da_run.log`.
- Production trial-settings parser:4casesPASS. Valid settings/role mount preserved; synthetic credential canaries excluded; multiline settings, mount option injection and missing role mount rejected. Raw `.metaproject/data/gdctx/raw/2026-11-01T15-29-19-586Z-deb554_run.log`.
- Permanent release-tool suite:7passed,0failed,34assertions; raw `.metaproject/data/gdctx/raw/2026-11-01T15-29-02-937Z-a955ef_run.log`.

These are separate scopes, not an aggregate test total. No Docker daemon, production service, real credentials or runtime source edits were used by this reviewer. Actual Linux Docker E2E and data migration rehearsal must complete independently before publication/use.

Reviewed runtime SHA256 values: CLI `86097d61ab98d6fd7cb8fec3fa3b3468004d839c1424751501a16ec39bfd6ab8`; hubctl `a6c09d6402f8eff1c8939f6b87deca562fe8adeea000436012f97d852a270b3b`; Compose base `cda68e3eb5fd4c8cb6d149e97b3997efcb9833838fe942b345684b9d915712bb`. Any later changes require affected-scope review. Wiki index also read for the extended SSO/trial review.
