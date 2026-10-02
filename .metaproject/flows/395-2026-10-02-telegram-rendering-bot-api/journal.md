# Flow Journal

- 2026-10-02T15:39:32.323Z - flow created
- 2026-10-02T15:53:46.345Z - frozen: 11 criteria; checksum recorded
- 2026-10-02T15:53:46.835Z - started
- 2026-10-02T16:44:42.659Z - implemented: draft PR: 863 (base: main)
- 2026-10-02T19:06:15.258Z - ac-updated: AC9: "Text without a table, a numbered or nested list, a task item or a rule renders byte-for-byte as it does in 0.3.63, and the existing format, HTML and outbound tests pass unchanged. [verify: invariant `bun test src/remote/format.test.ts src/remote/format-html.test.ts src/remote/outbound-html.test.ts`]" -> "Text without a table, a numbered or nested list, a task item or a rule renders byte-for-byte as it does in 0.3.63, except one case: a link whose visible label reads as a web address (starts with http:// or https://, or www., or is a host with a dot) for a different host than its target gets the target host written after it, as ' (→ host)'; every other link is unchanged. The existing format, HTML and outbound tests pass unchanged. [verify: invariant `bun test src/remote/format.test.ts src/remote/format-html.test.ts src/remote/outbound-html.test.ts`]" (Operator poll 46: S-002 is fixed in this PR, so a link with a URL-like label for another host deliberately renders differently from 0.3.63; carve out exactly that case)
