# Managed review round — flow 248, PR #527 (`feat/mcp-servers-p2`)

The `/mcp` consumer view, and the approval rendering `use_tool` never
had (F-032, F-033, deferred from P0 by operator decision).

Two reviewers ran in parallel against the branch diff, both with a
shell this time — the previous round's reviewers had no Bash, so
`keryx ctx rg` was unavailable to them and they worked by reading whole
files. That was a dispatch error, and worth noting that they still found
the SSE credential leak by reading the SDK's source directly.

## Round shape

| Dimension | Findings | Confirmed | Refuted after fix |
|---|---|---|---|
| Security | 3 | 3 | 3 |
| Correctness | 1 | 1 | 1 |
| Test quality | 2 | 2 | 2 |

Every finding was reproduced by the author before being fixed and
re-measured after, and the two blockers were measured in both
directions.

## The finding that matters most

**F-056.** The test proving `use_tool` never reaches
`evaluateShellApproval` compared the character offsets of two string
literals in the files' source text. No production code ran. So the
approval DECISION — the gate before a third party's code executes — had
no coverage at all, and the reviewer demonstrated it: inverting
`if (!approved)`, so that typing `y` denies and anything else approves
and runs, left the full 9 158-test suite green.

That is the fourth time this repository has caught itself asserting that
a SENTENCE appears rather than that a property holds. The previous
extraction on this same branch moved the line BUILDING behind a harness
and left the decision exactly where it was, which is the same defect one
level down: correct at the site it was given.

The same question asked of the other three approval branches
(`apply_patch`, the Codex elicitation, `shell_exec`) returns the same
answer. They are a larger hole than this one — `apply_patch` writes
files, `shell_exec` runs commands — and they are not MCP, so by operator
decision of 2026-09-11 they get a flow of their own immediately after
P3 rather than being folded into a branch about MCP servers.

## What the sweep added afterwards

52 mutants over the diff, run in four foreground slices because this
environment reaps detached processes. 41 killed, 11 survived. Four of
the eleven were the catalog resolver, built as an inline closure in both
surfaces, with every decision in both copies unkillable — inverting the
undefined-check makes the resolver always return undefined and the
prompt silently falls back to guessing, which is F-061 restored with no
test failing. Unified into `catalogResolver` and covered.

The remaining seven are recorded rather than chased: six `?? -> ||` on
an object, a function or a non-empty string, and one cosmetic
`index === 0` choosing which line is highlighted.

## Checked and found clean

Recorded so that an absence of findings is distinguishable from an
absence of looking.

**Security:** `use_tool` reaching `evaluateShellApproval` or the
permission store (genuinely closed — `rememberable` is a literal
`false`, no fingerprint or pattern is persisted, and the branch precedes
the evaluator in both files); auto-approval skipping the prompt
(`risk: "destructive"` is static and `resolveApprovalDecision` returns
`ask` under both `default` and `trust`); the displayed call diverging
from the executed one; the prompt throwing or hanging on `null`, `42`,
`"str"`, `[]`, `{`, `""`, circular and deeply-nested payloads;
truncation off-by-one at 3 999 / 4 000 / 4 001.

**Correctness:** `busy-dispatch` routing, where the consumer is tested
before the installer in both the classifier and the live if-chain.

**Test quality:** `class-table.ts` and its invariants (every weakened
rule is killed with a precise message); `mcp-consumer.ts`'s AC4 and AC5
coverage; `splitFqn`'s boundaries; the server/tool-before-arguments
ordering.

## The tooling, again

`scripts/mutation-sweep.ts` had three defects of its own, all found by
the test-quality reviewer and all reproduced in a scratch repository:

- the mid-run guard printed "nothing was written" and then
  `finally { restore() }` wrote every original back, including the file
  it had just refused to touch — the promise exactly inverted;
- `chosen.length - survivors.length` counted never-run mutants as
  killed, so a run that stopped after three of six reported "5 killed";
