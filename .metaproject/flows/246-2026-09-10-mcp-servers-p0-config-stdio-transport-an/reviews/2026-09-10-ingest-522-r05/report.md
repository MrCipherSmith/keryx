# Managed review — PR #522, keryx-mcp-servers P0

Four adversarial reviewers over the branch (security, config/CLI
correctness, lifecycle, test quality), then FOUR rounds of independent
post-fix verification. Fifty-one findings.

## What the rounds actually showed

Round one found 33. Rounds two, three and four then re-checked what had been
marked fixed — and each one found that the previous fix was correct at the
site it was given and wrong one step to the side.

The round-four verifier named the cause, and it is the most useful thing in
this package's review:

> Every fix in this round is correct at the site it was given, and wrong one
> step to the side. The acceptance criterion in use is "does the reported
> reproduction now pass". That criterion cannot converge, because the defect
> being found each round is not a bug — it is the enumeration method.

Three proofs of that on this branch, all self-inflicted:

1. `spawn-env.ts`'s own header records round two's lesson — *"the old test
   asserted the nine names from the report and could not have failed on any
   of the eighteen; what it needed to assert was the CLASS"* — and the very
   next version added four spellings of PASSWORD and missed `SSHPASS`.
2. The `Object.create(null)` fix went onto the one line the report pointed
   at and not onto the four sibling returns in the same function, including
   the one that fires when there is no overlay file — the default state of
   every fresh install.
3. `doctor` closed the reported Ctrl-C with `process.once`, which reopens on
   the second, while the correct spelling already existed in `shell.ts` for
   the same scenario.

F-051 records the method itself as a finding, and the fix for it is three
tests whose unit is not the reported reproduction: a 118-row CLASS table for
the environment filter, a STATE matrix for the overlay reader, and MODULE
invariants (no bare `JSON.parse`, no `process.once` on a signal, repeats
idempotent). Each was mutation-checked.

## Also worth stating

Essentially none of the 51 were found by the author. The suite was green,
all twelve frozen criteria were confirmed with evidence, and the package
still contained a path from `git clone` to arbitrary code execution.

Twelve of them are about the tests rather than the code — guards that could
be walked past with ordinary syntax, assertions that could not fail, and a
schema-parity test that never compared the rules it existed to compare. A
guard that cannot fail is worse than no guard, because it is counted as
coverage.

## Disposition summary

| state | count |
|---|---|
| acted-on | 47 |
| dismissed-out-of-scope | 2 (F-032, F-033 — operator decision, P2) |
| dismissed-deprioritised | 1 (F-031 — P1) |
| dismissed-wont-fix | 1 (F-030 — closed at a better layer) |

