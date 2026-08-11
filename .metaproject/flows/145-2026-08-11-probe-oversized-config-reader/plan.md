# Plan

1. Give the child probe an explicit bounded deadline and terminate it on expiry.
2. Await process exit before draining pipes; return timeout state distinctly.
3. Assert the raw oversized-read probe exits non-zero promptly, not merely that the outer test expires.
4. Run focused guards and CI.