- a stopped run with no survivors yet exited 0.

Plus `isEquivalent` compared the original line against the mutated line
rather than the mutation itself, silently suppressing 13 real
`&&`→`||` mutants across the repository.

Third time this script has had the defect it was built to catch. Worth
stating plainly rather than filing quietly: the tool that enforces "no
line may be inverted without a test failing" is itself a line of code
nobody was mutating.

```json keryx:findings
[
  {
    "id": "F-056",
    "reviewer": "review-testing-practices",
    "severity": "blocker",
    "file": "src/mcp-servers/approval-wiring.test.ts",
    "line": 42,
    "confidence": "high",
    "blocking_merge": true,
    "problem": "The AC7 test proving `use_tool` never reaches `evaluateShellApproval` compared the CHARACTER OFFSETS of two string literals in the source text of two files. No production code ran, so the approval DECISION had no coverage at all.",
    "impact": "The security fix this phase exists for was unverified. Measured by the reviewer: inverting `if (!approved)` \u2014 so typing `y` DENIES and anything else APPROVES and runs a third party's tool \u2014 left the full 9158-test suite green. So did inverting `return id === \"allow\"` in the TUI, so did replacing the description with a constant, and so did commenting the branch out entirely, restoring F-032.",
    "suggested_fix": "Extract the whole prompt \u2014 print, read, verdict \u2014 behind injected IO (`promptUseToolApproval`), and the TUI's verdict into `isDockApproval`. Test with real answers.",
    "evidence": "Reviewer ran each mutation against the full suite and reported 9139 pass / 0 fail. Reproduced by the author before fixing.",
    "class_scope": {
      "sites": [
        "src/commands/shell.ts use_tool branch",
        "src/tui/tui-shell.ts use_tool branch",
        "src/mcp-servers/approval-wiring.test.ts ordering assertions"
      ],
      "enumeration_method": "Enumerated every decision in both new approval branches and asked which had a test that executes it. None did. The same question applied to the other three branches (apply_patch, elicitation, shell_exec) returns the same answer \u2014 recorded as a separate flow by operator decision."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e58d47ae \u2014 promptUseToolApproval and isDockApproval extracted; approval-decision.test.ts added"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "verifier": "author-mutation-check",
      "evidence": "Verified against commit e58d47ae, the tree that will merge. Re-ran the two mutations the reviewer used: `if (!approved)` inverted produces 18 failures in approval-decision.test.ts where 0 failed before; `isDockApproval` inverted produces 6. Restored: 30 pass. The finding does not reproduce at e58d47ae."
    }
  },
  {
    "id": "F-057",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/mcp-servers/approval-render.ts",
    "line": 125,
    "confidence": "high",
    "blocking_merge": true,
    "problem": "A single budget over the whole pretty-printed `tool_input` let one argument consume the space of the others, so a long leading value pushed the destructive arguments off screen.",
    "impact": "Executes. `tool_input`'s schema is the UNTRUSTED SERVER'S OWN, so a hostile server publishes a required 4000-character `justification` and every call it induces arrives pre-overflowed. Measured: `{reason: <4080 chars>, path: '/home/victim/.ssh/authorized_keys', content: 'ssh-rsa \u2026'}` rendered with neither `path` nor `content` visible; the operator saw the reassurance, 'arguments truncated', and [y/N]. Approving ran the real call.",
    "suggested_fix": "Budget per VALUE, not per payload, so every key renders whatever any other key does; cap the key count separately and say how many were elided.",
    "evidence": "Reviewer measured `rendering contains 'authorized_keys': false` and `contains 'ssh-rsa': false`. Author reproduced before fixing.",
    "class_scope": {
      "sites": [
        "src/mcp-servers/approval-render.ts renderArguments (all callers)",
        "src/commands/shell.ts readline prompt",
        "src/tui/tui-shell.ts transcript lines"
      ],
      "enumeration_method": "One rendering function feeds both surfaces, so the class is that function's output; enumerated its callers to confirm there is no second path that formats arguments."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e58d47ae \u2014 MAX_ARGUMENT_CHARS is per value (400), MAX_ARGUMENT_KEYS caps the list"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "verifier": "author-mutation-check",
      "evidence": "Verified against commit e58d47ae. The reviewer's exact payload now renders both `authorized_keys` and `ssh-rsa`; `argumentsTruncated` stays true so the elision is still announced. Pinned by two rows in approval-render.table.test.ts."
    }
  },
  {
    "id": "F-058",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/mcp-servers/approval-render.ts",
    "line": 130,
    "confidence": "high",
    "blocking_merge": false,
    "problem": "`sanitiseForDisplay` deliberately keeps `\\n` \u2014 correct for an error message, wrong for an identifier \u2014 and the renderer applied it to `server`, `tool` and `fqn` without checking for line breaks.",
    "impact": "A `tool_name` of `evil__tool` + 40 newlines + `  server: docs\\n  tool:   search_docs` renders a COMPLETE, correctly-shaped, benign-looking approval prompt, with the real tool name 40 rows above the fold and the attacker's text immediately above [y/N]. The call does not resolve afterwards, so the gain is an arbitrary convincing write to the approval surface \u2014 including desensitising the operator with N harmless-looking prompts before a real one. In the TUI the same string reaches the dock subtitle as up to 10 attacker-controlled yellow lines.",
    "suggested_fix": "A separate `sanitiseIdentifier` that flattens line breaks and caps length; `sanitiseForDisplay` keeps its `\\n` contract for messages.",
    "evidence": "Reviewer rendered the 48-row prompt and quoted it. Author reproduced: 4 array elements became 11 screen rows.",
    "class_scope": {
      "sites": [
        "src/mcp-servers/approval-render.ts server/tool/fqn",
        "src/mcp-servers/approval-render.ts argument values",
        "src/tui/mcp-consumer.ts targetOf"
      ],
      "enumeration_method": "Enumerated every field on this branch that is (a) third-party text and (b) rendered as one line of a record rather than as a message body. Three sites; all three now use the identifier-grade sanitiser."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e58d47ae \u2014 sanitiseIdentifier added and applied; MAX_IDENTIFIER_CHARS caps at 80"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "verifier": "author-mutation-check",
      "evidence": "Verified against commit e58d47ae. Array length now equals screen rows for the 40-newline payload; a 200 000-character tool_name caps at 81. Pinned by three rows in approval-render.table.test.ts."
    }
  },
  {
    "id": "F-059",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/mcp-servers/http-headers.ts",
    "line": 335,
    "confidence": "high",
    "blocking_merge": false,
    "problem": "`displayUrl`'s catch branch returned `raw` \u2014 the whole url, password included \u2014 excused by a comment saying the case was 'most likely because a ${VAR} is still in it'. The ${VAR} branch returns earlier, so that justification is unreachable by construction.",
    "impact": "Every url `new URL` rejects printed its credential through three callers: `keryx mcp list`, the `/mcp` view, and `describeForApproval` \u2014 the trust prompt, i.e. the moment the operator is deciding. Measured leaking forms: `//user:hunter2@host/v1`, `https://user:hunter2@host:notaport/mcp`, `https://user:hunter2@[bad/mcp`.",
    "suggested_fix": "Elide userinfo and query by TEXT as the floor under every return path, so the function fails closed whether or not the url parses.",
    "evidence": "Reviewer listed three inputs and their verbatim output. Author reproduced all three before fixing.",
    "class_scope": {
      "sites": [
        "src/mcp-servers/http-headers.ts displayUrl catch branch",
        "src/mcp-servers/http-headers.ts ${VAR} branch",
        "callers: keryx mcp list, /mcp view, trust prompt"
      ],
      "enumeration_method": "Enumerated every return path of displayUrl and asked which could emit userinfo; then enumerated its callers to size the blast radius. The path-segment case is documented as knowingly kept."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e58d47ae \u2014 elideCredentialText is the floor under both fallback paths"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "verifier": "author-mutation-check",
      "evidence": "Verified against commit e58d47ae. All three inputs now render `\u2026@`; a clean url and a ${VAR} url are unchanged. Pinned by a test.each in mutation-gaps.test.ts with two BOUNDARY rows."
    }
  },
  {
    "id": "F-060",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/tui/mcp-consumer.ts",
    "line": 97,
    "confidence": "high",
    "blocking_merge": false,
    "problem": "The `/mcp` view sanitised `detail` and `problems` and not `target`, and indented only the FIRST line of a multi-line detail.",
    "impact": "`target` comes from a committed `.keryx/mcp-servers.json` \u2014 a file in a repository somebody else wrote, which trust.ts is explicit is not consent \u2014 and nothing in the config loader rejects control characters in `command`, `args` or `url`. The row reading `needs-approval` was precisely the row that could print a forged `\u2713 trusted` over the line above it. Separately, a crafted HTTP response body embedded in `ServerState.error` rendered two fabricated server rows at column 0, indistinguishable from real ones.",
    "suggested_fix": "Sanitise `target` with the identifier-grade sanitiser; indent every line of a multi-line detail and problem.",
    "evidence": "Reviewer quoted both rendered outputs. Author reproduced.",
    "class_scope": {
      "sites": [
        "src/tui/mcp-consumer.ts targetOf",
        "src/tui/mcp-consumer.ts detail lines",
        "src/tui/mcp-consumer.ts problem lines"
      ],
      "enumeration_method": "Enumerated every field buildConsumerModel emits and classified each as regex-constrained (name, transport, credentials) or free third-party text (target, detail, problems). The three free ones are now all handled."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e58d47ae \u2014 targetOf sanitised; renderConsumerLines indents every line"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "verifier": "author-mutation-check",
      "evidence": "Verified against commit e58d47ae. Tests assert no ESC or CR survives a stdio command or a url, and that no forged row starts at column 0 for a multi-line error or problem."
    }
  },
  {
    "id": "F-061",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/mcp-servers/approval-render.ts",
    "line": 71,
    "confidence": "high",
    "blocking_merge": false,
    "problem": "The prompt derived the server by splitting the FQN on its first separator, while the executed call resolves by exact match against the catalog.",
    "impact": "Server names legally contain `_`, so a project config may define `github__notes`. Its tool `exfil` has the valid FQN `github__notes__exfil`, resolves and runs correctly \u2014 and the prompt said `server: github` / `tool: notes__exfil`, crediting a project-supplied server's call to the operator's own user-scoped `github`. Two answers to one question, and the displayed one was not the executed one.",
    "suggested_fix": "Resolve against the catalog that will execute the call; keep the split only as a labelled fallback for a name that cannot resolve anyway.",
    "evidence": "Reviewer traced both derivations and gave the mirrored input. Author reproduced: splitFqn('github__notes__exfil') returns server 'github'.",
    "class_scope": {
      "sites": [
        "src/mcp-servers/approval-render.ts splitFqn",
        "src/commands/shell.ts resolver wiring",
        "src/tui/tui-shell.ts resolver wiring"
      ],
      "enumeration_method": "Enumerated every place the branch derives a server name from an FQN: one guess and two wirings of the authoritative lookup. The sweep then showed both wirings were themselves unkillable, so they were unified into catalogResolver."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commits e58d47ae (resolver parameter) and 5ecaf049 (catalogResolver extracted and tested)"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "verifier": "author-mutation-check",
      "evidence": "Verified against commit 5ecaf049, the tree that will merge. The resolver returns server 'github__notes' for the mirrored input; catalogResolver has BOUNDARY tests for an absent and an empty catalog. Before 5ecaf049 the sweep reported all four decisions in the two inline copies as surviving; after, they are covered."
    }
  }
]
```
