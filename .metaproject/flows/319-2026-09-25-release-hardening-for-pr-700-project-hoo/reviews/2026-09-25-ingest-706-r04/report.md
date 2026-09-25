VERDICT: findings — blocker: 0, major: 1, minor: 0, info: 1

This round checked only whether the round-3 findings are closed. It was run at worktree HEAD 767d0b8f; the fixes are in commits 574eca59 and 767d0b8f. Environment: Bun 1.4.2 on macOS, after `bun run build`. Probes are in scratchpad/f319/adv4.

Every run used `env -i`, with HOME, XDG_DATA_HOME and XDG_CONFIG_HOME set inside adv4, and GIT_CONFIG_GLOBAL=/dev/null. The one exception is the R3-05 probe, which deliberately uses a git-tracked HOME with XDG_DATA_HOME unset.

Invocation forms:
- **a:** `<wt>/dist/cli.js`, run through its shebang.
- **b:** `bun <wt>/src/cli.ts`.
- **bd:** `bun <wt>/dist/cli.js`.

The detector is the round-3 user hooks.json, placed at `adv4/det/.keryx`. It runs an unsandboxed SessionStart hook that does `touch adv4/MARK`. "FIRED" means a value from the repository's dotenv file reached keryx.

**Summary**
- **Closed:** R3-02, R3-03, R3-04 and R3-05, each against the exact round-3 probe plus variants.
- **Mostly closed:** R3-01. Every round-3 case is now stripped: symlinks, a lone CR, unterminated quotes, `export<TAB>` and mixed quotes. Symlink chains, a symlink to /dev/zero and a symlink to a FIFO do not hang, and NUL bytes are handled.
- **New in the same class (R4-01):** the new 16 MiB read cap reopens the bypass. A `.env*` file larger than the cap is skipped entirely. Bun still loads it, so every key in it survives into the "safe" child. This was confirmed end to end in forms b and bd.

