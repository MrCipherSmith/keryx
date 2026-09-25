VERDICT: findings — blocker: 0, major: 1, minor: 4, info: 1

Reviewed at worktree HEAD 6f9f947f (round-2 fixes 499285dd and 6f9f947f). Bun 1.4.2, macOS. Probes are in scratchpad/f319/adv3. Every run used `env -i` with HOME, XDG_DATA_HOME and XDG_CONFIG_HOME inside adv3, GIT_CONFIG_GLOBAL=/dev/null and the GIT_AUTHOR_*/GIT_COMMITTER_* variables set.

Forms:
- a: `<wt>/dist/cli.js`, executed directly after `bun run build`.
- b: `bun <src/cli.ts>`.
- bd: `bun <dist/cli.js>`.
- c: a packed tarball (`npm pack --ignore-scripts` of a temp copy), installed locally and with `-g --prefix`, then run through `bunx`, `bun x`, `npx`, the global bin, `node_modules/.bin/keryx` and `bun node_modules/.bin/keryx`.
- d: schedule units, generated through `installSchedule` with a fake host. Nothing was loaded into launchctl or systemctl.

The detector is a user hooks.json in an outside KERYX_HOME (`adv3/det`) with an unsandboxed SessionStart `touch MARK`. "FIRED" means an attacker dotenv value reached keryx.

**Contamination note.** Partway through, another worker edited the worktree's `src/cli.ts` to `// TEMP-DISABLED-FOR-REGRESSION-CHECK-FLOW-319: await ensureSafeBunExec();` (uncommitted, mtime 13:35). Every form-b result below was therefore re-run against a pristine `git archive 6f9f947f` copy (adv3/head, built separately). The guard-unit probes import `src/lib/safe-exec.ts`, which that edit did not touch. The worker must revert its edit before commit.

**Summary.**
- The shipped shebang form (a) and every packaged launch path (c: bunx, bun x, npx, global bin, `.bin` symlink) held against every vector.
- Keryx child spawns carry the safe flags. Schedule units carry them, and reinstalling rewrites old units idempotently.
- The R2-03 surfaces are sanitised on shell, list, validate, test, trust and ACP.
- The runtime guard for the bypass forms (b, bd, `bun node_modules/.bin/keryx`) is still defeated end to end by a symlinked `.env*` and by several dotenv-syntax mismatches. So "nothing left for a parser mismatch to hide behind" does not hold.
- The guard's signal re-raise can fall through and run the whole command a second time in the unguarded, dotenv-loaded parent.

