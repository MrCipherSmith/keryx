# SESS-09 — interrupted turn stays resumable with partial answer

**Area:** 1. Session lifecycle · **Date:** 2026-08-22 · **Status:** PARTIAL — real attempt, inconclusive on the core claim; one real, separate finding surfaced along the way

## Test case (from the catalog)

> Start a long turn, kill the process mid-stream (`SIGTERM`), then `-c`. Expected: last partial
> assistant text is present on resume, not lost.

## What was actually run (three real attempts)

```bash
# Attempt 1: SIGTERM after 4s
printf '<long-essay prompt>\n' | DEEPSEEK_API_KEY="$(...)" keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp > out.txt 2>&1 &
sleep 4; kill -TERM $!; wait $!
# -> exit 143 (SIGTERM). Session 603e7e5d.

# Attempt 2: SIGTERM after 9s, longer/more-demanding essay prompt
# -> exit 143. Session 04bd819c.

# Attempt 3: SIGINT after 15s
# -> process did NOT exit within the remaining test window (30s Bash-tool timeout hit first).
# Session 602368fa.
```

## Captured evidence

- **Captured stdout**, all three attempts: only the header (`Session <id> · per-project`) and
  the `● keryx` turn-start marker — no streamed assistant text visible in any of the three runs
  before the signal landed.
- **On-disk `context.jsonl`**, attempts 1 and 2 (checked directly): only the `user` message entry
  is present in both cases — no partial `assistant` entry, at either 4s or 9s.
- **Attempt 3 (SIGINT) did not terminate the process** within 15 additional seconds — confirmed
  via `pgrep`-style inspection that the `bun ... keryx shell` process was still alive when the
  outer Bash tool's own 30s timeout finally cut the whole command chain. This is consistent with
  a readline shell trapping `SIGINT` for a "press again to confirm exit" UX rather than exiting
  immediately — reasonable interactive behavior, but it means `SIGINT` is **not** a reliable way
  to interrupt a headless/piped `keryx shell` process within a short, scripted window.

## Summary

**Inconclusive on the documented claim.** Across three real attempts (4s/SIGTERM, 9s/SIGTERM,
15s/SIGINT), no partial assistant text was ever observed either in captured output or in the
session's own `context.jsonl` before the process was interrupted. This could mean:

1. The model (`deepseek-v4-flash-vision-exp`) genuinely had not started streaming visible
   content back within these windows for the specific long-essay prompts used (plausible — a
   demanding "write 1500-2000 words" instruction may have a longer thinking/first-token latency
   than the shorter, tool-call-driven prompts used successfully everywhere else in this testing
   campaign); or
2. The 300ms streamed-journal checkpoint (`docs/docs/harness.md`: "streamed assistant text is
   journaled at most every 300 ms") genuinely was not triggered because too little text had
   accumulated to matter; or
3. There is a real gap between the documented checkpoint behavior and what actually lands on
   disk before a signal — not confirmed or ruled out by this test.

## Analysis

This test needs a cleaner methodology than three ad hoc attempts to be conclusive: either a
prompt verified to start streaming visible tokens within ~1-2s (so a 3-4s kill window reliably
lands mid-stream), or instrumenting the wait loop to poll `context.jsonl` for the first
`assistant` entry's appearance before sending the kill signal (rather than a fixed sleep guessing
at timing). Neither was done here due to time budget in this pass.

**Separate, real, confirmed finding, independent of the main claim:** `SIGINT` sent to a headless
piped `keryx shell` process does not cause it to exit within a reasonable window (15s+) — it
appears to be trapped for interactive confirmation that a piped/non-TTY process can never supply.
`SIGTERM` does cause immediate exit (both attempts 1 and 2 confirmed this, exit code 143).

## Improvement / fix suggestion

- For the interrupted-turn claim itself: re-test with a tighter, instrumented timing methodology
  before concluding either way — do not treat this report as having disproven the checkpoint
  behavior, only as not yet having confirmed it.
- For the `SIGINT`-on-headless finding: worth deciding deliberately whether a piped/non-TTY
  `keryx shell` process should treat a single `SIGINT` as an immediate, unconditional exit (since
  there is no terminal to show a "press again" prompt on, and no way for the confirmation to ever
  arrive) rather than applying the same trap it uses for a real interactive TTY session. If this
  is already intentional (e.g., a script is expected to use `SIGTERM` instead), it's worth a
  one-line note in `harness.md`/`onboarding.md`'s TTY/CI behavior section, since `SIGTERM` and
  `SIGINT` differing this way for scripted/CI use is a real, non-obvious gotcha.
