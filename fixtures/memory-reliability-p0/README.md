# Memory reliability P0 authority fixture

This fixture intentionally contains one matching entry for each lifecycle
status plus an expired entry and a `Valid-To` boundary entry. P0 tests use it to
freeze current/as-of selection semantics before P3/P5 change automatic recall
and temporal behavior.