Verification: 47 `refuted` (the defect no longer reproduces), 4
`unverifiable` (three deferred, one accepted on a reviewer's trace).
Every `refuted` verdict came from a verifier that is not the finding's
reviewer, and every one of them ran something.

Full suite: 8890 pass, 0 fail. `tsc --noEmit`, `bun run lint` and
`keryx skills verify --bundled` clean, all from source.

## Findings

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "security-reviewer",
    "severity": "blocker",
    "problem": "createMcpRuntime dialled every enabled server in the COMMITTED <project>/.keryx/mcp-servers.json at session start, so `git clone && cd && keryx` executed whatever command the repository's author wrote.",
    "impact": "Arbitrary code execution on the machine of anyone who clones a repository and opens a shell in it \u2014 before the prompt paints, no approval, model and use_tool not involved. No folder-trust mechanism existed anywhere in src/.",
    "suggested_fix": "src/mcp-servers/trust.ts: project servers held at `needs-approval` until `keryx mcp trust`. Keyed by a hash of what is EXECUTED so a later commit revokes it; stored owner-only outside the repository; an unreadable store grants nothing. Recorded as D-14.",
    "evidence": "Reviewer found zero hits for trustProject|projectTrust|isTrustedProject across src/. No test exercised a real spawn from a project file.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "class_scope": {
      "sites": [
        "src/commands/shell.ts TUI createMcpRuntime",
        "src/commands/shell.ts readline createMcpRuntime",
        "src/mcp-servers/runtime.ts startServers"
      ],
      "enumeration_method": "`keryx ctx rg 'createMcpRuntime' src` \u2014 the only two entry points that start servers; both filter through requiresApproval before startServers."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-1 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-002",
    "reviewer": "correctness-reviewer",
    "severity": "blocker",
    "problem": "entryProblems validated the name, command/url exclusivity and two timeouts and nothing else, while expandEntry called .map on args and .replace on every env/headers value.",
    "impact": "A single committed `\"args\": \"oops\"` threw a TypeError out of loadMcpServers, through createMcpRuntime \u2014 documented as never throwing \u2014 and stopped `keryx shell` opening for everyone who checked the repository out.",
    "suggested_fix": "Full type validation in entryProblems for every field expandEntry touches plus every field the schema declares.",
    "evidence": "Reviewer ran it: `createMcpRuntime THREW: entry.args.map is not a function`.",
    "confidence": "high",
    "file": "src/mcp-servers/config.ts",
    "class_scope": {
      "sites": [
        "config.ts expandEntry command",
        "url",
        "args.map",
        "env values",
        "headers values"
      ],
      "enumeration_method": "Every field expandEntry touches, read off the function body."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-003",
    "reviewer": "security-reviewer",
    "severity": "major",
    "problem": "use_tool returns the third-party server's isError verbatim, and both untrusted-content sites in agent.ts were conjoined with !result.isError.",
    "impact": "A server answering {isError:true, content:'<instructions>'} put its prose into provider-bound history with no banner AND without latching untrustedContentSeen, leaving the next shell_exec in the same turn ungated.",
    "suggested_fix": "`untrusted` alone decides. No behaviour change for web_fetch/web_search, which only set the flag on success.",
    "evidence": "agent.ts:1588 and :1595. tools.test.ts asserted only result.untrusted on a fixture hardcoded to isError:false.",
    "confidence": "high",
    "file": "src/commands/agent.ts",
    "class_scope": {
      "sites": [
        "agent.ts history banner",
        "agent.ts untrustedContentSeen latch"
      ],
      "enumeration_method": "Every consumer of the flag / every return carrying server-derived text, read off the source."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-1 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-004",
    "reviewer": "security-reviewer",
    "severity": "major",
    "problem": "search_tool returned server-authored tool descriptions with no untrusted marker, and it is risk:read so it is auto-approved.",
    "impact": "A server could put instructions in a tool description and have the model read them with no prompt and no provenance marker; use_tool never invoked, destructive gate never fired. It also survives the read-only side worker's filter.",
    "suggested_fix": "search_tool output marked untrusted, and both use_tool error paths too.",
    "evidence": "tools.ts returned the hits with no untrusted field; descriptions come verbatim from toToolDescriptors.",
    "confidence": "high",
    "file": "src/mcp-servers/tools.ts",
    "class_scope": {
      "sites": [
        "tools.ts search_tool hits",
        "tools.ts use_tool timeout path",
        "tools.ts use_tool error path"
      ],
      "enumeration_method": "Every consumer of the flag / every return carrying server-derived text, read off the source."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-1 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-005",
    "reviewer": "security-reviewer",
    "severity": "major",
    "problem": "spawn-env.ts reused EXTERNAL_ENV_DENY as a security boundary. That list's own docstring says ANTHROPIC_API_KEY is on it 'to make the SUBSCRIPTION work, not for secrecy'.",
    "impact": "Every third-party MCP server received OPENAI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and SSH_AUTH_SOCK \u2014 a live agent socket, so the server can sign with the operator's keys and push to their repositories.",
    "suggested_fix": "Rewritten three times across three rounds; see F-034 and F-049. Final shape: exact names, two prefix sweeps, whole-word segments, a short glued-substring list, a value scan, and value-dependent entries \u2014 with a 118-row class table replacing the name list as the test.",
    "evidence": "spawn-env.test.ts asserted against EXTERNAL_ENV_DENY itself, vacuous for every name not on it.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "class_scope": {
      "sites": [
        "spawn-env.ts buildMcpChildEnv",
        "commands/mcp-servers.ts defaultConnect",
        "runtime.ts defaultConnect"
      ],
      "enumeration_method": "`keryx ctx rg 'buildMcpChildEnv' src` \u2014 both spawn paths route through the one builder."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-006",
    "reviewer": "correctness-reviewer",
    "severity": "major",
    "problem": "addCommand sliced the POSITIONALS at `--` but read its own FLAGS from the whole argv.",
    "impact": "Four silent wrong results, all exit 0: the server written to the committed project file, an existing server overwritten, a child env var invented, and a failure naming flags nobody typed. addCommand's own doc comment claimed the separator prevented exactly this.",
    "suggested_fix": "splitAtSeparator once; every flag read from the part before `--`. Unknown options refused rather than becoming the server NAME.",
    "evidence": "Reviewer reproduced all four against the real CLI and quoted the resulting JSON.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "class_scope": {
      "sites": [
        "parseScope",
        "optionValue(--transport)",
        "parseEnv",
        "parseHeaders",
        "--force includes",
        "--json includes"
      ],
      "enumeration_method": "Every read of `args` in the module, enumerated by reading it."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-007",
    "reviewer": "correctness-reviewer",
    "severity": "major",
    "problem": "Both shell call sites passed `gitRoot: cwd`, collapsing projectConfigFiles to a single directory, while `keryx mcp list` passes resolveProjectRoot and walks.",
    "impact": "A server at the repository root was listed by the CLI and invisible to a shell started in a subdirectory. Two surfaces, two answers.",
    "suggested_fix": "Both sites pass resolveProjectRoot, and both honour cacheDir so tests stop reading the developer's real config.",
    "evidence": "Reproduced: projectConfigFiles('/repo/a/b','/repo/a/b') returns one path; with '/repo', three.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "class_scope": {
      "sites": [
        "shell.ts TUI createMcpRuntime",
        "shell.ts readline createMcpRuntime"
      ],
      "enumeration_method": "`keryx ctx rg 'createMcpRuntime' src` \u2014 two production call sites."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-008",
    "reviewer": "lifecycle-reviewer",
    "severity": "major",
    "problem": "startServers recorded status:failed with no `connection` when listTools failed after a successful dial, and Promise.race cancels nothing so a timed-out dial orphaned the connection it later produced.",
    "impact": "One resident child process per occurrence, outliving the keryx process, each still holding whatever environment F-005 gave it. The operator is also told `failed` about a server that is running.",
    "suggested_fix": "Close in the catch; withTimeout gained an onAbandoned hook. Superseded by F-038/F-039's transport-level fix.",
    "evidence": "Reviewer's probe recorded 0 closes in both cases. manager.test.ts built the exact fixture and asserted only the status.",
    "confidence": "high",
    "file": "src/mcp-servers/manager.ts",
    "class_scope": {
      "sites": [
        "manager.ts connect+listTools worker",
        "doctor.ts diagnose (already correct)"
      ],
      "enumeration_method": "Both places in the codebase that dial and then list."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-009",
    "reviewer": "test-quality-auditor",
    "severity": "major",
    "problem": "The AC11 SDK-import guard scanned line by line for a line starting with `import` containing the SDK path.",
    "impact": "A multi-line import and `export * from` both walked past it. With the companion test asserting only that `--help` exits 0 on a machine that HAS the SDK, a static dependency could be added to the --help path with both AC11 tests green.",
    "suggested_fix": "Guards read the real module graph via Bun.Transpiler.scan and walk it from cli.ts. Dynamic imports distinguished and allowed.",
    "evidence": "Auditor applied both syntaxes; both survived at 8 pass / 0 fail.",
    "confidence": "high",
    "file": "src/mcp-servers/constraints.test.ts",
    "class_scope": {
      "sites": [
        "constraints.test.ts SDK scan",
        "--help exit-code test",
        "capability import scan"
      ],
      "enumeration_method": "Every text-scanning assertion in the file."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-010",
    "reviewer": "test-quality-auditor",
    "severity": "major",
    "problem": "'The only files the store writes are the two native ones plus the overlay' asserted that three path-builder functions exist.",
    "impact": "An exhaustiveness claim backed by presence checks. A fourth writer to claude_desktop_config.json was invisible, and the foreign-path scan matched contiguous literals only, so a path built with path.join did not trip it.",
    "suggested_fix": "Behavioural: drive every writer against a temp directory and assert the exact set of files that appeared.",
    "evidence": "Auditor added the fourth writer; it survived at 8 pass / 0 fail.",
    "confidence": "high",
    "file": "src/mcp-servers/constraints.test.ts",
    "class_scope": {
      "sites": [
        "constraints.test.ts store-writers test",
        "foreign-path scan"
      ],
      "enumeration_method": "Both assertions in the 'writes no config it does not own' block."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 68f2c19d on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-011",
    "reviewer": "test-quality-auditor",
    "severity": "minor",
    "problem": "Comment-stripping in constraints.test.ts was two regex replaces.",
    "impact": "A `\"/*\"` inside a string literal opened a comment that swallowed the violation after it; `\"a//b\"` deleted the rest of its line. Both verified to survive.",
    "suggested_fix": "A character-walking stripper that tracks string, template and comment state.",
    "evidence": "Auditor's two bypasses each survived while the undisguised control failed.",
    "confidence": "high",
    "file": "src/mcp-servers/constraints.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-012",
    "reviewer": "security-reviewer",
    "severity": "minor",
    "problem": "StdioClientTransport defaults stderr to inherit, giving the child a direct writer to the operator's terminal.",
    "impact": "A server can paint a forged auto-approval line into the running TUI transcript, or flood the screen. No attribution.",
    "suggested_fix": "stderr: 'pipe', drained and discarded so an unread pipe cannot block the child.",
    "evidence": "SDK source uses `stderr ?? 'inherit'`. No test asserted anything about the child's stderr.",
    "confidence": "high",
    "file": "src/mcp-client/client.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-013",
    "reviewer": "security-reviewer",
    "severity": "minor",
    "problem": "describeTarget printed command/args/url AFTER ${VAR} expansion.",
    "impact": "`keryx mcp list` echoed a live token for an ordinary `--token=${GITHUB_TOKEN}`. doctor followed the redaction rule; list followed it nowhere.",
    "suggested_fix": "ResolvedMcpServer carries the raw entry; all human output prints from it.",
    "evidence": "There was no assertion over listCommand's human output.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-1 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-014",
    "reviewer": "security-reviewer",
    "severity": "minor",
    "problem": "classifyToolRisk read inputSchema.annotations; `annotations` is a SIBLING of inputSchema, and toToolDescriptors dropped it.",
    "impact": "No honest server could ever be classified read, and the only way to earn that verdict was to nest the field where the spec says it does not go \u2014 which a hostile server can do. The test encoded the same wrong assumption as the code.",
    "suggested_fix": "annotations carried through descriptor and catalog; classifyToolRisk reads the protocol location.",
    "evidence": "MCP spec types declare annotations beside inputSchema on Tool.",
    "confidence": "high",
    "file": "src/mcp-servers/tools.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-1 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-015",
    "reviewer": "lifecycle-reviewer",
    "severity": "minor",
    "problem": "createMcpRuntime was called before the surface branch, but `keryx shell --chat` never calls makeAgentDeps.",
    "impact": "Every configured server spawned, held for the session, and closed at exit, consulted by nothing.",
    "suggested_fix": "Lazy creation, which also moves it inside the try that closes it.",
    "evidence": "The chat branch builds makeShellDeps with no mcp binding.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-016",
    "reviewer": "lifecycle-reviewer",
    "severity": "minor",
    "problem": "close() awaited every outstanding dial before closing anything.",
    "impact": "Quitting, or the TUI falling through to readline, waited the full startup budget \u2014 unbounded in config, at concurrency 4.",
    "suggested_fix": "Bounded grace, then close what is known; idempotent so the two sweeps cannot double-count.",
    "evidence": "runtime.ts close(): `await settled; await closeServers(states)`.",
    "confidence": "high",
    "file": "src/mcp-servers/runtime.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-017",
    "reviewer": "lifecycle-reviewer",
    "severity": "minor",
    "problem": "SIGINT ran process.exit, which runs no finally, and on a TTY no handler was registered at all.",
    "impact": "Ctrl-C skipped mcpRuntime.close() and left one child per connected server.",
    "suggested_fix": "A handler for both cases that closes first; SIGTERM added later (F-045).",
    "evidence": "shell.ts registered SIGINT only under `if (!process.stdin.isTTY)`.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-018",
    "reviewer": "lifecycle-reviewer",
    "severity": "minor",
    "problem": "reportMcpProblems wrote to stderr about 170 lines before the renderer mounts.",
    "impact": "The alternate screen buffer wipes it, so the operator never saw 'your mcp-servers.json has a trailing comma'.",
    "suggested_fix": "Reported after teardown on the TUI path.",
    "evidence": "shell.ts: reportMcpProblems at runtime creation, renderer mounted much later.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-019",
    "reviewer": "lifecycle-reviewer",
    "severity": "minor",
    "problem": "The two defaultConnect implementations disagreed on cwd.",
    "impact": "A server that resolves relative paths behaved differently under `doctor` than in the shell \u2014 making doctor an unreliable pre-flight for exactly the class it exists to catch.",
    "suggested_fix": "Both use defaultServerCwd.",
    "evidence": "runtime.ts used defaultServerCwd, commands/mcp-servers.ts used process.cwd().",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-020",
    "reviewer": "test-quality-auditor",
    "severity": "minor",
    "problem": "config.schema-parity.test.ts wrapped every case in a fixed document, so no top-level rule was ever compared, and the corpus varied only the four fields entryProblems checked.",
    "impact": "Nine divergences passed under a test written specifically to catch drift, two of which crashed the shell.",
    "suggested_fix": "Widened corpus, a document corpus, a NAME corpus, `propertyNames` implemented in the validator, and remaining disagreements asserted in both directions with the reason.",
    "evidence": "Auditor tabulated nine schema-rejects / runtime-accepts.",
    "confidence": "high",
    "file": "src/mcp-servers/config.schema-parity.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c1cde3c4 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-021",
    "reviewer": "correctness-reviewer",
    "severity": "minor",
    "problem": "`enabled` was never type-checked, and every non-empty string is truthy.",
    "impact": "`\"enabled\": \"false\"` started the server the operator meant to switch off, with no tag and no problem reported.",
    "suggested_fix": "Covered by F-002's type validation with its own regression test.",
    "evidence": "Reviewer: `enabled:\"false\" resolves to: \"false\"  problems: []`.",
    "confidence": "high",
    "file": "src/mcp-servers/config.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c1cde3c4 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-2 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-023",
    "reviewer": "test-quality-auditor",
    "severity": "minor",
    "problem": "The source-inspection guards sliced a flat 2 000 characters from the signature, and one did not check its indexOf.",
    "impact": "Thirty lines of filler pushed a real transport.onmessage tap past the window; a rename would make slice(-1,1999) pass over the file's last character.",
    "suggested_fix": "Brace-matched to the function, plus a precondition test.",
    "evidence": "Auditor's filler bypass survived at 10 pass / 0 fail.",
    "confidence": "high",
    "file": "src/mcp-servers/connection.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-024",
    "reviewer": "test-quality-auditor",
    "severity": "minor",
    "problem": "'Both paths share one tool-call outcome helper' asserted `occurrences >= 3`.",
    "impact": "Monotone the wrong way: it detects deletion and never a path inlining its own copy, which is the drift the test names.",
    "suggested_fix": "Exactly one definition, AND both connect functions reach it.",
    "evidence": "Auditor added a duplicate wrapper and it survived.",
    "confidence": "high",
    "file": "src/mcp-servers/connection.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-025",
    "reviewer": "test-quality-auditor",
    "severity": "minor",
    "problem": "The CLI remove test asserted that the USER config throws on read \u2014 already true at setup.",
    "impact": "Nothing asserted the entry left the project file. Deleting writeDocument from removeServer left it passing.",
    "suggested_fix": "Asserts the entry present before and absent after; the user-scope arm gets its own test.",
    "evidence": "Auditor deleted writeDocument and this test passed.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-022",
    "reviewer": "correctness-reviewer",
    "severity": "minor",
    "problem": "SERVER_NAME_PATTERN allows a leading digit or hyphen; FQN_PATTERN requires a leading letter or underscore, and neither bounded LENGTH.",
    "impact": "`1password` connected and had every tool skipped. And at 56 characters a plausible name loaded with zero problems, reported connected, and dropped every tool whose qualified name exceeded 64 \u2014 with startServers reporting toolCount and not skipped, so a shell showed nothing.",
    "suggested_fix": "Both the leading character and the length refused, at load AND at write.",
    "evidence": "Reviewer: `1password` accept=true, catalog entries=0. Round-2 verifier found the length half.",
    "confidence": "high",
    "file": "src/mcp-servers/config.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c1cde3c4 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-026",
    "reviewer": "test-quality-auditor",
    "severity": "info",
    "problem": "Three further tests could not fail for the reason they name: the concurrency test asserted a constant > 0; the advisory-classification test used a read-classified tool so the interesting branch was unreachable; the project-file mode test read the ambient umask.",
    "impact": "Coverage counted for properties nothing established, and one would fail under `umask 077` for an environmental reason.",
    "suggested_fix": "Peak measured; a destructive tool used; the mode asserted as the umask implies.",
    "evidence": "Auditor: inlining the cap while keeping the export passed.",
    "confidence": "high",
    "file": "src/mcp-servers/manager.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-027",
    "reviewer": "test-quality-auditor",
    "severity": "info",
    "problem": "AC8's live test comments that the failure comes from the operating system and asserts nothing about it.",
    "impact": "The same assertions pass if the bad server hit the startup timeout instead of ENOENT.",
    "suggested_fix": "Asserts the error text.",
    "evidence": "Auditor read the assertions against the comment.",
    "confidence": "high",
    "file": "src/mcp-servers/stdio.live.test.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-028",
    "reviewer": "correctness-reviewer",
    "severity": "info",
    "problem": "clearStickyUserFlag deleted `enabled` from the user entry unconditionally, and setServerEnabled never received a scope.",
    "impact": "A toggle aimed at a PROJECT server destroyed a same-named user preference the operator had hand-written; the overlay masks the loss until the overlay is lost, and setServerEnabled resets a corrupt overlay to {}.",
    "suggested_fix": "Narrowed to contradicting values, then given the SCOPE \u2014 it only touches the user file when the user layer won.",
    "evidence": "Reviewer showed the before/after. Round-2 verifier showed the narrowing left the scope hole open.",
    "confidence": "high",
    "file": "src/mcp-servers/store.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c1cde3c4 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-029",
    "reviewer": "correctness-reviewer",
    "severity": "info",
    "problem": "parseEnv skipped a pair with no `=` and parseHeaders skipped a trailing --header, both silently.",
    "impact": "`-e PATH` exited 0 having written no env; a trailing --header added the server with no headers. For an Authorization header that is a silent auth drop.",
    "suggested_fix": "Both refuse and say why.",
    "evidence": "Reviewer ran both against the real CLI.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 976ae674 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-030",
    "reviewer": "security-reviewer",
    "severity": "info",
    "problem": "addServer checks SERVER_NAME_PATTERN; removeServer and setServerEnabled do not.",
    "impact": "Defence-in-depth gap only. The reviewer traced every escape route and found none reachable.",
    "suggested_fix": "Left at those sites deliberately; the load-time validation added for F-002/F-022 means a failing name cannot reach a resolved config at all.",
    "evidence": "Reviewer enumerated the four escape routes and refuted each.",
    "confidence": "high",
    "file": "src/mcp-servers/store.ts",
    "disposition": {
      "state": "dismissed-wont-fix",
      "evidence": "Accepted with reason. decided-by: flow-246-author on the reviewer's refutation of all four escape routes (the name is a JSON object key and never a path component; removeServer requires the name to exist; setServerEnabled is reachable only via a command that refuses unknown names; the computed-key spread is not __proto__-vulnerable). Load-time validation closes the gap at the layer that matters."
    }
  },
  {
    "id": "F-031",
    "reviewer": "security-reviewer",
    "severity": "info",
    "problem": "The project-scope config write is a plain writeFileSync, not the atomic temp-and-rename the user path uses.",
    "impact": "A concurrent reader can observe a truncated file, and two concurrent adds lose one.",
    "suggested_fix": "Not fixed. Needs an atomic write with default permissions, which config-dir.ts does not offer.",
    "evidence": "Reviewer compared writeDocument's two branches against config-dir.ts.",
    "confidence": "high",
    "file": "src/mcp-servers/store.ts",
    "disposition": {
      "state": "dismissed-deprioritised",
      "evidence": "Deferred to P1, recorded in the report. decided-by: flow-246-author \u2014 the fix needs an atomic writer with default permissions that src/lib/config-dir.ts does not currently provide (writeOwnerOnlyFileAtomic forces 0600, wrong for a committed file), and reaching the failure needs two concurrent keryx invocations against one project file."
    }
  },
  {
    "id": "F-032",
    "reviewer": "security-reviewer",
    "severity": "minor",
    "problem": "use_tool falls through to evaluateShellApproval, so the TUI renders it as a shell command and offers an exact-match 'Always allow'.",
    "impact": "A broken UI invariant plus permission-store pollution: the allow list receives model-controlled text. The reviewer specifically established it is NOT an approval bypass \u2014 evaluateShellApproval gates autoApprove on !destructive and use_tool is unconditionally destructive.",
    "suggested_fix": "Not fixed. Wants P2's per-tool approval renderer.",
    "evidence": "Reviewer traced the fall-through, parseShellExecCommand and suggestShellPatterns, and quoted pickShellApproval's own comment stating the invariant it violates.",
    "confidence": "high",
    "file": "src/tui/tui-shell.ts",
    "disposition": {
      "state": "dismissed-out-of-scope",
      "evidence": "Deferred to P2. decided-by: altsay (operator), 2026-09-10, in the helyx channel \u2014 shown all three options (defer both / fix F-033 now / fix both) with the deferral as the stated recommendation, and answered agreeing to it. The defect is in tui-shell.ts's approval rendering rather than this package, is verified not to be an execution bypass, and wants the per-tool renderer P2's consumer-modal work needs anyway."
    }
  },
  {
    "id": "F-033",
    "reviewer": "security-reviewer",
    "severity": "minor",
    "problem": "The readline approval prompt truncates non-shell_exec tool input at 117 characters, and use_tool's schema does not constrain JSON key order.",
    "impact": "A reassuring `reason` field first shows the operator only the reassuring prefix; the tool name and destructive arguments are past the cut. apply_patch is deliberately rendered untruncated at the same call site for exactly this reason.",
    "suggested_fix": "Not fixed. Wants the same per-tool renderer as F-032.",
    "evidence": "Reviewer quoted shell.ts:1055-1058 against the apply_patch branch and its comment.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "disposition": {
      "state": "dismissed-out-of-scope",
      "evidence": "Deferred to P2 with F-032. decided-by: altsay (operator), 2026-09-10, in the helyx channel \u2014 same question, same answer. Both are approval-rendering defects in the shell surfaces and want one fix together rather than two partial ones."
    }
  },
  {
    "id": "F-034",
    "reviewer": "verifier-round-1",
    "severity": "major",
    "problem": "The first fix for F-005 handled the names in the report and little else: every pattern required an underscore boundary and a bare KEY segment was absent from the alternation.",
    "impact": "EIGHTEEN credentials still reached a real spawned child, read out of `env|sort`: PGPASSWORD, MYSQL_PWD, OPENAI_KEY, SSH_KEY, ANTHROPIC_KEY, AUTHORIZATION, JWT, KUBECONFIG, NETRC, GNUPGHOME, DOCKER_HOST, DATABASE_URL and more. The docstring claimed `_KEY` was matched; it was matched nowhere.",
    "suggested_fix": "Layered rules plus a value scan, and \u2014 the part that matters \u2014 a 118-row class table replacing the reported-name list as the test.",
    "evidence": "Round-1 verifier's real-spawn dump, with GITHUB_TOKEN/OPENAI_API_KEY/SSH_AUTH_SOCK as passing controls so the run was not vacuous.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "class_scope": {
      "sites": [
        "spawn-env.ts SECRET_SEGMENTS",
        "SECRET_SUBSTRING_RE",
        "MCP_ENV_DENY",
        "CREDENTIAL_IN_VALUE_RE",
        "VALUE_DEPENDENT"
      ],
      "enumeration_method": "Every rule in the module, each now carrying a class in spawn-env.table.test.ts with members and a boundary."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c9a63788 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-035",
    "reviewer": "verifier-round-2",
    "severity": "major",
    "problem": "The credential fix over-reached: blanket sweeps of NPM_CONFIG_, AWS_, AZURE_, GCP_, GOOGLE_CLOUD_ and CLOUDSDK_.",
    "impact": "`npm_config_registry` was stripped, so on a machine with a private registry the canonical `npx -y @scope/server` launch silently resolved against the public one. `AWS_REGION` was stripped, so a server given its keys by -e failed with 'you must specify a region' \u2014 the server-looks-broken outcome the module's own header says the design avoids.",
    "suggested_fix": "Both sweeps removed: every credential in those namespaces ends in SECRET/KEY/TOKEN/PASSWORD and the segment rule already had it.",
    "evidence": "Round-2 verifier read the child's environment and listed what a real npx/AWS server loses.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "class_scope": {
      "sites": [
        "MCP_ENV_PREFIX_SWEEPS",
        "SECRET_SEGMENTS SESSION",
        "SECRET_SEGMENTS PRIVATE"
      ],
      "enumeration_method": "Every sweep and broad segment, each now with a `kept` boundary row in the class table."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c9a63788 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-036",
    "reviewer": "verifier-round-1",
    "severity": "major",
    "problem": "`Promise.race` abandons a dial; it does not cancel it. The caller was left with no reference to a process it had started.",
    "impact": "Measured: keryx took 62.3s to exit with one non-handshaking server configured against 0.9s with none, and a SIGINT inside that window exited the parent and ORPHANED the child, reparented to init on all four exit paths tried.",
    "suggested_fix": "The handshake is bounded inside connectStdioMcpServer where the transport is in scope, and the dial takes an AbortSignal that close() fires. Then close() had to AWAIT the kills it starts, because the SDK's close is graceful (stdin.end, 2s, SIGTERM, 2s, SIGKILL) and process.exit was beating the first signal.",
    "evidence": "Round-2 verifier parameterised it: parent alive 0/500/1000ms past close() \u2192 orphan; 1500ms \u2192 none.",
    "confidence": "high",
    "file": "src/mcp-client/client.ts",
    "class_scope": {
      "sites": [
        "client.ts connectStdioMcpServer handshake",
        "runtime.ts close()",
        "commands/mcp-servers.ts doctorCommand",
        "commands/shell.ts SIGINT/SIGTERM"
      ],
      "enumeration_method": "Every place that starts a dial or ends a session, enumerated by following AbortSignal and KILL_GRACE_MS."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit c9a63788 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by verifier-round-3 (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-037",
    "reviewer": "verifier-round-3",
    "severity": "major",
    "problem": "`doctor` registered its signal handlers with `process.once`.",
    "impact": "After the first signal the listener is gone, so a SECOND Ctrl-C took Node's default disposition and killed the parent mid-kill-grace, leaving the child reparented to init. Two seconds of apparent silence is exactly when an operator presses Ctrl-C again. `shell.ts` already used `process.on` for the same scenario.",
    "suggested_fix": "`process.on` with an `exiting` guard, plus a module invariant forbidding `process.once` on a signal anywhere in this code.",
    "evidence": "Round-4 verifier: `kill -INT` twice with a 0.3s gap left a live PID reparented to init; the same double signal to the readline shell did not.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "class_scope": {
      "sites": [
        "commands/mcp-servers.ts doctorCommand",
        "commands/shell.ts readline handlers"
      ],
      "enumeration_method": "Every `process.on|once` with a signal name in this package and its two command files, asserted by invariants.test.ts rather than enumerated by hand."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-038",
    "reviewer": "verifier-round-3",
    "severity": "major",
    "problem": "The null-prototype fix for `__proto__` reached one of `readOverlay`'s five returns.",
    "impact": "The four it missed include the ABSENT-FILE case \u2014 the default state of every fresh install. Measured: six servers marked `\"enabled\": false`, four listed as enabled and dialled, because `overrides[name]` resolved through Object.prototype for `toString`, `constructor` and `hasOwnProperty`. `enabled` then became a function or an object, so `doctor --json` dropped the field or emitted `{}`.",
    "suggested_fix": "One `noOverrides()` helper used by every return, and a state-matrix test that runs the full load once per overlay state.",
    "evidence": "Round-4 verifier ran the real CLI with no overlay file and listed four of six servers as enabled.",
    "confidence": "high",
    "file": "src/mcp-servers/config.ts",
    "class_scope": {
      "sites": [
        "readOverlay absent",
        "unreadable",
        "no-overrides",
        "invalid JSON",
        "success"
      ],
      "enumeration_method": "Every return statement in the function, now each covered by a state in config.overlay-states.test.ts."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-039",
    "reviewer": "verifier-round-3",
    "severity": "major",
    "problem": "`setServerEnabled` was the last bare `JSON.parse` in the module \u2014 in a WRITE path, in a file already importing `parseJsonTolerant` for a different function.",
    "impact": "A BOM'd overlay fell into its catch, which resets the map to `{}` and writes it back. Every other override the operator had set was DESTROYED, and the command reported success. Identical runs without the BOM preserve them.",
    "suggested_fix": "`parseJsonTolerant` there too, and a module invariant that no production file may call bare `JSON.parse`.",
    "evidence": "Round-4 verifier executed it: overlay holding {a:true,b:false} plus a BOM, `mcp disable svc` reports success, overlay afterwards holds only svc.",
    "confidence": "high",
    "file": "src/mcp-servers/store.ts",
    "class_scope": {
      "sites": [
        "config.ts parseConfigFile",
        "config.ts readOverlay",
        "store.ts readForWrite",
        "store.ts setServerEnabled",
        "trust.ts loadTrustStore"
      ],
      "enumeration_method": "Asserted over the whole module by invariants.test.ts rather than enumerated, which is the point."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-040",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`SSHPASS` reached the child. `PASS` was the one password spelling not in the glued-substring rule.",
    "impact": "`sshpass -e` reads it as a plaintext password. This is verbatim the class the module's header names as round two's lesson.",
    "suggested_fix": "`SSHPASS` added, and the class given eleven rows in the table test including its boundary.",
    "evidence": "Round-4 verifier's real-spawn dump.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-041",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`GOOGLE_CLOUD_KEYFILE_JSON`, `GCLOUD_KEYFILE_JSON` and `GCP_SERVICE_ACCOUNT` reached the child.",
    "impact": "These are the gcloud/Terraform service-account key. The docstring justifying removal of the GOOGLE_CLOUD_/CLOUDSDK_ sweeps says every credential in them ends in SECRET, KEY, TOKEN or PASSWORD; `KEYFILE` does not.",
    "suggested_fix": "`KEYFILE`/`PRIVKEY` added to the substring rule and the names to the pointer list.",
    "evidence": "Round-4 verifier's real-spawn dump.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-042",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "Certificate and identity pointers (`AZURE_CLIENT_CERTIFICATE_PATH`, `VAULT_CLIENT_CERT`, `IDENTITY_FILE`, `SSH_IDENTITY_FILE`, \u2026) reached the child.",
    "impact": "Members of a class the file declares with twenty hand-listed members \u2014 found one at a time across three rounds.",
    "suggested_fix": "Added, and the class given twenty-one table rows with a boundary.",
    "evidence": "Round-4 verifier's real-spawn dump.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-043",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`XAUTHORITY` reached the child.",
    "impact": "The X11 magic-cookie file. Read access is keylogging plus screen capture of the operator's entire desktop \u2014 a strictly larger grant than any API key on the list \u2014 and it was missed while GNOME_KEYRING_CONTROL and KDE_FULL_SESSION were caught for exactly that reason.",
    "suggested_fix": "Added to the agent-socket class.",
    "evidence": "Round-4 verifier's real-spawn dump.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-044",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "The value scan required at least one character before the colon and a colon at all.",
    "impact": "`redis://:hunter2@localhost:6379/0` (empty username, the Redis convention) and `https://ghp_deadbeef@github.com/o/r.git` (bare token userinfo, how a token is embedded in a git remote) both walked past. The docstring claimed `://user:pass@` 'is the shape itself and needs no list'; it is three shapes and the regex saw one.",
    "suggested_fix": "Userinfo made optional in both halves.",
    "evidence": "Round-4 verifier's real-spawn dump with both shapes planted.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-045",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`DOCKER_HOST` was stripped unconditionally.",
    "impact": "True for `tcp://` and `ssh://`, false for `unix:///run/user/1000/docker.sock` \u2014 which rootless Docker, Podman, colima and Rancher Desktop all set. A `docker run -i mcp/...` server then fell back to /var/run/docker.sock and died with 'cannot connect to the Docker daemon': the server-looks-broken outcome the header names, for the second time.",
    "suggested_fix": "A VALUE_DEPENDENT rule, and both values as table rows.",
    "evidence": "Round-4 verifier identified it as the same mistake as AWS_REGION one round later.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-046",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`doctor` had no cancellation path: no signal handler and no AbortSignal passed to connectStdioMcpServer.",
    "impact": "It is the command most likely to be interrupted, because it is the one that sits for the whole startup budget \u2014 and Ctrl-C left the child reparented to init.",
    "suggested_fix": "SIGINT and SIGTERM handlers plus the AbortSignal, with the handlers removed afterwards.",
    "evidence": "Round-3 verifier traced doctorCommand's defaultConnect and found no signal argument.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-047",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`shell.ts` registered SIGINT and not SIGTERM.",
    "impact": "`kill <pid>` \u2014 a supervisor, a CI job, a closing terminal \u2014 took the default disposition and left one child per connected server.",
    "suggested_fix": "SIGTERM handled too, exiting 143.",
    "evidence": "Round-3 verifier's cases C and D.",
    "confidence": "high",
    "file": "src/commands/shell.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-048",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`oauth`'s interior was unvalidated \u2014 only 'object or false' was checked.",
    "impact": "Six schema-specified rules unenforced, while the runtime's own comment says the unknown-field allowance 'does not cover a KNOWN one'. Latent while P0 does not dial OAuth, which is the reason to pin it before it does.",
    "suggested_fix": "clientId, clientSecretEnvVar, scopes and callbackPort enforced per schema.",
    "evidence": "Round-3 verifier's differential found all six.",
    "confidence": "high",
    "file": "src/mcp-servers/config.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-049",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "A server named `__proto__` was accepted by both schema and runtime and silently produced nothing.",
    "impact": "`servers[name] = entry` hits Object.prototype's setter instead of creating an own property, so the file loaded with zero problems and zero servers. No pollution, but exactly the load-clean-and-vanish shape this package keeps finding.",
    "suggested_fix": "Null-prototype accumulators in parseConfigFile, readOverlay and readForWrite.",
    "evidence": "Round-3 verifier's differential.",
    "confidence": "high",
    "file": "src/mcp-servers/config.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-050",
    "reviewer": "verifier-round-3",
    "severity": "minor",
    "problem": "`repeatedFlags` was called from addCommand only, and `remove` also takes `--scope`.",
    "impact": "`mcp remove x --scope user --scope project` deleted from the user file without a word \u2014 a silent first-wins on a DELETE.",
    "suggested_fix": "The guard applied to removeCommand too.",
    "evidence": "Round-4 verifier tried it against the real CLI.",
    "confidence": "high",
    "file": "src/commands/mcp-servers.ts",
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  },
  {
    "id": "F-051",
    "reviewer": "verifier-round-3",
    "severity": "major",
    "problem": "The acceptance criterion in use across four rounds was 'does the reported reproduction now pass'.",
    "impact": "That criterion cannot converge. Three independent proofs on this branch: spawn-env.ts's own header states the class lesson and the very next version missed SSHPASS; the Object.create(null) fix went onto the one reported line and not its four siblings; and `process.once` closed the reported Ctrl-C and reopened on the second while the correct spelling already existed in shell.ts. Each round therefore found a neighbour, not a new kind of bug.",
    "suggested_fix": "Three tests whose unit is not the reported reproduction: a 118-row CLASS table for the environment filter (every class carrying unreported members, a boundary, and both values where danger is value-dependent, with meta-assertions that no class may have fewer than three rows or no boundary); a STATE matrix running the full load once per overlay-file state; and MODULE invariants (no bare JSON.parse, no process.once on a signal, repeats idempotent).",
    "evidence": "The judgement is the round-4 verifier's, quoted in the commit and in spawn-env.ts's header.",
    "confidence": "high",
    "file": "src/mcp-servers/spawn-env.table.test.ts",
    "class_scope": {
      "sites": [
        "src/mcp-servers/spawn-env.table.test.ts",
        "src/mcp-servers/config.overlay-states.test.ts",
        "src/mcp-servers/invariants.test.ts"
      ],
      "enumeration_method": "The three enumeration failures the four rounds exhibited, one test each."
    },
    "blocking_merge": true,
    "disposition": {
      "state": "acted-on",
      "evidence": "fixed in commit 6ff3f8a2 on feat/mcp-servers-p0, with a regression test checked against the mutation it prevents; verified by flow-246-author (verdict refuted); full suite 8890 pass / 0 fail"
    }
  }
]
```
