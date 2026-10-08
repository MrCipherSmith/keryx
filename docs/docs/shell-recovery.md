# Interactive shell recovery

The agent mode of `keryx shell` and `keryx shell --no-tui` automatically waits
and retries a temporary model-provider failure within the original turn. No
new “continue” message is needed after the service or network recovers.
Chat-only, print, unattended, ACP, subagent and TUI side-worker calls keep their
existing behavior; recovery is an explicit host opt-in.

## Waiting and stopping

Retryable structured provider errors (including 429, overload and 5xx), recognized
transport failures and an incomplete transport stream are recoverable. Other
malformed responses and programming errors terminate rather than loop.

Each failed attempt displays `[recovering]`, its attempt number and the delay
before the next probe. The TUI keeps its foreground operation occupied; queued
main-agent messages and task wakes wait for it to settle. The composer and stop
controls remain available. Cancel/stop/exit abort the request or backoff;
readline Ctrl-C aborts before shutdown cleanup. Lease loss and a session switch
invalidate the active request. Rewind is refused while a foreground turn is active.

The exponential ceiling starts at 1 second, doubles per failure and caps at
60 seconds. Jitter selects 50–100% of that ceiling, so long outages probe every
30–60 seconds. A provider `Retry-After` hint (seconds or HTTP date) is a minimum,
bounded to 5 minutes; malformed or negative hints do not create a busy loop.
There is no short attempt-count cutoff: a recoverable outage keeps probing until
success, cancellation, a permanent failure or a hard resource limit. These are
runtime defaults, not new environment settings.

## History, tools and usage

Each attempt uses the last completed model round's history. Streamed text and
thinking previews are provisional until a valid `model_end`. Failed output is
marked `[interrupted output]`; the next attempt starts a fresh display stream.
Partial text, reasoning and opaque reasoning replay artifacts never enter the
saved conversation or the next model request. The visible partial answer may
still be on screen; it is not a completed response or byte-level continuation.

Tools from an incomplete or failed attempt never execute, even if complete
arguments arrived. Earlier completed tools and their results stay in the same
turn; retry does not re-run them or reset approvals, tool/subagent counters or
round limits. A failed transport attempt does not consume a successful model
round. Existing context-overflow compaction remains a single bounded retry.
Recovery does not automatically re-execute a tool whose external outcome is
unknown: inspect/reconcile its effects before choosing a new action.

Reported usage from failed attempts is forwarded to the host's existing usage
accounting. Missing usage is explicitly shown as unknown, not treated as free.
Each request retains the configured output-token limit. Hosts with a spend or
time ceiling can refuse the next request through the recovery admission callback;
recovery neither invents a new spend limit nor resets an existing one. An outage
may still incur provider charges, including charges whose usage was not reported.

## Permanent access errors

Generic HTTP 403, invalid requests, permission/entitlement/policy failures and
authentication errors terminate with account/model/access guidance. Use `/connect`
and check the account's model entitlement, credentials and access policy before
retrying manually. A generic 403 is not evidence of a temporary outage. A 403 can
recover only if the adapter explicitly classifies it as retryable unavailability,
overload or rate limiting. Existing supported credential refresh remains owned by
the provider adapter and bounded before streamed output; the supervisor does not
refresh credentials or switch accounts/providers.

Recovery exists only while the shell process and logical turn remain alive. It
does not resume after process exit, promise remote stream continuation, or provide
exactly-once guarantees for external tool effects of unknown outcome.
