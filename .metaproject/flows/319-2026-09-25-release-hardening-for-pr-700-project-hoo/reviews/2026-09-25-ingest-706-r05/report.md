VERDICT: findings — blocker: 0, major: 0, minor: 0, info: 3

# Round 5 narrow verification — PR #706, flow 319

Scope: `git diff 767d0b8f..83b8e1bd` in `/Users/Goodea/goodea/keryx-ape-319-rh` (dabf545e: the Bun flags go into schedule units only for a Bun interpreter; 83b8e1bd: R4-01 refuse-to-start with exit 78, R4-02 escaping of unknown hook ids).
Reviewer: adversarial-opus-r5. Probes ran under `scratchpad/f319/adv5` with `env -i`, an isolated HOME/XDG, `GIT_CONFIG_GLOBAL=/dev/null` and a 20 s `alarm` on every run. No background processes were started, and none from adv5 remain. The only matching live process belongs to the parent's `gh pr checks` watch loop. No orphaned `serve` was found from this round.

R4-01 and R4-02 are closed. No bypass was found. The targeted tests pass: safe-exec, trigger/schedule, trigger/install, commands/schedule and commands/hooks give 170 pass, 3 skip and 0 fail.

```json keryx:findings
[
  {
    "id": "R5-01",
    "reviewer": "adversarial-opus-r5",
    "severity": "info",
    "title": "isBunExecPath misses a Bun binary with a non-standard basename when it is not this process's own execPath",
    "impact": "A schedule for a Bun binary named, for example, `bun-1.4.2` or Nix's `.bun-wrapped` gets `[interp, script]` with no safe flags, but only when execPath is passed explicitly and differs from process.execPath. The default path (`resolveKeryxInvocation` uses process.execPath under Bun) is covered by the process.execPath fallback. The runtime guard still strips .env keys on re-exec. Only a project-root bunfig preload would load, in the user's own scheduled project root. That is not untrusted content in the shipped default flow.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/schedule.ts:isBunExecPath",
        "src/trigger/schedule.ts:invocationArgv"
      ],
      "enumeration_method": "narrow probe of the R4 diff"
    },
    "suggested_fix": "none required (info)",
    "evidence": "see report"
  },
  {
    "id": "R5-02",
    "reviewer": "adversarial-opus-r5",
    "severity": "info",
    "title": "A Node binary named `bun` gets the Bun flags and the schedule fails to start",
    "impact": "Confirmed: a `spoof/bun -> node` symlink run with `--no-env-file --config=/dev/null s.js` fails with 'invalid negation because it is not a boolean option'. The schedule is broken but fails closed: nothing runs and no .env or bunfig is loaded. This is not a security issue.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/schedule.ts:isBunExecPath"
      ],
      "enumeration_method": "narrow probe of the R4 diff"
    },
    "suggested_fix": "none required (info)",
    "evidence": "see report"
  },
  {
    "id": "R5-03",
    "reviewer": "adversarial-opus-r5",
    "severity": "info",
    "title": "The refusal wording says 'Move or shrink it' for an unreadable file, and an EACCES .env that Bun also skips still causes a refusal",
    "impact": "Cosmetic and fail-closed. An EACCES `.env` that Bun itself cannot load makes the dev form refuse with exit 78 even though nothing would be bound. The message names the file and the errno, so the user can fix it. There is no security impact.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/safe-exec.ts:refuseToStart",
        "src/lib/safe-exec.ts:collectCwdDotenvKeyNames"
      ],
      "enumeration_method": "narrow probe of the R4 diff"
    },
    "suggested_fix": "none required (info)",
    "evidence": "see report"
  }
]
```

## Probes: dev-form guard (R4-01)

Harness: `probe.ts` imports `ensureSafeBunExec` from the worktree and prints `process.env.PWNED` in the re-exec'd child. Plain `bun probe.ts` runs in each fixture dir. The control `ctl.ts` (plain Bun, no guard) shows whether Bun itself binds PWNED.

