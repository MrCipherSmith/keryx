# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A source-level readers guard derives its denominator from the tree, not from a hand-written list: it scans `src/`, blanks string literals and comments first, and reports every file that resolves a path inside the shared user-global directory and then reads it other than through the sanctioned bounded helpers. Exemptions are declared with a stated reason; an exemption without a reason fails the suite.
- AC2: The readers guard reports every planted reader shape — `readFileSync`, `readFile` from `node:fs/promises`, `Bun.file(...).text()`, `createReadStream`, `openSync` + `readSync`, `readdirSync` + a per-entry read, a raw call whose trailing comment names the resolver, and a raw call in a file that also contains a glob string literal — and reports none of a file that goes through the helpers, so the guard is not satisfied by a detector that reports everything.
- AC3: The readers guard is mutation-proof: with a real raw reader planted in the tree, replacing the detector body with `return []` turns the suite red. The mutation and what went red are recorded in the flow journal.
- AC4: `src/session/store.ts:189` (`readSummaryFile`) and `src/session/store.ts:251` (`readJsonl`) read through the bounded path, and the guard built in AC1 is observed reporting both BEFORE they are fixed — recorded in the journal — so the guard is seen finding something rather than added over already-clean code.
- AC5: A behavioural probe drives session list and session resume in a real subprocess against a 3 GiB sparse `context.jsonl` and a 3 GiB sparse session summary, reading the exit code from the process and never through a pipe, and each exits 0 with a printed marker. A control in the same suite proves the raw read still aborts, so the assertions cannot pass vacuously.
- AC6: A non-regular file is refused rather than read: with a FIFO planted in place of each file in the shared directory, every reader terminates with a stated refusal. Each such test carries a timeout that fails on expiry, so a hang is a red test and never a pass.
- AC7: Transcripts carry a bound of their own, declared separately from `MAX_CONFIG_FILE_BYTES` with its own stated reason. Positive control: a transcript larger than the config bound but within the transcript bound resumes with every message intact. Negative: a transcript beyond the transcript bound produces a caller-visible, stated outcome — never a SIGABRT, never a hang, and never a silently empty history.
- AC8: Every operator instruction printed by `keryx serve` is executed verbatim by `serve.recovery.test.ts` with no placeholder substitution, and a placeholder surviving into an executed instruction fails the suite. The existing enumeration of every refusal state stays green.
- AC9: No comment in a touched file asserts a control that no code performs. The three identified claims — `config-dir.ts:70-73`, `config-dir.ts:17-20`, `config-dir.readers.test.ts:31-35` — describe what the code does after this flow, and each control they name is enforced by a named test.
- AC10: A mutation table is recorded in the flow journal: for every guard added or changed, removing or inverting it turns the suite red for the stated reason, and it is restored. Where a mutation does not go red, either the missing test is added or the control is documented as untested — never claimed.
- AC11: Gates: `bunx tsc --noEmit` clean, full `bun test` green, `keryx health run` PASS, and the real `~/.local/share/keryx` is unchanged by the suite.