```json keryx:findings
[
  {
    "id": "R3-01",
    "reviewer": "adversarial-opus-r3",
    "severity": "major",
    "file": "src/lib/safe-exec.ts",
    "line": 210,
    "title": "Re-exec guard still bypassable in the dev/`bun <file>` forms: a symlinked .env* is skipped, and the key-name scanner disagrees with Bun on lone CR, unterminated quotes and `export<TAB>`",
    "problem": "collectCwdDotenvKeyNames lstat()s each .env* entry and skips symlinks (line 210), but Bun follows the symlink and loads it. So `.env.local -> cfg.txt` contributes no key names and every key in it survives into the 'safe' child. collectDotenvKeyNames splits on /\\r?\\n/, while Bun also treats a lone \\r as a line break. It enters 'inside a quoted value' mode on an unterminated opening quote and skips following lines, while Bun parses those lines as new assignments. It recognises `export ` only with a space.",
    "impact": "For `bun src/cli.ts` (the documented dev form), `bun dist/cli.js`, `bun node_modules/.bin/keryx` and the Windows shim case the cli.ts comment says this guard protects, a cloned repo still sets any variable keryx reads: KERYX_HOME, KERYX_HOOKS=off (drops the built-in gates), provider base URLs next to the user's exported API keys, and so on. Code execution through BUN_OPTIONS/BUN_CONFIG_* is closed, because those are stripped by name unconditionally. The XDG_DATA_HOME pre-trust from R2 is closed separately by R2-04. Shipped form a and every packaged launcher are not affected.",
    "detail": "A git clone preserves symlinks, so the symlink variant needs no unusual syntax: `ln -s cfg.txt .env.local`. The R2 version of the guard followed symlinks (R2 evidence: '.env as a symlink: stripped'), so skipping them is a regression inside this PR. The doc comment presents skipping as safe ('contributes no key names'), but for a stripping guard, contributing no key names is the unsafe direction.",
    "evidence": "Guard unit probe (adv3/g.ts, which imports safe-exec and prints the env after the re-exec), in the form 'Bun loads it / the guard leaves it':\n- symlink .env: yes / yes (not stripped).\n- symlink .env.local: yes / yes.\n- symlink .env.development: yes / yes.\n- `A=1\\rKERYX_HOME=..`: yes / yes.\n- `A=\"foo\\nKERYX_HOME=..`: yes / yes. Same for `'` and backtick.\n- `A= \"foo\\n...`: yes / yes.\n- `export\\tKERYX_HOME=..`: yes / yes.\n- `A='x\"\\nKERYX_HOME=..\\nB=\"`: yes / yes.\n- `A=\"x=\\nKERYX_HOME=..`: yes / yes.\nCorrectly stripped: plain `.env*` files, BOM, `KEY: v`, leading tab, NUL, escaped quote, hardlink, a 200k-line file, `.env.development.local`.\nEnd to end on the pristine HEAD copy with `keryx shell --provider fake`: symlink_e2e and cr_e2e FIRED in b and bd, and not in a. Packed tarball with a symlinked `.env.local`: `bun node_modules/.bin/keryx` FIRED; bunx, `bun x`, `bunx --bun`, npx and the global bin did not.",
    "suggested_fix": "Stop parsing. When re-execing, follow symlinks, or treat an unreadable or non-regular `.env*` as 'strip nothing is known', and prefer refusing to start. The robust option is to build the child env from a fresh source rather than subtracting: capture `process.env` before Bun's dotenv load is impossible, so instead refuse to run the bypass forms when any `.env*` (including symlinks) exists in cwd, printing the exact safe command. Alternatively, use Bun's own parser: spawn `bun --env-file=<each file> -e 'print keys'` in an empty env to learn exactly which keys Bun binds, then strip those.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/safe-exec.ts:210 collectCwdDotenvKeyNames (symlink skip)",
        "src/lib/safe-exec.ts:124 collectDotenvKeyNames (split on \\r?\\n)",
        "src/lib/safe-exec.ts:125-130,148-152 openQuote tracking",
        "src/lib/safe-exec.ts:135 `export ` prefix handling"
      ],
      "enumeration_method": "Ran a 30-case matrix (adv3/m1.sh, m2.sh) comparing what Bun itself binds (bare `bun -e` in the dir) against what survives the guard's re-exec. The positives were then confirmed end to end on a pristine HEAD copy in forms b and bd, and through the packed tarball."
    }
  },
  {
    "id": "R3-02",
    "reviewer": "adversarial-opus-r3",
    "severity": "minor",
    "file": "src/lib/safe-exec.ts",
    "line": 382,
    "title": "When the re-exec'd child dies from a signal the parent does not die from (SIGUSR1), the parent resolves and falls through, running the whole command a second time in the unguarded, dotenv-loaded process",
    "problem": "On child exit by signal, ensureSafeBunExec calls deps.kill(pid, signal) and returns, and cli.ts continues into main(). Bun does not terminate on a self-sent SIGUSR1 (it is reserved for the inspector), so the parent survives and executes the command itself, with the cwd `.env` values still in process.env. The code path assumes a re-raise always terminates.",
    "impact": "Bypass forms only. Any SIGUSR1 to the child (for example `kill -USR1`, or anything running under the child such as a hook or tool command signalling its parent) makes the command run twice, and the second run is exactly the unguarded run the guard exists to prevent. Side-effectful commands (trigger run, shell turns) repeat.",
    "detail": "TERM, INT, HUP (also with HUP ignored via trap), QUIT, KILL, USR2, ALRM and ABRT all propagate correctly: exit status 128+n, no fall-through. SIGPIPE is ignored by the child, which exits with its own code. The exit code of a normally exiting child is forwarded exactly (7 -> 7).",
    "evidence": "adv3/g2.ts: SIGUSR1 to the child printed 'PARENT FELL THROUGH to main body, unsafe env KH=/poisoned', exit=0. Real CLI on the pristine HEAD copy (`bun head/src/cli.ts shell --provider fake`, repo `.env` KERYX_HOME=det): kill -USR1 <child> gave MARK=FIRED and 2 'Session' banners. SIGTERM gave MARK=no, 1 session, exit=143.",
    "suggested_fix": "After the re-raise, always call deps.exit(128 + signalNumber) (for example via os.constants.signals) so the parent can never continue. Never let the promise resolve into the caller on the re-exec path. Ideally make ensureSafeBunExec return `never` there.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/safe-exec.ts:373-386 exit handler (re-raise then return)",
        "src/lib/safe-exec.ts:367-372 error handler (resolve before exit)",
        "src/cli.ts:73-75 await ensureSafeBunExec() falls through into main()"
      ],
      "enumeration_method": "Sent each of 11 signals to the child only, both with a minimal harness and with the real CLI, and recorded the parent's exit status and whether the post-guard code ran."
    }
  },
  {
    "id": "R3-03",
    "reviewer": "adversarial-opus-r3",
    "severity": "minor",
    "file": "src/commands/hooks.ts",
    "line": 998,
    "title": "validateBeforeWrite still prints schema diagnostics raw: `hooks disable/enable` on a hostile project hooks.json emits attacker ESC/OSC bytes",
    "problem": "The R2-03 fix sanitised formatHookLoadNotices, printDiagnostics and the warnings loops, but validateBeforeWrite builds `Refusing to write ... result would be invalid: ${d.message}` from validateHookConfigDocument, whose message embeds the attacker-chosen property name, and passes it to fail() unescaped.",
    "impact": "Same class as R2-03. It needs an explicit operator command in the hostile repo (`keryx hooks disable <id>` / `enable <id>`, a natural reaction to a failing project hook), rather than appearing by default. Nothing executes: the write is refused.",
    "detail": "All other surfaces were clean with the same payload (CSI cursor-up and erase-line, OSC 8 link, OSC 52 clipboard). That covers `hooks list`, `hooks validate`, `hooks test`, `hooks trust --yes`, `keryx shell`, ACP (both the stdout JSON-RPC chunk and stderr) and serve (the shared formatter; checked by inspection).",
    "evidence": "adv3/r3.sh on form a: 'hooks disable p1' and 'hooks enable p1' each printed 1 line with raw ^[ in `cat -v`. Every other surface had 0.",
    "suggested_fix": "terminalSafe the joined messages in validateBeforeWrite, or better, have fail() terminalSafe its whole message. Also consider escaping at the diagnostic source, in validateHookConfigDocument, where e.path is interpolated.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/hooks.ts:998 validateBeforeWrite",
        "src/commands/hooks.ts fail() (unsanitised sink for every message)",
        "src/harness/hooks/config.ts:360 validateHookConfigDocument (raw e.path in message)"
      ],
      "enumeration_method": "Searched with keryx ctx rg for every consumer of `.diagnostics`/`d.message`/`w.message` under src, then drove each hooks subcommand, shell and ACP against one payload repo."
    }
  },
  {
    "id": "R3-04",
    "reviewer": "adversarial-opus-r3",
    "severity": "minor",
    "file": "src/lib/terminal-safe.ts",
    "line": 55,
    "title": "terminalSafe is still a hand-picked list; other invisible/format code points pass (variation selectors supplement U+E0100–E01EF, U+206A–206F, U+FFF9–FFFB, U+180B–180F, U+17B4/17B5, U+1D173–1D17A, U+2800)",
    "problem": "R2-06 suggested a category-based rule (\\p{Cf}, \\p{Cc}, Zl, Zp, plus fillers). The fix extended the explicit list instead. It now escapes VS1–16 as a steganography channel, but not VS17–256 (U+E0100–E01EF), which is the larger and more commonly abused block, nor several other Cf code points.",
    "impact": "Cosmetic and confusion-level only, as in R2-06: invisible characters and hidden text in hook ids, argv or descriptions on the trust card. No terminal control.",
    "detail": "Confirmed by reading isUnsafeCodePoint. These were not swept empirically in this round. The `hooks list` warning line now exists, and the trust display escapes once (quoteArg is applied to the raw token before render); both were checked by reading the code.",
    "evidence": "src/lib/terminal-safe.ts isUnsafeCodePoint has no branch for 0xE0100–0xE01EF, 0x206A–0x206F, 0xFFF9–0xFFFB, 0x180B–0x180F, 0x17B4–0x17B5, 0x1D173–0x1D17A or 0x2800.",
    "suggested_fix": "Use `/[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Variation_Selector}\\u115F\\u1160\\u3164\\uFFA0\\u2800]/u` (or the equivalent) instead of the list.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/terminal-safe.ts:55 isUnsafeCodePoint"
      ],
      "enumeration_method": "Compared the explicit list against Unicode general category Cf and the Variation_Selector property."
    }
  },
  {
    "id": "R3-05",
    "reviewer": "adversarial-opus-r3",
    "severity": "minor",
    "file": "src/harness/hooks/trust.ts",
    "line": 97,
    "title": "gitToplevelRoot walks to ANY ancestor .git, so a project without its own .git under a git-tracked $HOME (dotfiles setups) treats the real trust store and ~/.keryx as 'inside the project'",
    "problem": "For a project with no .git of its own, gitToplevelRoot returns the nearest ancestor holding `.git`. When $HOME is a git work tree (a common dotfiles setup), that ancestor is $HOME. The default trust store ~/.local/share/keryx and the default ~/.keryx then both 'resolve inside the project'.",
    "impact": "Fail-closed functional regression. In such a project, loadHooksTrustStore reads {}, so trusted project hooks never run, and `keryx hooks trust` refuses with 'the trust store resolves inside this project'. guardUserHomeDir also emits a spurious 'KERYX_HOME points inside this project' warning (its fallback is os.homedir(), so user hooks still load). The inverse, a bypass, is not possible, because the boundary only widens.",
    "detail": "By inspection. The empirical probe for this case was not run in this round. The git-worktree case (a gitfile `.git`) is handled by existsSync. A trust store placed in a *different* checkout of the same repo (for example the main worktree while running in a linked worktree) is outside the boundary. That is acceptable, since it requires env control (R3-01) plus a known sibling path.",
    "evidence": "trust.ts gitToplevelRoot/trustStoreInsideProject and config.ts gitToplevelRoot/guardUserHomeDir: the boundary is the first ancestor with `.git`, with no stop at the project root or $HOME.",
    "suggested_fix": "Stop the walk at the projectRoot/trustRoot when that directory is a keryx project (.metaproject) without a .git, or never let the boundary be os.homedir() or an ancestor of it. Alternatively, combine the checks: 'inside the git toplevel AND inside or under the projectRoot's repo' (for example require the toplevel to contain the project's .metaproject).",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/harness/hooks/trust.ts:97 gitToplevelRoot",
        "src/harness/hooks/trust.ts:trustStoreInsideProject",
        "src/harness/hooks/config.ts:189 gitToplevelRoot",
        "src/harness/hooks/config.ts:229 guardUserHomeDir"
      ],
      "enumeration_method": "Read both copies of the boundary helpers and the three call sites (load, record and revoke trust)."
    }
  },
  {
    "id": "R3-06",
    "reviewer": "adversarial-opus-r3",
    "severity": "info",
    "file": "src/lib/safe-exec.ts",
    "line": 66,
    "title": "Out-of-scope and operator-side notes: BUN_OPTIONS can place the safe flags in execArgv with dotenv loaded; the re-exec drops the parent's own bun flags; old installed schedule units stay flagless until reinstall; the ratchet is file-granular",
    "problem": "(1) With a real-env `BUN_OPTIONS=\"--no-env-file --config=/dev/null --env-file=.env.local\"`, execArgv shows the safe flags and `.env.local` is loaded. This is operator-controlled, so it is out of scope, as the brief says. (2) The re-exec passes only SAFE_BUN_SPAWN_ARGS, so `bun --inspect src/cli.ts` and `bun --smol ...` lose their flags in the child. The same goes for an operator's own BUN_OPTIONS and NODE_OPTIONS, which the guard strips; that trade-off is documented. (3) Units installed before this fix keep running `bun <cli.js>` in the project root until the operator reinstalls or resumes; nothing prompts them. (4) keryx-child-spawn.ratchet.test.ts only requires the string SAFE_BUN_SPAWN_ARGS to appear somewhere in a file that matches a literal spawn(process.execPath|\"bun\") shape. It misses a new raw spawn in an already-compliant file, `Bun.spawn({cmd:[...]})`, fork(), exec/execSync strings, Bun.$, and a mention that is only in a comment.",
    "impact": "None exploitable by repo content in the shipped form.",
    "detail": "A current sweep found no unprotected self-spawn: gdgraph, debug-watcher, builtins, acp-run, metaproject-tools, trigger-dispatch and invocationArgv consumers all carry the flags. The exceptions are web-worker-runner (`--eval`, cwd=/, env={}) and `bun build` in import-policy, both allowlisted with sound reasons, and testing/service.ts, which runs project tests by design.",
    "evidence": "adv3/g.ts under that BUN_OPTIONS printed execArgv [--no-env-file, --config=/dev/null, --env-file=.env.local] and X=/fromlocal. A hostile repo with a bunfig preload logger: form a init, update and gdgraph build logged nothing; form b logged only the two dev parents (documented R2-07) and no children.",
    "suggested_fix": "Optional. Have hasSafeExecArgv also reject any --env-file/--preload/-r in execArgv. Forward the parent's execArgv minus unsafe flags. Have `keryx schedule list` flag installed units lacking --no-env-file. Make the ratchet per-call (AST) or at least include Bun.spawn({cmd}) and fork.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/safe-exec.ts:66 hasSafeExecArgv",
        "src/lib/safe-exec.ts:346 re-exec argv",
        "src/trigger/install.ts:435 installSchedule (upgrade only on reinstall)",
        "src/lib/keryx-child-spawn.ratchet.test.ts:78 SELF_SPAWN_PATTERNS"
      ],
      "enumeration_method": "Empirical BUN_OPTIONS probe. keryx ctx rg sweep for process.execPath|argv0|argv[0]|argv[1]|fork(|Bun.which(\"bun\")|bunx over non-test src. Read the ratchet source."
    }
  }
]
```

## Attacks attempted and outcomes

Legend:
- a = dist/cli.js via its shebang.
- b = `bun src/cli.ts`, on the pristine HEAD copy.
- bd = `bun dist/cli.js`.
- c = packed tarball.

### 1. R2-01 guard

**Dotenv filenames (plain syntax):**
- `.env.local`, `.env.development` and `.env.development.local` alone: stripped in b.
- Blocked in a.
- Blocked in every c launcher (bunx, `bun x`, `bunx --bun`, `bun --bun x`, npx, global bin, `.bin/keryx`).
- `bun .bin/keryx` (a bypass form) with a plain `.env.local`: stripped.

**Marker spoof:** `KERYX_SAFE_EXEC` is gone, so there is no marker left to spoof.

**Always-stripped variables:** BUN_OPTIONS, NODE_OPTIONS, BUN_CONFIG_* and BUN_INSTALL_* are stripped by name. With the BUN_OPTIONS preload payload hidden behind a CR: no preload ran.

**Symlinked `.env`, `.env.local`, `.env.development`: BYPASS in b and bd (R3-01).**

**Parser evasion:**

| Syntax | Result |
|---|---|
| Lone CR | BYPASS |
| Unterminated `"`, `'` or backtick | BYPASS |
| `A= "foo` | BYPASS |
| `export<TAB>` | BYPASS |
| Mixed-quote cases | BYPASS |
| BOM | stripped |
| `KEY: v` | stripped |
| Leading tab | stripped |
| NUL | stripped |
| Escaped quote | stripped |
| FF, VT, U+2028, U+0085, `;`, NBSP, quoted keys, `export export` | not loaded by Bun |
| Hardlink | stripped |
| 200k-line file | stripped |
| chmod 000 | not loaded by Bun |

