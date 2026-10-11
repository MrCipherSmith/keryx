# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: In `trust` and in `review-auto`, a single named table (one source file, no literals elsewhere) lists the read-only keryx commands that run without a prompt: `keryx help`, `keryx <command> --help`, `keryx harness list|status|--help`, `keryx agents external list --no-probe`, `keryx review ledger build|status|required|reviewers|tier|retry-plan|dispatch-check`, `keryx flow status|list|next`, and the slate note/trail tools. A test per entry runs it after untrusted content and observes zero prompts.
- AC2: A command outside the table, or one that chains a listed command with `;`, a pipe to an unlisted command, a redirect to a path outside the working tree, or a subshell, still prompts; a test per form.
- AC3: The hard floors are unchanged: destructive, credentials, publish lease, hook-tightened `ask`, and any unlisted call after untrusted content still ask in `trust` and `review-auto`; the existing floor tests pass unchanged.
- AC4: A call the operator refused, or the policy refused, is answered to the model as `refused earlier: choose another path` without a modal when it comes again in any spelling that normalizes to the same fingerprint (argument order, whitespace, quoting, `--json`-style output flags, trailing `--help`); a test sends three spellings and sees one modal. The memory is still cleared only by restarting the shell.
- AC5: Every approval modal shows a one-line cause from a closed set (`destructive`, `credentials`, `publish`, `hook-ask`, `untrusted-content`, `not-in-routine-list`, `mode-ask`); a test per cause. The same line appears in the Telegram relay of the prompt.
- AC6: A message typed while a turn runs is shown in the queue with its state and the reason it waits (`waits for the current turn`, `waits for approval of: <call>`); `/queue` lists the same text, and `[Force]` is explained by one line. A TUI test renders the queue with an approval pending.
- AC7: Replay: the approval log of runs 17-19 is run through the new classifier in a test fixture; the number of prompts that remain is stated, and every remaining one is a floor or an unlisted command (listed with its cause).
- AC8: Live: the PR 7435 review on a keryx shell in `trust` + `review-auto` shows no more than the prompts that the replay predicts, and no repeated modal for one refused call.
- AC9: `docs/docs/guides/permission-modes.md`, the CLI reference and the CHANGELOG state the table, the denial memory and the cause line; the docs site builds with --strict.
