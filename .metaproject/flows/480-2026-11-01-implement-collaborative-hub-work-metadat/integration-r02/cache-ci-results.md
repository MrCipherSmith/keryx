# T42 portable offline-cache correction

STATUS: DONE; four owned files frozen.

Confirmed cause: Bun1.4.4 changes its offline cache lookup when --registry changes. With the SAME complete privatecache, default registry installs offline successfully; loopback registry reports all92pins missing. Exact Linux --network none control excludes internet or hostcache fallback.

Fix preserves registry identity and uses a rejecting TCP proxy with both bypass variants cleared; CI additionally disables container networking and forbids implicit pulls. Full privatecache/source validation and zero-connection assertion retained.

Verification: MacBun1.3.14/1.4.4 each10PASS70assertions; isolated LinuxBun1.3.14/1.4.4 each4PASS19assertions including actual extracted SDK/runtime; default hermetic9PASS1explicitintegrationSKIP; lint/types/diffcheckPASS. Complete logs/commands in companion JSON.

No production access, deployments, shared dependency changes, staging, commits or push.

Compliance follow-up: CI HOME override removed. Exact direct Bun Docker proof passed as arbitrary UID1001:1001 with read-only workspace+cache, --network none --pull=never, and no HOME override: Bun1.4.4 and1.3.14 each1PASS7assertions. Additional UID1001 diagnostic4PASS19assertions. No permission loosening or fixture/realdata mutation needed. Same4paths frozen; diffcheckPASS.