**execArgv spoof:** possible only through the operator's real-env BUN_OPTIONS (R3-06, out of scope). Nothing in the repo can alter execArgv.

**Signals (child-only):**
- TERM 143, INT 130, HUP 129 (also with HUP ignored), QUIT 131, KILL 137, USR2 140, ALRM 142, ABRT 134: correct, no fall-through.
- PIPE: ignored by the child.
- A normal exit code is forwarded exactly.
- **USR1: the parent falls through and re-runs the command unguarded (R3-02).**

**TTY:** not exercised on a real pty. With stdio inherited, a cooked-mode Ctrl+C reaches both processes and the parent then forwards a second SIGINT, so the child sees two. keryx shell uses raw mode, so it is likely unaffected. Not verified.

**Double re-exec or loop:** none. The child's execArgv carries the flags, so it returns immediately.

### 2. R2-02

**Child spawns:** a hostile repo with a bunfig preload logger was used.
- Form a, `init` + `gdgraph build`: nothing logged.
- Form b, `gdgraph build` + `shell`: only the two dev parents logged (R2-07); no child logged.
- A sweep of every self-spawn site shows the flags present (R3-06 detail).

**Ratchet test:** reasoned about, not run. It fails on a planted `spawn(process.execPath, [x])` in a new file that lacks the flags. It passes on a planted spawn in an already-compliant file, and on the `Bun.spawn({cmd})`, fork, exec-string and comment-only shapes (R3-06).

