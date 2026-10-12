# Locator merge regression and targeted review

Historical CI merge: 9127d78b8f098be928d66fe928cde9999ba67d7c; PR head e7e8586f74feddbd5466bf32df8b08c1b151b390.
The merge contains the newer flow412 PII detector; head-only diagnostics used a different detector and could not reproduce the failure.

Baseline with deterministic delivery runId: 25 pass, 1 fail, exit 1. The failing stopped-run locator contains [REDACTED:phone].
Candidate delivery plus locator regression: 30 pass, 0 fail, exit 0. See old.log, new.log and summary.json. Candidate source hashes agree between merge and fix worktrees.

Independent targeted static review sub:40aaaa4b-d4da-446e-a875-9e41ae56a1d2: PASS, no helper security blocker. The reviewer examined the isolated merge tree but could not access sibling execution logs; counts were verified by the parent, not independently rerun.
The helper restores only phone findings within a strictly generated basename, only when the complete scrubbed output equals phone-only redaction. Directory PII, arbitrary names and environment secrets retain redaction.

Limitations: diagnostic artifacts download failed with TLS timeout; full job logs available outside this commit. RemoteHub may apply downstream redaction again; end-to-end Telegram locator behavior is not established. This targeted review is not the final exact-SHA review of PR917.
T4 remains blocked pending publication, CI and final review. AC11 remains open; no operator acceptance, merge or release is asserted.