```json keryx:findings
[
  {
    "id": "R4-01",
    "reviewer": "adversarial-opus-r4",
    "severity": "major",
    "file": "src/lib/safe-exec.ts",
    "line": 332,
    "title": "A .env* file larger than MAX_DOTENV_READ_BYTES (16 MiB) is skipped by the key scan but still loaded by Bun, so the re-exec guard is again bypassed in the dev/`bun <file>` forms",
    "problem": "collectCwdDotenvKeyNames skips any .env* entry whose stat size exceeds MAX_DOTENV_READ_BYTES (line 332). It does not read the file and contributes no key names. Bun has no such cap and loads the file. The doc comment says the skip 'cannot be used to widen what \"no dotenv here\" means'. For a stripping guard, however, contributing no key names is exactly the unsafe direction: the same principle the R3-01 fix applied to symlinks.",
    "impact": "Same as R3-01. In the bypass forms (`bun src/cli.ts`, `bun dist/cli.js`, `bun node_modules/.bin/keryx`, and the Windows-shim case), a cloned repository can again set any variable keryx reads: KERYX_HOME, KERYX_HOOKS=off, provider base URLs next to the user's exported keys, and so on. It needs no unusual syntax, only a single 16 MiB+ comment line followed by the payload, either as a plain `.env` or through a symlink such as `.env.local -> pad`. Git and GitHub accept files of that size, and diff views collapse them. The shipped shebang form (a) is not affected. BUN_OPTIONS/BUN_CONFIG_* remain stripped by name, so this is not a code-execution path.",
    "detail": "A variant that pads the value instead of a comment (`A=<17 MiB>`) makes the child spawn fail with E2BIG, because the huge value is not stripped from the env. The guard then throws and does not fall through, so that variant fails closed. The comment-padded variant does not fail closed. The cap was added for /dev/zero, but that case is already excluded by `!info.isFile()`: a symlink to /dev/zero or to a FIFO stats as non-regular, and neither hangs. So the size cap protects only against a slow read of a huge regular file, which Bun itself will read anyway.",
    "evidence": "Guard harness (adv4/g.ts), in the form 'Bun loads it / the guard leaves it': `.env.local -> pad`, where pad is a 17 MiB `#xxx…` line followed by KERYX_HOME=det: yes / yes (not stripped). End to end with `printf '/exit\\n' | <cli> shell --provider fake`: case `big` (symlinked .env.local) FIRED in b and bd, and gave no MARK in a. Case `bigplain` (a regular 17 MiB .env) FIRED in b and bd, and gave no MARK in a. As a control, a 2 MiB single line followed by the key is stripped.",
    "suggested_fix": "Do not skip. Either scan any size (the scanner is linear, and Bun reads the whole file anyway), or treat an over-cap or unreadable .env* regular file as a reason to refuse to start. In the refusal case, exit non-zero with the exact safe command (`bun --no-env-file --config=/dev/null …`) instead of re-execing with an incomplete strip list. Apply the same rule to a readFile failure on a file that stat reports as regular (line 334).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/safe-exec.ts:301 MAX_DOTENV_READ_BYTES",
        "src/lib/safe-exec.ts:332 collectCwdDotenvKeyNames size skip",
        "src/lib/safe-exec.ts:333-334 readFile undefined -> continue (same skip-on-failure shape)"
      ],
      "enumeration_method": "Enumerated every `continue` in collectCwdDotenvKeyNames that can drop a file Bun still loads (non-regular, over the cap, read failure). For each, compared bare `bun -e` in the directory (does Bun bind the key?) with the guard harness (does the key survive the re-exec?). The positives were confirmed end to end with the real CLI in forms a, b and bd."
    }
  },
  {
    "id": "R4-02",
    "reviewer": "adversarial-opus-r4",
    "severity": "info",
    "file": "src/commands/hooks.ts",
    "line": 1,
    "title": "`hooks disable/enable <id>` echoes an unknown operator-supplied id raw in the 'Unknown hook id' error",
    "problem": "R3-03's suggestion to have fail() apply terminalSafe to the whole message was not taken. The file-derived messages (validateBeforeWrite, JSON parse error, trust summary) are escaped at their source, but the 'Unknown hook id \"…\"' message interpolates argv unescaped.",
    "impact": "None from repository content: the string is the operator's own argument. It would matter only if an agent or script passed attacker-chosen text as the id.",
    "detail": "`hooks disable \"$(printf 'zz\\033]52;c;…\\007')\"` printed one line containing a raw ESC in both form a and form b.",
    "evidence": "adv4/r3.sh case 'disable unknown-id-with-esc': raw-ESC-lines=1. Every file-derived surface had 0.",
    "suggested_fix": "Optional: apply terminalSafe inside fail() so every sink is covered.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/hooks.ts fail() callers that interpolate argv (Unknown hook id)"
      ],
      "enumeration_method": "Drove hooks disable/enable with an ESC-bearing id on top of the round-3 payload repository."
    }
  }
]
```

## Probes run and outcomes

Each probe below was run in forms b and a unless noted otherwise. The guard-unit probes import `src/lib/safe-exec.ts` directly, so they cover b and bd.

### R3-01: dotenv key scan (closed except for R4-01)

The matrix in `adv4/m.sh` compares what Bun loads with what survives the guard.

**Stripped:**
- **The round-3 exact cases:**
  - lone CR;
  - unterminated `"`, `'` and backtick;
  - `A= "foo`;
  - `export<TAB>`;
  - the mixed `'`/`"` case;
  - `A="x=` (quote containing `=`);
  - symlinked `.env`, `.env.local` and `.env.development`.
- **A 3-link symlink chain.**
- **NUL bytes:**
  - a NUL in the middle of a line;
  - a NUL after the value, where Bun binds `det\u0000`.
- **Quote and line-ending variants:**
  - CRLF inside an unterminated quote;
  - a key after a closing quote on the same line, and after a CR.
- **`export<CR>KEY`.**
- **A 2 MiB single line followed by the key.**
- **A FIFO `.env` alongside a symlinked `.env.local`.** The `.env.local` keys were stripped, and nothing hung.

**Not loaded by Bun** (no bypass possible):
- a symlink to /dev/zero;
- a symlink to a FIFO with no writer;
- a leading NUL;
- escaped-quote variants for `'`, backtick and `"`;
- `exportKEY`.

Neither the guard nor Bun hung on any of these. The whole matrix ran in 2.4 s.

End to end (`adv4/cases/e2e_*`, shell with `--provider fake`):

| Case | a | b | bd |
|---|---|---|---|
| Symlinked `.env.local` | no MARK | no MARK | no MARK |
| Lone CR | no MARK | no MARK | no MARK |
| **Over-cap file (R4-01)** | no MARK | **FIRED** | **FIRED** |

Controls: a KERYX_HOME exported in the real environment FIRED in both a and b, which confirms the detector works.

