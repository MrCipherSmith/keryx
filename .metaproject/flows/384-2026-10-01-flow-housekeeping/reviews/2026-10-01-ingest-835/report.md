Two independent reviews of flow 384 (cross-clone flow ids, folder-committed gate) at head c50e7344 (PR #835): correctness and docs/TUI/security, both Sonnet. One major and ten minor findings (the reviewers overlapped on four of them); ten fixed in a3b0e6b0 and the TUI reload ordering (F-011) in 046d7b83.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow384-pr835-correctness",
    "severity": "major",
    "problem": "The duplicate-id check skips a local flow folder whenever ANY remote ref holds a folder with the same name, and never asks whether a different ref holds that number under another name.",
    "impact": "A flow whose own branch was pushed (origin/feat holds the same folder) while another clone merged a different flow with the same number to origin/main is not reported by flow check, flow list or the TUI tag, so the PR merges with colliding ids.",
    "suggested_fix": "Drop the same-name guard; pick the clash with flowNumberOfDir(entry.dir) === n && entry.dir !== dir.",
    "evidence": "Read src/flow/service.ts check() remote clash loop and folder-hygiene.test.ts: the tests only covered the same name on ONE ref.",
    "confidence": "high",
    "file": "src/flow/service.ts",
    "line": 1707,
    "quote": "          if (remoteDirs.some((entry) => entry.dir === dir)) {",
    "class_scope": {
      "sites": [
        "src/flow/service.ts check(): the remote clash loop with the same-name guard (the defect)",
        "src/flow/service.ts renumber(): refuses a target number any known remote folder uses (number-only, no name guard)",
        "src/flow/remote-flows.ts remoteFlowNumbers(): reserves numbers for flow init (number-only, no name guard)",
        "src/tui/flow-hygiene.ts and flow list tags: take the duplicate-id verdict from check(), no second comparison"
      ],
      "enumeration_method": "keryx ctx rg for flowNumberOfDir and knownRemoteFlowDirs over src: every comparison of a local flow number against remote folders; only check() compares by folder name as well."
    }
  },
  {
    "id": "F-002",
    "reviewer": "flow384-pr835-correctness",
    "severity": "minor",
    "problem": "Remote folder names are untrusted input and the filter /^\\d+-/ is looser than the local one (/^\\d{3}-/): a date-named or four-digit folder on a remote branch counts as a flow number.",
    "impact": "Anyone who can push a branch adds .metaproject/flows/9999-x or 2026-notes; after fetch flow init mints 10000-... or 2027-..., which listFlowDirs never lists, so the new flow is invisible to list, resolve and check.",
    "suggested_fix": "Accept only exactly three digits and a dash for remote names; ignore everything else.",
    "evidence": "Read src/flow/remote-flows.ts flowDirsOnRef and src/flow/store.ts listFlowDirs; remote-flows.test.ts blessed four-digit numbers.",
    "confidence": "high",
    "file": "src/flow/remote-flows.ts",
    "line": 95,
    "quote": "    .filter((name) => /^\\d+-/.test(name));"
  },
  {
    "id": "F-003",
    "reviewer": "flow384-pr835-docs-tui-security",
    "severity": "minor",
    "problem": "MAX_REFS = 200 is applied in alphabetical refname order after tip de-duplication and drops the rest silently, while the docs promise every number held by a known remote branch.",
    "impact": "A clone with more than 200 distinct remote-tracking tips can lose origin/main (or any flow branch) from the scan: flow init can reuse a number it holds and check reports nothing; this repo has 244 remote-tracking refs.",
    "suggested_fix": "Order refs main/master/HEAD target first, raise the cap, document the cap and that a never-fetched ref is invisible.",
    "evidence": "Read src/flow/remote-flows.ts remoteRefs; counted the remote refs of this clone.",
    "confidence": "high",
    "file": "src/flow/remote-flows.ts",
    "line": 19,
    "quote": "const MAX_REFS = 200;"
  },
  {
    "id": "F-004",
    "reviewer": "flow384-pr835-correctness",
    "severity": "minor",
    "problem": "git ls-tree --name-only is read without -z, so git C-quotes non-ASCII and special characters in the repo-relative prefix; the exact-name comparison never matches and basename leaves a stray quote on remote folder names.",
    "impact": "A flow project in a monorepo subdirectory with a non-ASCII name reads every committed flow as not committed: the folder-committed gate fails permanently and flow check reports a false duplicate-id against the flow's own merged branch.",
    "suggested_fix": "Use -z and split on NUL in both modules; strip control characters from names that reach messages.",
    "evidence": "Reproduced by the second reviewer in a scratch repo with a non-ASCII project subdirectory: flowFoldersInHead returned an empty set although flow.json was in HEAD.",
    "confidence": "high",
    "file": "src/flow/folder-committed.ts",
    "line": 29,
    "quote": "    const result = await runGit(cwd, [\"ls-tree\", \"--name-only\", \"--full-tree\", \"HEAD\", \"--\", ...paths]);"
  },
  {
    "id": "F-005",
    "reviewer": "flow384-pr835-correctness",
    "severity": "minor",
    "problem": "Any non-zero ls-tree exit, not only an unborn HEAD, is treated as nothing committed.",
    "impact": "A corrupt object or a failing partial clone turns into a failed gate that tells the operator to git add something already committed.",
    "suggested_fix": "Distinguish the unborn HEAD (rev-parse --verify -q HEAD) and throw for other failures so the gate becomes unevaluable.",
    "evidence": "Read src/flow/folder-committed.ts lines 33-36.",
    "confidence": "medium",
    "file": "src/flow/folder-committed.ts",
    "line": 33,
    "quote": "    if (result.code !== 0) {"
  },
  {
    "id": "F-006",
    "reviewer": "flow384-pr835-correctness",
    "severity": "minor",
    "problem": "The Dir label padding in the flow detail view was changed from six spaces to five, so its value column is one off from every other row.",
    "impact": "Cosmetic misalignment in /flows detail and any assertion on the old spacing.",
    "suggested_fix": "Restore the original spacing.",
    "evidence": "Read src/tui/flow-inspector.ts near line 142.",
    "confidence": "high",
    "file": "src/tui/flow-inspector.ts",
    "line": 142,
    "quote": "Dir     "
  },
  {
    "id": "F-007",
    "reviewer": "flow384-pr835-correctness",
    "severity": "minor",
    "problem": "The ref.startsWith(\"-\") guard in remoteRefs is dead code (the ref is the full refs/remotes/... name) and the test that claims to cover it cannot fail.",
    "impact": "False assurance about option injection.",
    "suggested_fix": "Remove the guard and the test.",
    "evidence": "Read src/flow/remote-flows.ts remoteRefs and remote-flows.test.ts.",
    "confidence": "high",
    "file": "src/flow/remote-flows.ts",
    "line": 72,
    "quote": "    if (ref.startsWith(\"-\") || !ref.startsWith(\"refs/remotes/\") || ref.endsWith(\"/HEAD\")) {"
  },
  {
    "id": "F-008",
    "reviewer": "flow384-pr835-correctness",
    "severity": "minor",
    "problem": "The gate and warning tests run only on a repository with no commits; HEAD present but flow.json absent, a project root in a git subdirectory and a detached HEAD are never exercised.",
    "impact": "A regression in the prefix or path building, or in handling of exit 0 with empty output, would pass the whole suite.",
    "suggested_fix": "Add tests for those cases.",
    "evidence": "Read src/flow/folder-hygiene.test.ts: gitRepo never commits before init.",
    "confidence": "high",
    "file": "src/flow/folder-hygiene.test.ts",
    "line": 202,
    "quote": "  test("
  },
  {
    "id": "F-009",
    "reviewer": "flow384-pr835-docs-tui-security",
    "severity": "minor",
    "problem": "completionFixHint has no case for the folder-committed gate, although the docs say each failing gate names the command that fixes it.",
    "impact": "flow check-complete and the /governance check show no fix line for an uncommitted flow.",
    "suggested_fix": "Add a folder-committed case with the git add and git commit hint.",
    "evidence": "Read src/flow/service.ts completionFixHint.",
    "confidence": "high",
    "file": "src/flow/service.ts",
    "line": 253,
    "quote": "function completionFixHint("
  },
  {
    "id": "F-010",
    "reviewer": "flow384-pr835-docs-tui-security",
    "severity": "minor",
    "problem": "The docs and skills say the flow folder is committed and again at closing and flow complete enforces it, but the gate only checks that flow.json is in HEAD before closing.",
    "impact": "A promise the code does not keep: untracked or edited acceptance-criteria.md passes the gate, and the closing commit is never required.",
    "suggested_fix": "Narrow the wording everywhere to flow.json in HEAD before closing; the closing commit stays a rule.",
    "evidence": "Read src/flow/folder-committed.ts and the wording in cli-reference.md, modules.md, CHANGELOG, templates.ts and both flow-orchestrator SKILL.md copies.",
    "confidence": "high",
    "file": "docs/docs/cli-reference.md",
    "line": 3829,
    "quote": "committed"
  },
  {
    "id": "F-011",
    "reviewer": "flow384-pr835-docs-tui-security",
    "severity": "minor",
    "problem": "The governance modal's reload awaits the informational hygiene pass (a full flow check, including git calls) in the same Promise.all as the report read, so the first paint waits for it.",
    "impact": "On a slow disk, a partial clone or hundreds of refs, opening /governance shows nothing until the advisory check finishes; the same check also runs on every flow list.",
    "suggested_fix": "Load the hygiene tags after the first paint or without gating ready.",
    "evidence": "Read src/tui/governance-inspector.ts reload.",
    "confidence": "medium",
    "file": "src/tui/governance-inspector.ts",
    "line": 268,
    "quote": "Promise.all"
  }
]
```
