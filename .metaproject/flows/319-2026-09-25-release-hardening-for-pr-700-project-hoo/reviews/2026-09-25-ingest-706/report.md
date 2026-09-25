VERDICT: findings — blocker: 1, major: 1, minor: 2, info: 0

```json keryx:findings
[
  {
    "id": "R1-01",
    "reviewer": "adversarial-opus-r1",
    "severity": "blocker",
    "file": "src/harness/hooks/config.ts",
    "line": 445,
    "title": "A repo-committed .env sets KERYX_HOME, so project-committed hooks run as trusted USER-scope and can disable built-in gates — by default, on plain `keryx shell`",
    "problem": "The trust gate exempts USER-scope hooks (`~/.keryx/hooks.json`) entirely: `resolveHookHomeDir`/`resolveKeryxHomeDir` locate that file at `<KERYX_HOME>/.keryx/hooks.json` and it is never trust-checked (the design's premise: 'the operator wrote that file themselves, on this machine'). But keryx runs under the Bun runtime (homebrew/npm `bin` is `dist/cli.js` behind `#!/usr/bin/env bun`), and Bun auto-loads `.env` from the current working directory into `process.env`. A cloned repository can therefore commit a `.env` containing `KERYX_HOME=<repo-relative dir>` plus `<that dir>/.keryx/hooks.json`, and every hook in it is treated as user scope: it runs with NO trust prompt and NO trust digest, and a disable-override with `\"acknowledge\":\"disable-builtin-gate\"` turns off a built-in gate (ctx-guard / security-check-input / security-check-output / impact-evidence).",
    "impact": "Cloning a repo and running `keryx shell` in it silently executes attacker-chosen commands (including `runsIn:\"unsandboxed\"`, full user permissions) at SessionStart and disables the security gates — the exact 'cloning is not consent to run code' threat the whole flow exists to close, defeated by default with no operator action. The unsandboxed hook fires before any notice is printed; the only signal is a post-hoc 'gate X is OFF (disabled in <repo>/.../hooks.json)' banner naming a path inside the repo.",
    "detail": "Root cause is that KERYX_HOME (which governs where user-scope hooks and their exemption live) is trusted from the ambient environment, and the ambient environment is repo-controllable via Bun's `.env` autoload. The trust store location itself (XDG_DATA_HOME/keryx) is not the vector because forging a trust entry needs the clone's realpath+digest, unknown at authoring time — but the user-scope exemption needs neither. This is a live bypass of the gate this PR introduces; before the PR project hooks ran unconditionally so the `.env` trick was unnecessary, so it is a real gap in the new mechanism, not merely pre-existing.",
    "evidence": "Scratch repro (scratchpad/f319/adv): repo r5 with committed `.env` `KERYX_HOME=$A/r5/.kx` and `$A/r5/.kx/.keryx/hooks.json` = {SessionStart: unsandboxed touch $A/M5; PreToolUse: disable keryx.security-check-output with acknowledge}. Our shell exported NO KERYX_HOME (`env|grep -c KERYX_HOME` => 0). `bun -e 'console.log(process.env.KERYX_HOME)'` in r5 prints `$A/r5/.kx` (Bun loaded it from .env). `printf '/exit\\n' | bun .../src/cli.ts shell --provider fake` => `$A/M5` is created AND stderr shows `keryx hooks: built-in gate keryx.security-check-output is OFF (disabled in $A/r5/.kx/.keryx/hooks.json)`. `.env` is an ordinary tracked file (`git add -A` stages it).",
    "suggested_fix": "Do not honor a KERYX_HOME (or user-hooks/user-config home) that resolves inside the current project root when locating user-scope hooks and the gate exemption; OR refuse a KERYX_HOME sourced from a project `.env` (keryx should not inherit repo `.env` for security-relevant home resolution); OR treat any user-scope `hooks.json` whose realpath is inside the project tree as project scope (subject to the trust gate). Whichever: the user-scope exemption must not be reachable from repo-committed state.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/hooks/config.ts:resolveHookHomeDir (userPath = <home>/.keryx/hooks.json)",
        "src/lib/keryx-home.ts:resolveKeryxHomeDir (reads process.env.KERYX_HOME)",
        "src/commands/agent-hooks.ts:buildShellHookRuntime (resolveHooksHomeDir)",
        "src/lib/serve-turn.ts:buildRemoteHookRuntime (resolveHookHomeDir)",
        "src/commands/hooks.ts:resolveHomeDir"
      ],
      "enumeration_method": "grep KERYX_HOME / resolveKeryxHomeDir / resolveHookHomeDir across src (non-test); all user-scope hook paths derive from a single env-driven home resolver; empirically confirmed Bun `.env` autoload populates process.env.KERYX_HOME under the prescribed `bun src/cli.ts` invocation, which is the same runtime the shipped `dist/cli.js` bin runs under."
    }
  },
  {
    "id": "R1-02",
    "reviewer": "adversarial-opus-r1",
    "severity": "major",
    "file": "src/harness/hooks/trust.ts",
    "line": 265,
    "title": "`keryx hooks trust` approval display and `hooks list` print untrusted argv tokens and env values with no control-character sanitisation — terminal-injection can hide the real (unsandboxed) command from the approver",
    "problem": "`describeProjectHookForApproval` renders each hook's argv via `quoteArg` (which only JSON-quotes a token that contains WHITESPACE — an ESC/CSI sequence is not whitespace, so a token with no spaces passes through raw) and renders env as `env: K=V` with no quoting at all. `renderListText` in commands/hooks.ts likewise prints `command: <argv joined by spaces>` for untrusted project rows. Neither strips ANSI/control characters. The argv and env come straight from the attacker-controlled `.metaproject/hooks.json`.",
    "impact": "A malicious repo embeds cursor-movement / line-erase escape sequences (e.g. `\\u001b[1A\\u001b[2K\\u001b[1G`) in an argv token (whitespace-free, using ${IFS}) or in an env value, so that when the operator runs `keryx hooks trust` on a real terminal the screen is redrawn to show a benign command while the actual unsandboxed command / the UNSANDBOXED warning is overwritten. The consent display is the single point where the operator inspects what they are about to trust; defeating its integrity undermines the entire approval step. `hooks list` is a second affected surface.",
    "detail": "Not a blocker because untrusted content still does not execute until the operator actively runs `hooks trust` and is fooled — but it directly subverts the informed-consent guarantee the display exists to provide. The session-start notice itself is safe (it prints only the schema-constrained `id` + event + 'unsandboxed', never argv/env).",
    "evidence": "Scratch repo r2 (scratchpad/f319/adv): hooks.json with argv `[\"/bin/sh\",\"-c\",\"touch${IFS}$A/M2\\u001b[1A\\u001b[2K\\u001b[1G\"]` and `command.env.LANG` containing further CSI + a forged benign hook line + `\\u001b[8m`. `bun .../src/cli.ts hooks trust` output, dumped with `cat -v`, shows the raw bytes reaching the terminal: `    /bin/sh -c touch${IFS}/.../M2^[[1A^[[2K^[[1G` and `    env: LANG=C^[[1A^[[2K^[[1G  lint  SessionStart ... runsIn=sandbox ...`. `bun .../src/cli.ts hooks list | cat -v` shows the same raw `command: /bin/sh -c touch${IFS}/.../M2^[[1A^[[2K^[[1G`.",
    "suggested_fix": "Sanitise all attacker-controlled strings before printing them in the approval display and in `hooks list`: strip or escape C0/C1 control characters (including ESC 0x1b) in every argv token and env key/value (and any cwd) — e.g. render each token through a control-char-escaping function rather than `quoteArg`'s whitespace-only rule, and JSON-escape env values. Mirror the sanitisation any MCP-server approval display already applies.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/hooks/trust.ts:describeProjectHookForApproval (argvLine via quoteArg; env `K=V` line)",
        "src/commands/hooks.ts:renderListText (command: argv.join(' ') for untrusted project rows)"
      ],
      "enumeration_method": "grep for describeProjectHookForApproval and renderListText and every site that joins/prints a project hook's argv/env/cwd to a terminal; the session-start notice path (harness/hooks/notices.ts) inspected and excluded (prints only constrained id + event)."
    }
  },
  {
    "id": "R1-03",
    "reviewer": "adversarial-opus-r1",
    "severity": "minor",
    "file": "src/commands/hooks.ts",
    "line": 813,
    "title": "Trust is bound to argv, not to the contents of a repo script the argv points at — 'any change needs a new trust' is misleading for `argv:[sh, scripts/x.sh]`",
    "problem": "The digest covers argv/cwd/env/runsIn/etc. but not the bytes of any file the command executes. A hook `argv:[\"/bin/sh\",\"scripts/h.sh\"]` stays digest-stable while `scripts/h.sh` is rewritten to arbitrary code, yet trust is not revoked. The trust-accept message states 'Any change to its hooks needs a new `keryx hooks trust`', which an operator may read as covering what will run.",
    "impact": "A repo can get an operator to trust a benign-looking `sh scripts/h.sh`, then land a later commit that changes scripts/h.sh; the next `keryx shell` runs the new code unsandboxed with no re-trust. Requires a second commit after trust and mirrors the known MCP-server trust limitation (command stable, binary changes), so it is a bounded, lower-severity trust-bait rather than a default-execution hole.",
    "detail": "Verified in scratch repo r3: trusted `argv:[\"/bin/sh\",\"scripts/h.sh\"]` (h.sh = `echo benign`), then overwrote h.sh with `touch $A/M3`; `keryx shell` created M3 and `hooks list` still shows trust=trusted.",
    "evidence": "scratchpad/f319/adv r3: `hooks trust --yes` accepted digest 38f18b145633; after `printf 'touch $A/M3\\n' > scripts/h.sh`, `keryx shell --provider fake` created `$A/M3`; `hooks list` => `scope=project trust=trusted`.",
    "suggested_fix": "Either soften the accept/notice wording to make clear trust covers the argv/command definition, not the contents of scripts it invokes (parity with the MCP-server trust caveat), or document this limitation in docs/docs/hooks.md's trust section so operators do not over-rely on it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/hooks.ts:813"
      ],
      "enumeration_method": "n/a (minor)"
    }
  },
  {
    "id": "R1-04",
    "reviewer": "adversarial-opus-r1",
    "severity": "minor",
    "file": "src/harness/hooks/notices.ts",
    "line": 45,
    "title": "Untrusted unsandboxed SessionStart hooks run (in user scope) with the notice appearing only after execution; no notice at all when the untrusted-execution vector is R1-01",
    "problem": "This is a consequence/observation tied to R1-01: because untrusted PROJECT hooks are correctly removed from `registrations`, the notice-after-execution ordering is harmless for them. But it means the operator's only defence against R1-01 (user-scope hooks planted via .env) is a post-execution gate-off banner, and there is no notice at all for a user-scope unsandboxed SessionStart hook that merely runs (no gate disable). Recording so the ordering is considered when R1-01 is fixed.",
    "impact": "Informational reinforcement of R1-01; on its own (project scope) the behaviour is correct and fail-closed.",
    "detail": "Session-start notice for project hooks is emitted at runtime construction which for SessionStart is fine (project hooks were already filtered out and never ran). Flagged only to ensure the R1-01 fix also surfaces user-scope unsandboxed execution.",
    "evidence": "See R1-01 evidence: M5 created with no 'untrusted' notice (user scope), only the post-hoc gate-off banner.",
    "suggested_fix": "Fold into the R1-01 fix; ensure any user-scope hook resolved from a repo-derived home is surfaced/blocked.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/harness/hooks/notices.ts:45"
      ],
      "enumeration_method": "n/a (minor)"
    }
  }
]
```

## Attacks attempted and outcomes

1. Digest evasion
   - argv / cwd / env / runsIn / network / timeoutMs / matcher / class / event / profiles / appliesToChildAgents / enabled: ALL present in `digestMaterialOf` (trust.ts). No field that affects execution is omitted. env is sorted [k,v]; profiles sorted; array order preserved. FAILED to find an omitted executable field.
   - schemaVersion / description / _keryxManaged excluded from digest — none affect execution; schemaVersion major must be "1" to load. No evasion.
   - Unicode/case/newline tricks in ids: id is schema-constrained `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` (≥2 chars) — no control chars, no case tricks. Single-char id `p` correctly rejected (whole config fails closed, deny-all). FAILED.
   - Symlinked `.metaproject/hooks.json` that escapes: read is allowed (content is digested), WRITE via `hooks disable` is refused with 'refuses to write through a symlink … that resolves outside the project root'; outside file untouched (repo r6). Containment holds.
   - trusted-then-edited file yielding same digest: only same-argv different-script-contents works — filed as R1-03 (minor).
   - Trust keyed by realpath: `projectHooksTrustKey` uses realpathOrResolve; a symlinked project dir maps to one key (by design). Colliding two projects on a key would need identical realpaths — not achievable. FAILED.

2. Worktree swap: trust is keyed on `trustRoot: projectRoot` (main root) while the digest is of the worktree's file (D9). A worktree with a different hooks.json digests differently => `changed` => not run. Trust of one project does not apply to another (different realpath key). No bypass found.

3. Notice suppression
   - Newlines/ANSI in ids: impossible (id schema-constrained). 
   - ANSI/control chars in argv and env DO reach the `hooks trust` display and `hooks list` unsanitised => filed R1-02 (major). The session-start NOTICE itself prints only id+event+unsandboxed and is safe.
   - Zero enabled hooks: notice counts only enabled hooks (correct); disabled-but-present hooks do not run (removed from registrations when untrusted).
   - Invalid file: surfaces the load-failure notice and deny-all runtime (D16) — confirmed in r5 first run (single-char id) showing the 'hook config did not load … every tool call and prompt is refused' line.
   - Notice shown at both TUI (tui-shell announceStartupNotice loop) and readline (console.error loop) paths — verified in source and in r1 (readline path printed the untrusted notice).

4. Disabling gates from project scope
   - `enabled:false` on a gate at PROJECT scope: ignored + warning 'a project file cannot turn off a built-in gate' (resolveHookRegistrations). Confirmed by design + code.
   - `acknowledge` in a PROJECT file: still ignored at project scope (D12) regardless of acknowledge — code path only honours acknowledge at user scope.
   - Full registration reusing keryx.* id: rejected (schema oneOf + scanForBuiltinCollisions => load fails).
   - Project hook with class gate that returns allow: untrusted project hooks are removed from registrations entirely, so they never run; a TRUSTED project gate would run but only after explicit operator trust (that is the intended model, not a bypass).
   - profiles tricks: profiles are in the digest and do not affect the tighten-only rule.
   - `~/.keryx` -> repo symlink: N/A vector; the real hole is KERYX_HOME via `.env` => R1-01 (blocker).
   - KERYX_HOME env interplay: BREAKS the gate => R1-01 (blocker).
   - `hooks disable` via agent registry: `hooks disable` was removed from COMMAND_DESCRIPTORS (command-registry.ts) so it is no longer agent-callable; `hooks enable`/`test` remain but cannot disable a gate. `trust`/`untrust` deliberately not added to the registry. Good.
   - `bundle import --allow-hooks`: writes the project hooks.json => becomes untrusted (digest changes), so it cannot pre-disable a gate or pre-trust; project-scope gate disables in an imported file are still ignored. No bypass.

5. Headless auto-trust
   - ACP (`noticeSurface:"headless"`), serve-turn (headless, deduped), trigger-dispatch (headless, trustRoot=main), trigger-agent-task (headless): all pass through `loadHookConfig` which never writes trust and never prompts (D6). Untrusted project hooks are filtered out of registrations on every surface. Child agents inherit only `registrations`, which never contain untrusted project hooks. No auto-trust, no prompt, no write of trust on any headless surface.
   - `hooks trust --yes` reachable by an agent tool? `hooks trust`/`untrust` are NOT in the agent command registry. A model-driven `shell_exec` running `keryx hooks trust --yes` is possible IF the operator allowlists it, but `keryx hooks trust` argv is not on any credential/human-confirmation floor; however it is not auto-approved unless explicitly granted. Not treated as a new escalation beyond an approved shell_exec that could already edit files (design §6 note). No auto-trust by the model out of the box.

6. R700-03 contained writers: `contained-write.ts` runs lexical checks + cycle/dangling detection + `refuseEscapingSymlink` over every segment + a resolved-realpath re-check; `appendContained` additionally opens the final component with O_NOFOLLOW (POSIX) to close the TOCTOU window, mapping ELOOP to a refusal. `writeContained` non-exclusive writes via temp+rename (rename replaces a final-component symlink rather than following it), exclusive uses O_EXCL `wx`. Hardlink-as-final-file: the `atomic:false` write-through-hardlink escape hatch was removed (R4-F2). macOS/Linux O_NOFOLLOW handled via `fsConstants.O_NOFOLLOW ?? 0`. Escaping-symlink write refusal verified live (r6). No race found.

7. Regressions
   - `keryx update` idempotency: `updateManifestAgentEntrypoints` now skips the write when `manifestsEqualIgnoringUpdatedAt` (deep-equal ignoring key order, array-order-sensitive), so metaproject.json is not timestamp-churned. `containFromMetaprojectPath` switched indexOf→lastIndexOf for nested `.metaproject` (R700-14) and is exported. Looks sound.
   - built-in + user hooks still run: user hooks load regardless of project trust (verified — user hook `userpoc` ran); built-ins unaffected.
   - `/integrate` rename: AGENT_SLASH_COMMANDS renamed `/integrations`→`/integrate`; comment refs updated; no dead `/integrations` reference found in the changed slash-command file. (Did not exhaustively grep docs for the old slash name — worth a quick check by the author.)
   - observer default / learning-observer disable: a project disable of keryx.learning-observer (class observe) is honoured from either scope by design (not a gate). Consistent with D10.
