# Start a Hub session in an existing checkout

The main checkout on geekom exceeds the snapshot limit before any agent starts.
The inventory also treats a dirty checkout differently from a clean checkout,
so a dirty oversized copy can appear launchable. A mapped copy whose profile
has not been added to the machine policy is a separate setup problem.

- Support the existing main checkout, including staged, unstaged and untracked
  files, under a bounded 2 GiB / 50,000-entry workspace snapshot. Keep the
  existing result upload limit and preserve the baseline digest format.
- Check launch eligibility during inventory measurement without hashing file
  contents. Recheck on launch, and report why an unavailable checkout or
  unready agent profile is blocked in the session form.
- Verify an oversized dirty copy, recovery after it shrinks, and a new session
  in the real main checkout on geekom without modifying the owner's edits.