| # | Fixture | Bun alone binds PWNED? | Guarded result |
|---|---|---|---|
| 0 | Normal `.env` `PWNED=1` | yes | stripped, exit 0 |
| 1 | Reviewer's 17 MiB `.env` (comment line, then `PWNED=1`) plus `.env.local -> .env` | yes | exit 78, names `.env.local` |
| 1b | `.env.local -> cfg` (17 MiB) | yes | exit 78 |
| 3 | Sparse file, 1 GiB via `truncate`, `PWNED=1` at the head | n/a | exit 78 (bytes read > cap; Bun sees the same size) |
| 4a | Exactly 16,777,216 bytes, key at the head | — | stripped, exit 0 |
| 4b | Same size, key on the last line (no trailing newline) | yes | stripped, exit 0 (the whole file is scanned) |
| 4c | Limit + 1 byte | — | exit 78 |
| 8a | BOM plus `PWNED=1`, padded so a split UTF-8 sequence straddles the limit (16 MiB + 1) | — | exit 78 |
| 8b | BOM in the middle of the file before `PWNED=1` | no (Bun does not bind it) | stripped anyway (over-strip, which is the safe direction) |
| 5a | `.env -> fifo` with no writer | no | no hang, exit 0 (not-regular, nothing to strip) |
| 5b | `.env -> /dev/zero` | n/a | no hang, exit 0 (not-regular) |
| 5c | `.env -> /dev/stdin`, stdin `/dev/null` / pipe / `/dev/fd/0` pipe | no | no hang, exit 0 |
| 5d | `.env -> /dev/stdin`, stdin a regular file containing `PWNED=1` | yes | stripped (fstat follows to a regular file) |
| 5e | `.env -> /dev/stdin`, stdin a regular file of 16 MiB + 1 | — | exit 78 |
| 6 | `.env.local` is a directory, plus a real `.env` | — | `.env` still stripped, exit 0 |
| 7a | `.env` mode 000 | no | exit 78, 'could not be read: EACCES' |
| 7b | `.env.local -> sub/x`, `sub` mode 000 (EACCES on the target's parent) | — | exit 78 |
| 7c | cwd mode 311 (readdir fails, open by name works) | no (Bun does not load it either) | exit 0, nothing to strip, no gap |
| 9 | Real CLI: `bun src/cli.ts --version` in the normal, 17 MiB and EACCES dirs and in the worktree itself | — | 0.2.161 / exit 78 with a helpful message / exit 78 / 0.2.161 |

Case 2, the size race: Bun loads `.env*` before the guard runs, and the guard strips the key names from the bytes it reads itself through one fd. A file that grows after Bun's load only adds names, which over-strips, and anything past the cap refuses. The unsafe direction needs a live local process: it would have to rewrite or shrink the file between Bun's load and the guard's read, and a static cloned repo cannot do that. So the race is outside the threat model, and a local attacker with write access already owns the tree. The file names come from a fixed allowlist (`DOTENV_FILE_NAMES`), so the refusal message cannot carry escape sequences from the repo through a file name.

## Probes: schedule (dabf545e)

`isBunExecPath` / `invocationArgv` run under Bun 1.4.2:
- `/opt/homebrew/bin/node`, `node`, `C:\Program Files\nodejs\node.exe` give `[node, script]` with no flags. Correct.
- `~/.bun/bin/bun`, `bunx`, `C:\...\bun.exe`, `BUN.EXE`, `bun`, `./bun` and `process.execPath` get the flags. Correct: the Windows and relative paths work because the code splits on both separators.
- A `bunx` wrapper counts as Bun (it is the Bun binary under another name). In practice `bunx` is never process.execPath.
- `bun-1.4.2`, `.bun-wrapped` and a trailing-slash path get no flags. See R5-01 (info): the default process.execPath fallback covers these.
- A spoof, `bun -> node`, gets the flags and Node refuses to start. The schedule is broken, but this is not a security issue (R5-02).
- A compiled binary still gives `[binary]`. `isValidRunnerArgv` accepts both shapes, and only its comment changed.

## Probes: R4-02

`bun src/cli.ts hooks test|disable --project|enable --project $'\e]0;PWN\a\e[31mX'` prints `\x1b]0;PWN\x07\x1b[31mX`, with zero raw ESC bytes in the output.
