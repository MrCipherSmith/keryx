# T35 native reader cleanup compatibility

STATUS: DONE

Actual root cause: pinned Bun1.3.14 incoming HTTP reader.releaseLock throws TypeError after successful MCP action; cleanup replaced its valid response with500. Request-constructor hypothesis refuted. Cancel-afterEOF guard and earlierEOF release also did not fix native release.

Fix preserves nonblocking source cancellation, tolerates known release TypeError only after cancellation requested, always releases bytes/slots, and preserves action errors.

RED/GREEN realTCP SDK regression. Extracted frozen offline actual Hub/MCP proof PASS7assertions. Full relevant pinned-runtime subset40tests331assertions PASS. Root types/focusedlint/diffcheck PASS.

Frozen2paths: mutation-queue.ts and mutation-queue-http.test.ts. Exact test names/logs in runtime-compat-results.json. No package-test source edits required; existing integration proof now passes. No commits/push or production actions.
