VERDICT: findings — blocker: 0, major: 3, minor: 3, info: 1

Reviewed at worktree HEAD 6ade894e (fixes 54367a26 + 18ab7fb2). Bun 1.4.2, macOS. Probes in scratchpad/f319/adv2, each run with `env -i` and HOME, XDG_DATA_HOME, XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL=/dev/null set inside that directory. Form (a) execs `<wt>/dist/cli.js` directly (after `bun run build`; the shebang is present in dist). Form (b) is `bun <wt>/src/cli.ts`. The detector is a user hooks.json outside every probe repo (`adv2/det/.keryx/hooks.json`, an unsandboxed SessionStart `touch MARK`). "LOADED" means an attacker dotenv value for KERYX_HOME reached keryx and the hook ran.

**Summary:** the shipped shebang form holds against every cwd dotenv and bunfig vector I tried, and the compile-time flags work. The runtime guard for the dev and `bun <file>` forms fails in four independent ways, one of which turns a lone `.env` into code execution. Several `bun <cli.js>` child spawns (the `invocationArgv` family) did not get the safe flags, so a shebang-launched keryx still spawns children that load the project's `.env` and preload. Load-failure notices still print raw ESC bytes from attacker property names on a plain `keryx shell`.

```json keryx:findings
[
  {
    "id": "R2-01",
    "reviewer": "adversarial-opus-r2",
    "severity": "major",
    "file": "src/lib/safe-exec.ts",
    "line": 163,
    "title": "Runtime re-exec guard is bypassable four ways; in the dev/`bun <file>` forms a repo still sets KERYX_HOME/KERYX_HOOKS/XDG_DATA_HOME (pre-trusting its own hooks), and a lone .env gets code execution through the guard's own re-exec",
    "problem": "ensureSafeBunExec (a) only acts when `.env` or `bunfig.toml` exists in cwd, but Bun also auto-loads `.env.local`, `.env.development` (loaded with NODE_ENV unset), `.env.production`/`.env.test` (with matching NODE_ENV) on their own; (b) returns immediately when env KERYX_SAFE_EXEC=1, which a `.env` can set; (c) strips a dotenv key only when its parsed value equals process.env exactly, but its parser differs from Bun's (inline `# comment`, `$VAR`/`${VAR}` expansion, backtick quoting, `KEY: value` syntax), so the value survives into the 'safe' child; (d) passes BUN_OPTIONS through, and Bun honours BUN_OPTIONS even under --no-env-file --config=/dev/null, so a `.env` with `BUN_OPTIONS=--preload=./p.js # x` makes the guard's own re-exec run repo code.",
    "impact": "For `bun src/cli.ts` (the documented dev invocation), `bun dist/cli.js`, and `bunx`-style or Windows-shim launches that bypass the shebang (the cli.ts comment names the guard as the only protection on a Windows npm install), a cloned repo can: redirect KERYX_HOME; set KERYX_HOOKS=off, which drops the whole hook runtime including built-in security gates; point XDG_DATA_HOME at a repo-local trust store that pre-trusts its own project hooks, so an untrusted unsandboxed project hook runs; set provider base URLs and keys; or get arbitrary code execution from a single `.env` through BUN_OPTIONS. This is the class 18ab7fb2 claims to close ('never read the working directory's .env').",
    "detail": "Shipped form (a) is not affected: every vector was blocked there. KERYX_HOME redirected INTO the project is still caught by guardUserHomeDir; the demonstrated KERYX_HOME impact uses an outside dir as a detector, and the real-world impacts are KERYX_HOOKS, XDG_DATA_HOME, provider variables and BUN_OPTIONS. The pre-trust key is `<realpath(projectRoot)>::.metaproject/hooks.json`, which is predictable for CI and devcontainer checkouts (/home/runner/work/<r>/<r>, /workspaces/<r>). The marker is redundant: the re-exec'd child already carries the safe flags in execArgv, which hasSafeExecArgv detects.",
    "evidence": "Form b results (form a blocked in every case). `.env.local` only: LOADED. `.env.development` only, with or without NODE_ENV: LOADED. `.env.production` with real NODE_ENV=production: LOADED. `.env.test` with NODE_ENV=test: LOADED. `.env` containing KERYX_SAFE_EXEC=1: LOADED. `.env` `KERYX_HOME=<d> # note`: LOADED. `D=..`+`KERYX_HOME=${D}/det`: LOADED. `$D/det`: LOADED. Backticks: LOADED. `KERYX_HOME: <d>`: LOADED. `.env` `BUN_OPTIONS=--preload=./p.js # opts`: preload executed (PRE created); without the comment it is stripped and nothing runs. `bun -e 1` with BUN_OPTIONS=--preload plus --no-env-file --config=/dev/null still preloads. `.env.local` KERYX_HOOKS=off with real KERYX_HOME=det: user hook did not fire in b, fired in a. Repo T with `.env.local` `XDG_DATA_HOME=./.xdg` and a committed `.xdg/keryx/hooks-trust.json`: an unsandboxed project SessionStart hook ran in b (MARK created) and was refused in a ('not trusted'). `bun dist/cli.js` with `.env.local` only: LOADED.",
    "suggested_fix": "Drop the env marker and rely on hasSafeExecArgv. When execArgv lacks the safe flags, always re-exec, whatever files are in cwd. Build the child env by removing every KEY that appears in ANY `.env*` file in cwd, by key and regardless of value (a real exported variable with the same name is the rare case; warn about it rather than keep the file's value). Also always strip BUN_OPTIONS and NODE_OPTIONS unless they were passed on the real command line. Alternatively, refuse to start with a clear message when run without the safe flags and any `.env*`/bunfig.toml is present. Separately, refuse an XDG_DATA_HOME/config dir inside the project (see R2-04).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/safe-exec.ts:163 (KERYX_SAFE_EXEC marker read from env)",
        "src/lib/safe-exec.ts:177 (guard gated on .env/bunfig.toml presence only)",
        "src/lib/safe-exec.ts:45 parseDotenvText (value-equality strip with a non-Bun parser)",
        "src/lib/safe-exec.ts:ensureSafeBunExec childEnv (BUN_OPTIONS passed through)",
        "src/cli.ts:55 ensureSafeBunExec() call"
      ],
      "enumeration_method": "Read safe-exec.ts end to end. Ran an empirical matrix of every Bun dotenv filename × NODE_ENV source × parser-syntax variant × both invocation forms. Separately verified that BUN_OPTIONS and NODE_OPTIONS are honoured under the safe flags."
    }
  },
  {
    "id": "R2-02",
    "reviewer": "adversarial-opus-r2",
    "severity": "major",
    "file": "src/trigger/schedule.ts",
    "line": 80,
    "title": "invocationArgv spawn family was not given SAFE_BUN_SPAWN_ARGS: TUI run-now and installed schedule units run `bun <dist/cli.js> trigger run …` in the project root, loading its .env and running its bunfig preload even when the parent was launched safely by the shebang",
    "problem": "invocationArgv returns `[process.execPath, scriptPath]`, which is `[bun, …/dist/cli.js]` for an npm install. Its callers (trigger-run-now.ts triggerRunArgv spawning with cwd=opts.root, install.ts execStart for launchd/systemd/cron, schedule.ts renderScheduleLines, whose WorkingDirectory is the project root) never add --no-env-file --config=/dev/null. The child bypasses the shebang, so Bun loads the project's `.env*` and bunfig.toml, and preload runs before the guard can act. The guard cannot stop preload, and for env it has the R2-01 holes.",
    "impact": "Shipped form. A user who runs a trigger from the TUI, or installs a schedule, in a repo that has (or later pulls) a bunfig.toml preload gets repo code executed with no trust prompt, on every scheduled fire for installed units. It needs a user action (run-now or schedule install), so it is not blocker. It contradicts the fix's claim that 'keryx's own child bun processes get the same flags'.",
    "detail": "Covered sites: gdgraph, trigger-dispatch keryxInvocation, acp-run, builtins resolveKeryxArgv, metaproject-tools, debug-watcher. Missed: every consumer of schedule.ts invocationArgv. A compiled binary is unaffected (invocationArgv returns [binary] and the flags are baked in). The KERYX_SAFE_EXEC marker also leaks from a guard-re-exec'd parent into these children and disables their guard (see R2-01).",
    "evidence": "In repo b_pre (bunfig.toml `preload=[\"./p.js\"]`), ran the exact run-now child argv `bun <wt>/dist/cli.js trigger run nosuch` with cwd set to the repo: the preload executed (PRE created). A form (a) shell in the same repo does not preload.",
    "suggested_fix": "Make invocationArgv return `[execPath, ...SAFE_BUN_SPAWN_ARGS, scriptPath]` when scriptPath is defined, so run-now, install and schedule all inherit it. Or better, have one helper that every self-spawn uses, and add a source-level test that greps for `process.execPath`/`invocationArgv` spawns lacking it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/schedule.ts:80 invocationArgv",
        "src/tui/trigger-run-now.ts:85 triggerRunArgv (spawn cwd=opts.root)",
        "src/trigger/install.ts:167/251/267-268 (launchd/systemd/cron ExecStart)",
        "src/trigger/schedule.ts:275 renderScheduleLines"
      ],
      "enumeration_method": "keryx ctx rg for process.execPath|invocationArgv|keryxSelfArgv over non-test src. Cross-checked against the six sites edited in 18ab7fb2. web-worker-runner (bun --eval, cwd=/, env={}) and proxy-worker (Worker thread, not a process) were checked and excluded."
    }
  },
  {
    "id": "R2-03",
    "reviewer": "adversarial-opus-r2",
    "severity": "major",
    "file": "src/harness/hooks/notices.ts",
    "line": 104,
    "title": "Load-failure notice and warning lines are not terminalSafe: schema diagnostics echo attacker JSON property names raw, so ESC/OSC sequences from a cloned repo reach the terminal by default on `keryx shell`, `hooks list` and `hooks validate` (and ACP/serve through the shared formatter)",
    "problem": "formatLoadFailure interpolates diagnostics[0].message unescaped, and the warnings loop pushes w.message unescaped. The validator's messages include the JSON path of the offending key (for example `$.hooks.<attacker key>: Additional property is not allowed`), and an additional-property name is not schema-constrained. The same raw message is printed by `hooks list` and `hooks validate`. terminalSafe was applied only to ids in the trust/untrusted lines.",
    "impact": "Opening `keryx shell` in a hostile clone emits attacker-chosen escape sequences before any user action. The attacker can erase or forge the 'every tool call is refused' line and print fake instructions, and can emit OSC 8 links or OSC 52 clipboard writes on terminals that honour them. Nothing executes (the config fails closed and denies everything), but this is the R1-02 class that 54367a26 says it covers ('the session-start notices'), reached by default.",
    "detail": "notices.ts states it is the single formatter for TUI, readline, ACP, serve and trigger-dispatch, so the ACP chunk and serve stderr carry the same raw bytes (by inspection; only the terminal surfaces were exercised). Also unescaped: the 'changed' branch's id list (ids are schema-constrained today, unlike the untrusted branch, which escapes) and file and project paths (derived from the clone directory name).",
    "evidence": "Repo TS2 hooks.json with the property name `Bad\\u001b[1Aevent` under hooks. `keryx shell --provider fake | cat -v` gave '…$.hooks.Bad^[[1Aevent: Additional property is not allowed. Check it with: keryx hooks validate'. `hooks list` and `hooks validate` show the same raw ^[.",
    "suggested_fix": "Run terminalSafe over the whole formatted line in formatHookLoadNotices (every returned line, including warnings and gate banners), and over diagnostic messages in commands/hooks.ts list/validate output. Better still, escape in the diagnostic builder, where attacker-derived paths are interpolated.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/hooks/notices.ts:104 formatLoadFailure",
        "src/harness/hooks/notices.ts:94 warnings loop (w.message)",
        "src/harness/hooks/notices.ts changed-state id list",
        "src/commands/hooks.ts list/validate diagnostic printing"
      ],
      "enumeration_method": "Read notices.ts fully and traced every interpolated value to its source. Empirically injected ESC through an unconstrained schema key and observed raw output on shell, list and validate."
    }
  },
  {
    "id": "R2-04",
    "reviewer": "adversarial-opus-r2",
    "severity": "minor",
    "file": "src/harness/hooks/trust.ts",
    "line": 58,
    "title": "Trust store / keryx config dir inside the project is not refused (no parity with the KERYX_HOME guard)",
    "problem": "hooksTrustFile resolves `keryxConfigDir()` from XDG_DATA_HOME (honoured on macOS too) with no inside-project check. A repo-local trust store can pre-trust the repo's own hooks for a predictable checkout path. The same directory holds permissions and MCP-trust state.",
    "impact": "Defence in depth only. It is reachable when the environment is attacker-influenced (R2-01 dev form, demonstrated) and not in the shipped form.",
    "detail": "Demonstrated in R2-01 evidence (repo T). guardUserHomeDir protects KERYX_HOME only.",
    "evidence": "Repo T in form b: a trusted state was read from `T/.xdg/keryx/hooks-trust.json` and the project hook ran.",
    "suggested_fix": "Apply the same realpath inside-project refusal to keryxConfigDir-derived trust/permission files when loading hooks trust (fall back to the OS default and warn).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/hooks/trust.ts:58 hooksTrustFile",
        "src/lib/config-dir.ts:keryxConfigDir"
      ],
      "enumeration_method": "keryx ctx rg XDG_DATA_HOME|keryxConfigDir. The trust store path is the one that gates hook execution."
    }
  },
  {
    "id": "R2-05",
    "reviewer": "adversarial-opus-r2",
    "severity": "minor",
    "file": "src/harness/hooks/config.ts",
    "line": 172,
    "title": "KERYX_HOME inside-project check compares against the nearest .metaproject root, so a repo with a nested .metaproject accepts a KERYX_HOME elsewhere in the same repo",
    "problem": "guardUserHomeDir tests containment against input.projectRoot. When keryx runs in `repo/nest/` that has its own `.metaproject`, projectRoot is `repo/nest`, and KERYX_HOME=`repo/.kx` (same clone, attacker-controlled) is accepted as user scope.",
    "impact": "Defence in depth only. It needs env control (R2-01) plus the user working in the nested directory.",
    "detail": "Symlink, case-variant (/…/p vs /…/P), `..`, trailing slash, relative `.kx`, `.` from inside `.kx`, subdirectory cwd, and no-.metaproject git subdirectory were all refused correctly with the warning. Bun realpath canonicalises case on APFS. A KERYX_HOME that is a parent of the project is accepted, which is correct: its .keryx lies outside the project.",
    "evidence": "Form a with real env: KERYX_HOME=P/.kx and cwd P/nest (nested .metaproject): user hook fired, no warning. All other variants: not fired, warning printed.",
    "suggested_fix": "Also test containment against the git toplevel (and the trustRoot/main worktree root), not only the nearest .metaproject root.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/hooks/config.ts:172 guardUserHomeDir"
      ],
      "enumeration_method": "Empirical path-variant matrix against the single guard function."
    }
  },
  {
    "id": "R2-06",
    "reviewer": "adversarial-opus-r2",
    "severity": "minor",
    "file": "src/lib/terminal-safe.ts",
    "line": 27,
    "title": "terminalSafe misses several invisible/format code points; `hooks list` lacks the escaped-characters warning; trust display double-escapes inside quoted tokens",
    "problem": "Not escaped: U+00AD soft hyphen, U+180E, U+2061–U+2064 invisible operators, Hangul fillers U+115F/U+1160/U+3164/U+FFA0 (render as blanks, so one token can look like two), tag block U+E0000–U+E007F, variation selectors U+FE00–U+FE0F, and U+2028/U+2029. `hooks list` escapes but prints no 'contains control or invisible characters' warning, while `hooks trust` does. In the trust display a token with whitespace is escaped and then JSON-quoted, giving `\"echo harmless\\\\x0drm -rf ~\"`, which reads as a literal backslash. A literal `\\x1b` text in a token is also indistinguishable from an escaped ESC.",
    "impact": "Cosmetic and confusion-level. None of these can overwrite or hide existing visible text. CSI, OSC 8, \\r, C1 (0x9b), bidi overrides and ZW space/joiners are all correctly escaped. Fullwidth and lookalike characters pass through, which is acceptable.",
    "detail": "Probed on repo TS: `hooks list` and `hooks trust` (non-TTY) with CSI, OSC 8, \\r, RLO, ZWSP, U+2061, U+00AD, U+180E, tags, U+FE0F, fullwidth, C1 CSI, U+2028/2029 and U+3164/U+115F in argv, cwd, env, matcher and description.",
    "evidence": "`hooks list | cat -v`: `\\x1b[1A`, `\\x0d`, `\\u202e`, `\\u200b`, `\\x9b` escaped. U+2061 shows as M-bM-^AM-!, U+00AD as M-BM--, tags as M-sM- M-^AM-^A (raw). No warning line in list output.",
    "suggested_fix": "Escape Unicode general categories Cc, Cf, Zl, Zp, plus Hangul fillers and variation selectors (or use a \\p{C}|\\p{Zl}|\\p{Zp} regex). Print the tracker warning in `hooks list` too. Escape after quoting, or render tokens as JSON strings uniformly.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/terminal-safe.ts:27 isUnsafeCodePoint",
        "src/commands/hooks.ts renderListText (no escaped warning)",
        "src/harness/hooks/trust.ts describeProjectHookForApproval (quoteArg after terminalSafe)"
      ],
      "enumeration_method": "Empirical code-point sweep over both display surfaces."
    }
  },
  {
    "id": "R2-07",
    "reviewer": "adversarial-opus-r2",
    "severity": "info",
    "file": "src/cli.ts",
    "line": 55,
    "title": "Guard runs after every hoisted static import; dev-form bunfig preload still executes (acknowledged); BusyBox env lacks -S",
    "problem": "ESM hoists all `import` declarations, including those textually after the `if (import.meta.main) ensureSafeBunExec()` block, so every command module evaluates before the guard. The cli.ts comment says the guard runs 'before any command handler this file dispatches to'. That is true for handlers, not for module top-level code. In form b a cwd bunfig preload runs before the guard, and its process.env mutations survive the re-exec (b_pre: hook fired). The code comments acknowledge this.",
    "impact": "Only dev and bypass forms. The shipped shebang form blocks all of it.",
    "detail": "Not a regression. It is recorded so the dev form is not described as protected.",
    "evidence": "b_pre form b: preload=Y and hookfired=Y. Form a: n/n.",
    "suggested_fix": "Document that `bun src/cli.ts` in an untrusted cwd is unsafe, or move command imports behind dynamic import() after the guard.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/cli.ts:55"
      ],
      "enumeration_method": "Source read plus the b_pre probe."
    }
  }
]
```

## Attacks attempted and outcomes

Legend: a = `<wt>/dist/cli.js` executed directly (shebang); b = `bun <wt>/src/cli.ts`.

### 1. Dotenv and bunfig vectors in cwd (detector: KERYX_HOME pointing at an outside user hooks dir)

**Dotenv files:**

| Vector | a | b |
|---|---|---|
| `.env` | blocked | blocked (guard strips it) |
| `.env.local` only | blocked | LOADED (R2-01) |
| `.env.development`, NODE_ENV unset or =development | blocked | LOADED |
| `.env.production`, NODE_ENV unset | blocked | blocked (not loaded by Bun) |
| `.env.production`, real NODE_ENV=production | blocked | LOADED |
| `.env.test`, NODE_ENV=test | blocked | LOADED |
| NODE_ENV=production set via `.env` + `.env.production` | blocked | blocked (the guard reads NODE_ENV the same way) |
| `.env` KERYX_SAFE_EXEC=1 (marker spoof) | blocked | LOADED |

**bunfig and related:**

| Vector | a | b |
|---|---|---|
| bunfig.toml `preload` | blocked | preload runs, and its env mutation survives the re-exec (acknowledged; R2-07) |
| `.bunfig.toml` in cwd | not loaded | not loaded |
| `[run] preload`/`bun=true` | not loaded (applies to `bun run` only) | not loaded |
| `[env]` table | not loaded | not loaded |
| bunfig in a parent dir | not loaded | not loaded (Bun does not search parents) |
| `.env` in a parent dir | not loaded | not loaded |
| `$XDG_CONFIG_HOME/.bunfig.toml` (out of scope) | not loaded | not loaded |

**Other environment and package vectors:**

- BUN_OPTIONS:
  - Honoured by Bun even under the safe flags.
  - Through a `.env` with a parser-mismatching line, the guard's re-exec preloads repo code in b (R2-01).
  - In a, a `.env` is never read.
- NODE_OPTIONS `--require`: ignored by Bun.
- BUN_CONFIG_*, `.npmrc` and the package.json `"bun"` field: install-time only; no effect on running a script by path (not separately exercised).
- Variables that take effect: any variable reaching process.env is honoured. That includes KERYX_HOME, KERYX_HOOKS=off (verified: the hook runtime drops in b), XDG_DATA_HOME (verified: pre-trust in b), and provider base URLs and keys (generic env; not exercised individually). None of them reach a.
- Compiled binary: toy build with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` ignored `.env`, `.env.local` and a bunfig preload. The same build without the flags loaded both. The flags work.
- `bun dist/cli.js` (bypasses the shebang) with `.env.local`: LOADED. Same as b.
- `bunx` and the Windows npm cmd-shim: not exercised. Both rely on the guard, so R2-01 applies whenever they drop the shebang flags.

