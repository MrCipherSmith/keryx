# Independent final review PR #917

Head: 290591c7b553cc9a2804a47eee288694cfbc166c
Base: 9d4cbc364cc1fdd6b2e88a1d64527fa738b40983
Verdict: CHANGES REQUIRED. Exact-head CI is green but does not cover the production policy bypass.

Two independent read-only reviewers inspected routing and nonrouting committed changes. Reviewers did not run tests; green CI is separately recorded evidence.

## P1: fallback classifier bypasses external policy
src/tui/routing-classifier-source.ts:119-123 accepts candidates when classifierAllowed is absent. Production caller src/tui/tui-shell.ts:9515-9528 does not supply that hook. With /external off and Anthropic in the editable blocked-provider list, saved credentials and an eligible Sonnet candidate still permit fallback classification after JEV is blocked. MainModelTaskClassifier sends up to 2000 raw prompt characters. Parent verified candidate predicate and production call; JEV enforces its own external policy separately.

Required fix: enforce freshly resolved project/user external provider/model policy before candidate ranking, retain any additional caller policy, and add production-construction fake-fetch coverage proving blocked candidates receive zero requests and an allowed alternative or safe baseline is used.

## Nonblocking risks / coverage gaps
- Routed dependency preparation has no deadline/signal; abort guards prevent late dispatch but do not prove a hung preparation promise releases the foreground operation.
- Graceful server stop is bounded to 250ms; forced stop remains unbounded. Two SSE-stream coverage does not cover a stalled/backpressured connection. No demonstrated regression.
- cron subprocess import uses URL.pathname; escaped checkout paths may fail. Prefer fileURLToPath or URL.href. Supplied checkout/CI does not establish failure.

No other concrete nonrouting defects identified. AC11 remains open; no merge, release, commit or push performed by this review.
