# Locator downstream verification

Parent static inspection: digest hubSink -> RemoteHub sendToSessionTracked/sendToServiceTopic -> sendTracked -> OutboundQueue.formatReply -> sendRendered. The send path does not reapply redaction; RemoteHub redaction applies to edits, callback answers and diagnostic events.

Four regressions exercise session/service targets and immediate/queued delivery through the real hub over fake Bot API. Head and historical merge-tree candidate suites each: 34 passed, 0 failed; typecheck PASS. Logs attached. Historical old-fail/new-pass proof and earlier independent helper-only static review remain in ../locator-merge-proof/.

Independent downstream final reviewer timed out after 300 seconds without a verdict; this is NOT a review PASS. T4 remains blocked pending exact-SHA independent review and fresh CI. All delivery transports are fake; no live Telegram or released npm operator acceptance. AC11 remains OPEN. Prior AC9 confirmation belongs to 290591c7b, not this candidate.