### 2. Runtime guard

| Attack | Outcome |
|---|---|
| KERYX_SAFE_EXEC=1 in `.env` | Bypassed |
| Inline `# comment` | Bypassed (parser mismatch) |
| `$VAR` expansion | Bypassed |
| `${VAR}` expansion | Bypassed |
| Backtick quoting | Bypassed |
| `KEY: value` syntax | Bypassed |
| Multiline quoted value | Stripped correctly |
| `KEY = 'v' ` (spaces, single quotes) | Stripped correctly |
| Duplicate keys | Stripped correctly |
| `.env` as a symlink | Stripped (readFileSync follows the link) |
| `.env` as a directory + `.env.local` | Guard triggered on existsSync; `.env.local` value stripped |
| bunfig preload | Runs before the guard in b (expected, documented); blocked in a |

### 3. Trust-store redirection

- XDG_DATA_HOME pointing into the repo, with a committed `hooks-trust.json` keyed to the checkout's realpath:
  - b: the untrusted project hook RAN.
  - a: refused.
- No inside-project refusal exists for the trust store (R2-04). Forging an entry needs the checkout realpath, which is predictable for CI and devcontainers.

### 4. KERYX_HOME-inside-project refusal (real env, form a)

- Refused, with a warning:
  - base path;
  - case-variant path;
  - `..` segments;
  - trailing slash;
  - relative `.kx`;
  - `.` from inside `.kx`;
  - a symlink outside the project that points into it;
  - cwd in a subdirectory;
  - a git subdirectory with no `.metaproject`.
