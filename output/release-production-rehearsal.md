# Release updater: production backup and isolated verification

Status: candidate verification only; production remains on its old image. PR1113 stays Draft. Owner review must precede merge, tag or release.

## Verified backup

A brief write-quiescent backup was taken on geekom after confirming there were no remote runs, sessions, queues or commands. The old Hub was immediately restarted and its health checked. Backup root: `/home/altsay/keryx-team-hub/backups/pre-work-release-20261101T133056Z` (the directory timestamp is UTC).

- Full volume `hub-data.tar`: SHA256 `08d75b5f93b09b0614d4974d036c75e5e8ea58e86f1c28ce34975b7f6295b120`.
- Private configuration archive: SHA256 `a9dbdc1eaef2ca742cd86694f24c3d04eef77d855a2d8d0f67facbd01657796f`.
- Original Docker image export:144371826bytes; SHA256 `4d4cd86fd87d34e8d0a713737ea4e543e1f252e64dd93c84fca8b542f05a16f9`.
- Original image ID: `sha256:b202117e3261e5cbfd799cfa7e64045e451b16c0ae0723e3266dc5c721d7ab9e`.
- Restored SQLite integrity: `ok`; writer marker2. Retained2projects,162documents,1proposal,9Flows,46Evidence,10revisions,0deliveries,99events,163documentChanges.
- Original serialized legacy-state SHA256: `f7be8edf443b467448d050d1b9288837b1f5ef7a7033baf1144d360f66d3f3e3`.

Credentials/configuration contents and production data remain in owner-only server files; they are not committed or printed in this report. The old image, current pointer and original named volume were retained.

## Isolated candidate verification

Candidate image `keryx-team-hub:work-update-rehearsal` was built on geekom from the packaged allowlisted source archive, not a developer node_modules tree. The baseline archive SHA256 was `f79b7328803358ed9d7de1a365e4ea333e565268f54d2cb366dd4c54dcd6275f`.

Actual Docker release-tool tests exercised installation, backup/restore, update checks and dry-run, upgrade, SSO/Work configuration retention, compatible rollback, failed-upgrade recovery preserving current data, and refusal of a writer3-incompatible rollback before stopping the current instance. Earlier fixture Origin and missing Idempotency-Key failures were repaired without weakening server authorization/idempotency.

The actual new migration probe also ran on a network-isolated copied production volume. It authenticated old reads, created Work only in the disposable copy and verified the original production container and legacy state remained unchanged. The final reviewed helper additionally verifies Compose identity and remote-table history; its final execution receipts are appended below.

## Boundaries

This is not a production upgrade, a real Cloudflare browser-login proof, or product acceptance. Tokens are regenerated for isolated trials while existing role/agent configuration mounts are read-only. The official0.4.4 artifact does not exist yet: a full target-artifact helper entrypoint check must follow owner review and actual release publication. Do not invent a registry digest or bypass artifact validation to simulate that check. The owner performs the explicit live apply after the verified release is available.

## Final reviewed-script receipts

- Final Docker E2E exit0: `/home/altsay/.cache/keryx-release-rehearsal.erMnbB/release-e2e-reviewed.log`. This run included the final reviewed locking guard and migration helper in the bundle.
- Final production-copy receipt: `/home/altsay/.cache/keryx-release-rehearsal.erMnbB/production-final-copy-_moi3_67/rehearsal-result.json`; result `FINAL_PRODUCTION_COPY_REHEARSAL_PASSED`.
- Real Hub/edge/tunnel Compose labels matched the selected physical installation. Legacy digest `0e0238a37d588c70f9d5444cbd48ca834b7590172b6ff4bc542364e26b1f9ffa` and remote-history digest `9c59ab7d0137d577a1ff9c99b4dcf94e638f4ebac5488a4acf5b1f67c4e10225` were preserved. Remote project references2; other existing remote tables empty. Nonempty-row change/deletion sensitivity is covered separately by the permanent and independent negative fixtures.
- New Work write occurred only on the disposable copy; original production container and legacy/remote state were unchanged.
- Independent repaired-helper review APPROVE in `output/release-legacy-independent-review.md`; final local QA PASS in `output/release-update-quality.md`.

These results make the code ready for the owner's requested review, not for an automatic merge, tag, published release or production cutover.
