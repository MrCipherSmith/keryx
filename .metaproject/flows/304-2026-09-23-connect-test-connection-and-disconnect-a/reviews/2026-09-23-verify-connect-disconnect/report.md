# Review — flow 304, /connect test-and-disconnect (PR #673)

A prior review round against PR #673 raised seven findings (two HIGH, one MEDIUM, one LOW/MEDIUM,
three LOW) against the /connect test-connection/disconnect feature and its keryx providers
test|remove CLI counterpart. This round re-verifies every one of the seven against the code and
tests actually on disk in the keryx-prov worktree at head 5d203ec9925f83b60cb93441e09f0f01e871f882,
which is tree-identical to the squash-merge commit e04715a20941f6d527a315be7bcce215670b9648 that
PR #673 merged into main (git diff --stat between the two SHAs is empty). CI was green
(19 checks) at the PR head. All seven findings are confirmed fixed.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "major",
    "file": "src/commands/providers.ts",
    "quote": "oauthEnvKeyFor",
    "problem": "Disconnecting a provider authenticated via a saved OAuth grant removed the grant from auth.json but left the provider's resolved credential sitting in process.env for the rest of the running process, so a later in-process read of that env var (or a later /connect re-listing) could still observe a token that had just been disconnected.",
    "impact": "An operator who disconnected an OAuth-backed provider believing the credential was gone would have it silently keep working for anything reading process.env directly in the same process, and a later /connect listing built from the live environment could still report the provider as connected.",
    "suggested_fix": "On the OAuth-grant branch of the remove path, delete the provider's resolved env var key from process.env (via a shared oauthEnvKeyFor(name) lookup) in addition to removing the grant from auth.json.",
    "evidence": "Pre-fix, the OAuth-grant branch of the remove path called only logoutProvider (the auth.json grant delete) with no corresponding process.env delete, unlike the saved-api-key branch, which already cleared its own env-shaped state.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/providers.ts runProvidersRemove / disconnectProvider (OAuth-grant branch)",
        "src/lib/oauth/grants.ts oauthEnvKeyFor"
      ],
      "enumeration_method": "grants.ts exports exactly one function that maps a provider name to the env var key its OAuth grant resolves through (oauthEnvKeyFor); the provider-remove path in providers.ts is the only site that deletes state for a disconnected OAuth provider - walked it end to end and found the one missing process.env delete."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "major",
    "file": "src/commands/providers.ts",
    "quote": "sharedWith",
    "problem": "zai and zai-coding resolve their credential from the same ZAI_API_KEY saved key. Disconnecting either one removed that single saved key, which silently disconnected the OTHER provider too, with no warning to the operator before or after the action.",
    "impact": "An operator disconnecting zai because they no longer wanted THAT provider would also lose zai-coding without being told, and would only discover it was gone the next time they tried to use it - a surprising, silent side effect of an action that named only one provider.",
    "suggested_fix": "Classify the credential BEFORE confirming, compute every other provider that resolves through the same env key (sharedWith), name them in the confirmation prompt, and name them again in the result line and the --json output.",
    "evidence": "Pre-fix, the remove path resolved and deleted the named provider's credential with no lookup of other providers sharing the same env key, and neither the confirmation prompt nor the result mentioned a second provider being affected.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/providers.ts sharedCredentialWarning / classifyProviderConnection",
        "src/tui/tui-shell.ts onDisconnected handler (row-button confirm/result path)"
      ],
      "enumeration_method": "enumerated every built-in provider pair declared against the same saved-key/env-key in the provider registry (zai/zai-coding is the one pair sharing ZAI_API_KEY today), then traced the CLI remove path and the TUI arm/confirm/result path - both now read and render sharedWith computed from that same classification, so the class of call sites (CLI result, CLI --json, TUI confirmation, TUI result) is fully covered."
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "major",
    "file": "src/commands/providers.ts",
    "quote": "providerByName",
    "problem": "keryx providers remove <unknown-name> printed a success-shaped message and exited 0 for a provider name that did not exist, instead of reporting the name as unrecognised.",
    "impact": "A typo'd or stale provider name in a script or an operator's shell history would report success without touching anything, so a caller checking only the exit code (or a human reading only the first line) would believe a disconnect happened when nothing did - the opposite of keryx providers test, which already validated the name first.",
    "suggested_fix": "Validate the name the same way providers test does - providerByName(name, dir) === undefined - before doing anything else, including before asking for confirmation, and exit 1 with Unknown provider: <name> (or the JSON equivalent).",
    "evidence": "Pre-fix, runProvidersRemove had no name-validation step ahead of the classify/confirm/remove path, unlike runProvidersTest, which already refused an unknown name with Unknown provider: <name> and process.exitCode = 1.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/providers.ts runProvidersRemove (name validation, now first)",
        "src/commands/providers.ts runProvidersTest (the existing sibling check the fix mirrors)"
      ],
      "enumeration_method": "walked every entry point that accepts a free-typed provider name for a destructive action: providers remove <name> is the only one (the /connect row Disconnect button cannot name an unknown provider by construction, since it only ever fires on a listed row) - the CLI path was the sole site missing the validation its sibling providers test already had."
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "armed",
    "problem": "Pressing Esc while a row's Disconnect action was armed (awaiting the disconnect confirmation) closed the WHOLE /connect picker in one keystroke, rather than only cancelling the arm - despite the on-screen hint reading Esc to cancel.",
    "impact": "An operator who armed Disconnect by mistake and pressed Esc to back out, matching the hint text on screen, would instead be dropped out of /connect entirely, losing their place in the row list for no reason connected to what the hint promised.",
    "suggested_fix": "Give Esc a first job: when a row's action is armed, the first Esc clears the arm and keeps the picker open; only a SECOND Esc (with nothing armed) leaves /connect, matching the queue dock's own escape-guard convention.",
    "evidence": "Pre-fix, the picker's Esc handler treated every Esc as leave the picker, including while a row's Disconnect confirmation was armed, so the first Esc after arming closed /connect instead of clearing the arm the hint text described.",
    "confidence": "high"
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "minor",
    "file": "src/cli.ts",
    "quote": "USAGE_BODY",
    "problem": "keryx --help (and bare keryx) did not list the new providers test/providers remove subcommands anywhere in the printed usage, even though they were real, working commands.",
    "impact": "An operator reading keryx --help for the CLI surface of the new feature would not learn it existed from the command that exists specifically to tell them the command surface, and would only find it by reading source or the docs site.",
    "suggested_fix": "Add keryx providers test <name> [--json] and keryx providers remove <name> [--yes] [--json] to the static USAGE_BODY string printHelp prints, and extend the flow-303 pin (the test asserting every subcommand a user should discover is present) to cover them.",
    "evidence": "Pre-fix, USAGE_BODY listed providers list and providers cross-family but not providers test/providers remove, despite both being registered, working CLI commands.",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "minor",
    "file": "src/lib/provider-config.ts",
    "quote": "writeOwnerOnlyFileAtomic",
    "problem": "The credential files a disconnect writes to (auth.json via the shell-config path, and llm-providers.json) were written non-atomically, so a process interrupted mid-write (crash, kill, power loss) could leave a torn, partially-written file behind.",
    "impact": "A torn auth.json or llm-providers.json after an interrupted disconnect could leave the operator's saved credentials in an unparseable or partially-deleted state, turning a routine disconnect into a corrupted config file that has to be repaired or restored by hand.",
    "suggested_fix": "Route every write on these two files through the same owner-only ATOMIC write helper (writeOwnerOnlyFileAtomic: write to a temp file in the same directory, then rename) that other credential-bearing files in the config dir already use.",
    "evidence": "Pre-fix, the provider-config and shell-config write paths wrote credential JSON directly rather than through an atomic temp-file-plus-rename helper, unlike other credential files in the same config directory (e.g. mcp-servers trust/store state) which already used one.",
    "confidence": "medium"
  },
  {
    "id": "F-007",
    "reviewer": "code-reviewer (flow 304, PR #673)",
    "severity": "minor",
    "file": "src/harness/provider/make-provider-disconnect.test.ts",
    "quote": "AC7",
    "problem": "AC7 (disconnecting the provider the current session is using neither switches provider nor interrupts a turn, prints a one-line notice, and removes a keryx-saved key from THIS process's environment) was proven only by a source-text audit, with no behavioural test exercising the actual running-session path.",
    "impact": "A source-text audit shows the code LOOKS right; it does not prove that disconnecting the provider a live session is using actually leaves the running turn alone, actually prints the notice, or actually clears the process env - any of which could regress silently with no test to catch it.",
    "suggested_fix": "Add a behavioural test that starts a session against a provider, disconnects that same provider mid-session, and asserts: the running turn is not interrupted or switched, exactly one notice line naming the provider is printed, and the saved key is gone from process.env for that process.",
    "evidence": "Pre-fix, AC7 had no dedicated test file; the claim that it held was supported only by reading the source, which is the class of unverified claim this flow's own review process exists to close.",
    "confidence": "medium"
  }
]
```

## Coverage

Reviewed: src/commands/providers.ts (CLI providers test/providers remove, shared classify/confirm/remove
logic, sharedWith computation), src/lib/oauth/grants.ts (oauthEnvKeyFor), src/lib/oauth/login.ts
(logoutProvider), src/lib/shell-config.ts and src/lib/provider-config.ts (removeApiKey,
removeCustomCompatProvider, atomic writes), src/lib/config-dir.ts (writeOwnerOnlyFileAtomic),
src/tui/tui-shell.ts and src/tui/connect-provider-buttons.test.ts (/connect row buttons, escape
guard, theme colouring), src/tui/queue-nav.ts (stepConnectNavAction), src/cli.ts and
src/cli.test.ts (USAGE_BODY), src/standard/help-groups.ts, docs/docs/cli-reference.md and
docs/docs/onboarding.md, and src/harness/provider/make-provider-disconnect.test.ts (AC7). Not
reviewed: the rest of the repository, unchanged by this flow.

## Outcome

Seven findings re-verified against the code and tests on disk at head
5d203ec9925f83b60cb93441e09f0f01e871f882 (tree-identical to merge commit
e04715a20941f6d527a315be7bcce215670b9648, git diff --stat empty between the two). All seven are
fixed: bun test on the seven directly relevant files (providers.disconnect.test.ts,
connect-provider-buttons.test.ts, make-provider-disconnect.test.ts, shell-config.test.ts,
provider-config.test.ts, queue-nav.test.ts, cli.test.ts) reports 116 pass / 0 fail; keryx health
run reports PASS (score 94); PR #673 shows CI 18/18 (task reported 19) green and MERGED with
headRefOid 5d203ec9925f83b60cb93441e09f0f01e871f882 and mergeCommit.oid
e04715a20941f6d527a315be7bcce215670b9648. None were dismissed as wont-fix or out of scope.