- Accepted (bypass): a nested `.metaproject` in a subdirectory, with KERYX_HOME at the outer repo (R2-05).
- A KERYX_HOME that is a parent of the project is accepted, which is correct.

### 5. terminal-safe

| Input | Outcome |
|---|---|
| CSI | Escaped |
| OSC 8 | Escaped |
| `\r` | Escaped |
| C1 0x9b | Escaped |
| RLO/LRI family | Escaped |
| ZWSP/ZWJ | Escaped |
| BOM | Escaped |
| U+00AD, U+180E, U+2061–U+2064, Hangul fillers, tag chars, variation selectors, U+2028/2029 | Not escaped (R2-06) |
| Fullwidth characters | Pass through (acceptable) |

By surface:

- `hooks trust`: escaped, with a warning line.
- `hooks list`: escaped, but no warning line.
- `hooks validate` and `hooks test`: fine for a valid file.
- Session-start notice for untrusted ids: escaped.
- Session-start load-failure line, `hooks list` and `hooks validate` diagnostics: RAW ESC from an attacker property name (R2-03).
- ACP and serve: use the same formatter, so they are affected too (by inspection).

### 6. Child spawn sites

- Carry SAFE_BUN_SPAWN_ARGS:
  - gdgraph;
  - trigger-dispatch;
  - acp-run;
  - builtins resolveKeryxArgv;
  - metaproject-tools;
  - debug-watcher.
- Compiled branches correctly omit the flags.
- Missing the flags: the invocationArgv family (TUI run-now, schedule install, schedule unit lines). The exact child argv runs a repo bunfig preload (R2-02).
- Excluded:
  - web-worker-runner (`bun --eval`, cwd=/, env={});
  - the proxy-worker, which is a Worker thread, not a process.
