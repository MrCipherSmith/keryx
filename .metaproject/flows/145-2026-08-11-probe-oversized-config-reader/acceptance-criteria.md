# Acceptance Criteria

- AC1: The oversized raw-read probe has its own bounded deadline shorter than the test timeout and cannot leave a child process running.
- AC2: The harness waits for child termination before draining stdout/stderr, avoiding a pipe-induced outer-test timeout.
- AC3: A genuine raw oversized read still proves non-zero termination; a harness timeout fails with a clear assertion rather than passing.
- AC4: The focused config-reader guard suite and CI typecheck/tests pass.
