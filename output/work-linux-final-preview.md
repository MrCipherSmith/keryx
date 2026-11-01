# Final isolated Linux preview

STATUS: DONE

Result: PASS for isolated source-archive installation, existing synthetic database reopening, authenticated HTTP reads and official-SDK MCP. This is not a production cutover or a real provider execution claim.

- Source archive SHA256: `54d1e3916ab1fd05ee189de1f683f4b86c46b47183786f563e8f9df792d492a3`.
- Frontend input digest: `7e9ed0a2f870a5b77be4295a223ec48da69b6cf49ebfe9218a968c5e368c565f`.
- Host: geekom, Linux x86_64, existing Bun1.4.4. No sudo/global install used.
- Source: `/home/altsay/.cache/keryx-work-preview.cPfTN4/team-hub-prototype`.
- Previous candidate retained in the same private parent under `previous-candidate`.
- Frozen production dependencies installed offline with ignore-scripts in isolated runtime/cache.
- Only verified owned preview PID2929345 was stopped; replacement preview PID3201821 binds `127.0.0.1:19879`.
- Existing disposable fixture database `/tmp/keryx-work-demo-Y2PbSC` reopened; project `work-demo-project` retained.
- HTTP health, authenticated managed capabilities and Flow list returned200.
- Official MCP SDK initialized, discovered37managed-work tools and read the fixture Flow: PASS.
- Laptop SSH forwarding exposes the loopback service at `http://localhost:18794`.

The archive was hash-checked and extracted only after validating its single expected root and regular-file/directory members. Preview credentials are intentionally public dummy fixture values from the tracked smoke launcher, never production credentials. Production Hub, Cloudflare, DNS and production data were untouched. Public deployment and human product acceptance remain pending.