**Schedule units (fake host, nothing loaded):**
- launchd plist ProgramArguments: `bun --no-env-file --config=/dev/null cli.js trigger run --schedule nightly`.
- systemd ExecStart: same flags.
- cron line: `'--no-env-file' '--config=/dev/null'`.
- Each flag appears exactly once, including from a pre-fix signed runner.
- A pre-existing flagless unit with the managed header was rewritten, with `upgradedSafeFlags=true`, on all three backends.
- A second install wrote nothing (idempotent).
- The fake command log shows only the expected launchctl/systemctl/crontab calls.

### 3. R2-03

The payload was CSI up and erase-line, OSC 8, and OSC 52 in a schema property name and in an extra hook key.

| Surface | Result |
|---|---|
| `hooks list` | escaped |
| `hooks validate` | escaped |
| `hooks test p1` | escaped |
| `hooks trust --yes` | escaped |
| `keryx shell` | escaped |
| ACP stdout (JSON-RPC agent_message_chunk) | escaped `\x1b` text |
| ACP stderr | escaped `\x1b` text |
| serve | shared formatter (inspection) |
| **`hooks disable p1`, `hooks enable p1`** | **raw ESC (R3-03)** |

### 4. R2-04 and R2-05

Reviewed by inspection this round:
- Realpath through the nearest existing ancestor on both sides.
- The git-toplevel boundary handles a nested `.metaproject`, `/var` vs `/private/var`, APFS case variants and a worktree gitfile.
- The trust store inside the project reads as {} and record/revoke refuse.
- The empirical trust-store probe was not run in this round.

New gap: the boundary widens to an ancestor `.git` (a dotfiles $HOME) for a project without `.git`. This fails closed (R3-05).

### 5. R2-06

- The new code points are escaped.
- `hooks list` prints the warning line.
- The trust display quotes the raw token and then renders, so a token is escaped once.
- Terminal-safe applied twice is a no-op.
- The list still misses several Cf and variation-selector code points (R3-04).

### 6. Regressions

- Built-in hooks and trusted user hooks still load and run (the det hook fires when KERYX_HOME is set for real).
- `keryx shell`, ACP (session/new plus prompt) and `init`/`update`/`gdgraph` start in all forms.
- A `keryx serve` started by another process is running on this machine and was unaffected.
- A user's own exported variables survive the re-exec. Only keys named in a cwd `.env*`, plus the Bun/NODE option variables, are dropped. Observed: the parent's KERYX_HOME was preserved when no `.env` named it (the ctrl case).
- `keryx update` idempotency: not re-verified this round.
