# R03 admission result

## SEC-W31-001

`src/hub/mutation-queue.ts` keeps the original global `maxRequests` and actual aggregate-byte accounting, and caps public readers at `max(1, floor(maxRequests / 2))`. `src/hub/server.ts` classifies decoded POST session and machine enrollment routes; headers cannot select the public class. Nested MCP admissions still reuse the parent slot. Rejected bodies are cancelled before reading. At `maxRequests=1`, the one public reader can occupy the only slot; reserving it would prevent login entirely. Larger limits reserve at least one slot for protected traffic.

`slow public login bodies cannot exhaust authenticated mutation admission` is green after the original RED documented in admission-red.md. It holds all admitted readers and allows excess public requests to be rejected before reading, then confirms an authenticated mutation succeeds and abort cleanup restores capacity. `small global limit 1/2` covers decoded enrollment and login aliases, rejection before reading, authenticated admission at 2, and login recovery; `public and protected traffic share the hard global request ceiling` checks the global cap; `protected routes reject unauthorized requests before reading their body` checks auth ordering. Existing queue tests exercise nested MCP, byte accounting, timeouts, and cancellation.

## W2-010

`authenticated machine stream over remote parser limit is cancelled without mutating state` calls the real remote handler directly to isolate the 32 MiB parser guard. It passes baseline and kills the exact `w2-supplement-remote-stream-limit` mutant: in an isolated `git archive HEAD` scratch copy, deleting `if (size > maxBytes) { await reader.cancel(); fail(413, "quota-exceeded", "Request exceeds quota"); }` caused this test to fail at `cancelled` (expected true, received false; exit 1). The parser's downstream JSON check also returns 413, so cancellation is the discriminating assertion.

## Verification

- `keryx ctx run -- bun test src/hub/admission-regression.test.ts src/hub/mutation-queue.test.ts src/hub/server.test.ts src/hub/remote-v2/authority.network.test.ts`: 31 pass before the final two added tests; `keryx ctx run -- bun test src/hub/admission-regression.test.ts`: 6 pass after additions.
- `keryx ctx run -- bun run typecheck`: pass before the final two straightforward test additions.
- `keryx ctx run -- bunx eslint src/hub/mutation-queue.ts src/hub/server.ts src/hub/admission-regression.test.ts`: pass before final two additions.
- Scratch mutant: `bun test src/hub/admission-regression.test.ts -t 'authenticated machine stream over remote parser limit'` exit 1, expected kill.

Files modified: `src/hub/mutation-queue.ts`, `src/hub/server.ts`, `src/hub/admission-regression.test.ts`. No commits or review input edits.

Routing audit: graph_used yes (reported stale due to untracked node_modules, used advisory only); wiki_used no (targeted admission correction, no domain discovery); ctx_used yes; raw_rg_used no.