### R3-02: signal fall-through (closed)

- **Harness (`adv4/g2.ts`):**
  - Sending USR1 to the child gives parent exit 128 with no "PARENT FELL THROUGH".
  - USR2 gives 140, TERM gives 143.
  - WINCH is ignored: the child runs to completion and its exit code 7 is forwarded.
  - The USR1 status is 128 rather than 158. That is cosmetic and not filed.
- **Real CLI (`adv4/sig.sh`, repo `.env` KERYX_HOME=det):**
  - USR1 to the child: exit 128, no MARK, one session banner, in both b and bd.
  - TERM: exit 143, no MARK.
- **New ppid watchdog:** after a SIGKILL of the wrapper, the child exits within 1 s (`adv4/wd.sh`).
- **Error path:** an E2BIG spawn failure throws. It does not fall through into the command.

### R3-03: raw ESC from hooks disable/enable (closed)

`adv4/r3.sh` reran the round-3 payload on every surface listed below, in both a and b. Every surface had raw-ESC-lines=0:
- hooks list, validate, test p1 and trust --yes;
- hooks disable p1, enable p1, and disable --project;
- shell.

The validateBeforeWrite message now shows `\x1b…` as visible escapes.

Variants:
- A JSON parse error from an ESC inside an id string gives 0 raw lines on both disable and list.
- A bad enum or matcher, or a description or argv containing ESC, gives 0 raw lines on disable, enable and trust.
- An operator-supplied unknown id containing ESC echoes it raw (R4-02, info).

### R3-04: invisible code points (closed)

`adv4/ts.ts` tested every round-3 code point, plus U+180E, U+061C, U+200B, U+2060-2064, U+FEFF, tags, the Hangul fillers, U+034F, VS1-16, U+1BCA0, U+13430, U+2028/2029, U+0085, U+00AD, U+009B and U+2066. All are escaped. The only one that passes is U+FFFC, which is a visible So glyph, so this is correct.

A full sweep of U+0000–U+10FFFF against Cc, Cf, Zl, Zp, Default_Ignorable_Code_Point and Variation_Selector found 0 misses. terminalSafe is idempotent. Lone surrogates and private-use characters pass through, which is harmless.

### R3-05: dotfiles-repo trust boundary (closed)

`adv4/r5.sh` used a HOME that is a git work tree, with a project inside it that has `.metaproject` but no `.git`.

- **Before trust:** hooks do not run.
- **`hooks trust --yes`:** succeeds and writes to ~/.local/share/keryx.
- **After trust:** `hooks list` shows trust=trusted, and the SessionStart and SessionEnd hooks both run on `/exit`.
- **No spurious warning:** the "inside this project" warning is absent (warn=0).

Variants, all correct:
- A project with its own `.git` nested under the dotfiles HOME, with the trust store forced inside it: trust is refused.
- A project without `.git`, with XDG_DATA_HOME set to a directory inside the project root: refused.
- A project without `.git`, with KERYX_HOME inside the project: the warning is still emitted.
- cwd set to a project subdirectory: the trusted hooks run.
- Control, a plain HOME and a project with its own git: untrusted, hooks do not run; trusted, hooks run.

### Regressions

- **`printf '/exit\n' | <cli> shell` in a trusted project:** the trusted SessionEnd hook runs, as do the SessionStart hooks, in forms a and b (r5 control and dotfiles cases).
- **serve drain on SIGTERM:** covered by `src/commands/serve.process.test.ts` "AC10 — graceful drain". That test spawns `bun run CLI serve` without the safe flags, so it goes through the wrapper, and expects exit 0 and a released port. It passed locally, together with safe-exec.test.ts and cli-shebang.test.ts: 70 pass, 1 pre-existing skip, 0 fail.
  - A manual run needs a serve config and was not repeated.
  - An orphaned `bun --no-env-file … src/cli.ts serve --port 0` (pid 66996, ppid 1, started 13:03) from an earlier pre-watchdog run is still alive. It predates 767d0b8f and was left untouched.
- **User-exported ANTHROPIC_API_KEY across the dev-form re-exec:**
  - It survives when only `.env.example` and `.env.sample` name it, in the harness and in the real `bun src/cli.ts` child (checked with a `--preload` logger, which also shows that the parent's `--preload` is now kept across the re-exec).
  - When a real `.env` names it, the key is dropped. That is the documented trade-off.
