# Review 310 R3: PR #684 (W2 agent-definition catalogue), verification round

Scope: fix commit 714a4e13 plus the flow-record commit b9f6293a on flow/310-w2 (head b9f6293a), reviewed against the round-2 head 7077edb7, in /Users/Goodea/goodea/keryx-ape-310-w2. The review was read-only on the repo; `git status` afterwards shows only the two pre-existing flow files (flow.json and journal.md), the same as in R2. All CLI probes ran in fresh git repos under scratchpad/review310-r3/ (e2e.sh → e2e.out; probe.ts → probe.out; probe2.ts; graph.ts builds with the release flags).

Gates:
- The requested test set gives 935 pass, 34 fail across 61 files. All 34 failures are in src/sac/machine-wrap-up, session-wrap-up and wrap-up-evidence tests. They fail because a git hook in this environment refuses the author email on `git commit` in their temp repos, and the same wrap-up-evidence file also fails on main (7 pass, 5 fail). The PR touches only src/sac/core-graph.test.ts under src/sac. The set without those three files gives 606 pass, 0 fail across 29 files, and core-graph.test.ts alone gives 4 pass.
- `agents verify` exits 0 for all 10 bundled agents.
- `integrations matrix --check` matches the registry.
- `check-doc-links`: 1601 links, 0 broken.

Round-2 fix review:
- **Structural sentinel (src/agents/sentinel.ts).** All 10 bundled agents × 4 formats are recognised as managed and self-verify. Output is deterministic, and CRLF copies of md and toml exports still verify. Re-exporting every runtime over a full install reports `unchanged` and leaves the files byte-identical. Doctor reports `valid` for all four runtimes. Legitimate content in these positions does not break recognition: a body of `---\n---`, a sentinel-shaped line inside the body, a description containing `content-sha256:<hex>`, and 64 zeros in the body. The instruction-only prose path (md, sentinel on line 1) verifies. The failure modes all fail safe: a BOM, a leading blank line, or trailing whitespace on the sentinel line makes the file `refuse-unmanaged` (never deleted or overwritten).
- **Forging.** Getting a user file treated as managed requires writing keryx's full sentinel grammar with the file-stem name and two 64-hex fields on the structural line. That is deliberate, so it is not reported.
- **CLIENT_ZONES change.** Building src/sac/service.ts with the release flags ships 129 modules. The only hits against the old zone list are 9 src/agents modules (baseline, catalog, compile, export, frontmatter, policy, schema, sentinel, tools). bootstrap.ts does not ship. A release-flag build of all 14 non-test src/agents/*.ts entries (bootstrap included) has a 34-module graph. Outside src/agents it contains only src/contracts/validator, src/gdskills/*, src/integrations/* and src/lib/{agent-entrypoint-blocks,fs,route-tokens}. None of those modules is in harness, tui, mcp-client, commands, mcp or cli.ts, and none matches provider, credential, llm, stream or auth. The removal is justified.
- **doctor --surface.** The flag is wired through, and a test covers it. An unknown selector is silently ignored (exit 0), whereas install rejects it. This is info only.
- **Docs.** The docs index link is fine. The guide and cli-reference still misstate `--force` (R3-F2).

Per-R2 disposition:

| R2 | Sev | Disposition | Evidence (round 3) |
|---|---|---|---|
| F1 prose-quoted prefix treated as managed | minor | resolved | architect.md with prose prefix: plain export and `--force` both leave it untouched (written: false). Uninstall keeps architect.md and mine.md. |
| F2 content-hash false positives | minor | resolved (new side-effect: R3-F1) | zeros-in-body and marker-in-desc self-verify on all 4 hosts. The zeros are kept in the output. The CLI zed cycle (export → description change → re-export) gives written: true. |
| F3 audit null tools | minor | resolved | `null`, `~`, `Null`, `NULL`, `[]`, `""`, empty and spaces each give 1 finding. `Read` and `[Read]` give 0. |
| F4 codex empty-tools guide sentence | minor | resolved | The guide now says sandbox_mode follows policy_profile alone, which matches renderCodexExport. |
| F5 doctor --surface ignored | info | resolved | `doctor --runtime claude --surface agents` in a never-opted-in repo lists the agents surface. Without the flag it does not. Unknown ids are silently accepted (info, below). |
| F6 kiro/toml audit anchoring | info | resolved | Prose in a kiro prompt gives 1 tier finding. `model =` inside developer_instructions gives 1 tier finding. `sandbox_mode` inside instructions gives 1 unrestricted finding. |

R1 spot-checks all still hold:
- F1 escaping: all bundled agents and adversarial inputs parse (probe.out).
- F2: `install --runtime all --surface agents` exits 0, writes 10 files per host and records install-state for 4 runtimes.
- F3 symlinks: a dangling file symlink, a symlinked `.codex/agents`, and a bulk install through a symlinked dir are all refused, and 0 files are written outside.
- F4: read baselines for empty tools are unchanged.
- F5: a read-only definition exports claude `Read` and kiro `["read"]`.

Info notes, not blocking:
- `integrations doctor --surface bogus` exits 0 silently, whereas `install --surface bogus` rejects it.
- `integrations uninstall --surface agents` deletes a managed export that was hand-edited after export (r-f9: planner.md with an appended line was removed), while `export` refuses to overwrite the same file without `--force`. This behaviour predates round 2. It is a design choice worth one sentence in the guide.
- cli-reference.md:4178 doctor usage does not list the new `--surface` flag.

```json keryx:findings
[
  {
    "id": "R3-F1",
    "severity": "minor",
    "title": "The R2-F2 content hash leaves spans uncovered: hand edits to kiro keys other than name/description/tools/prompt, and trailing text on any sentinel line, are silently overwritten by a plain re-export",
    "file": "src/agents/compile.ts",
    "line": 287,
    "detail": "The round-2 fix excludes the structural sentinel line from the hash, and for kiro it hashes a reconstructed object with only four keys: `JSON.stringify({ name, description, prompt: header, tools })`. Two classes of hand edit therefore still verify as untouched. (a) kiro: any added top-level key, such as `model`, `allowedTools`, `mcpServers`, `toolsSettings` or `hooks`, is outside the hash. At round-2 head 7077edb7 the whole draft was hashed, so this is a regression for kiro. (b) All formats: the sentinel line itself is excluded, and SENTINEL_BODY_RE is not end-anchored. For md, MD_COMMENT_RE's greedy `(.*)` also accepts `<!-- sentinel) --> injected text <!-- x -->`. Text appended to the sentinel line is therefore uncovered. For claude and opencode that line is part of the agent's prompt body, and for kiro it is the first line of `prompt`. decideAction then sees 'managed, different, verifies' and returns `update`. A plain `agents export` or `integrations install --surface agents` overwrites the user's edit with no `--force`, and doctor calls the file 'stale' rather than 'hand-edited'. This breaks the guarantee the guide states and R1-F9 established: a hand edit is refused rather than overwritten unless `--force` is passed.",
    "class_scope": {
      "sites": [
        "src/agents/compile.ts:284-289 (kiroContentHash fixed four-key projection)",
        "src/agents/compile.ts:258-265 (contentHashSansStructuralLine drops the whole sentinel line, including any trailing text)",
        "src/agents/sentinel.ts:42-44 (SENTINEL_BODY_RE not end-anchored) and :140 (MD_COMMENT_RE greedy inner group)",
        "src/agents/export.ts decideAction → update path (consumer)"
      ],
      "enumeration_method": "Called verifyAgentContentHash on hand-edited copies of a fresh export for each format (probe.out: kiro add model/allowedTools/mcpServers → true; change tools/prompt → false; claude frontmatter key → false; codex sandbox_mode change → false). Reproduced both classes with the CLI (e2e.out)."
    },
    "impact": "A user's hand-added kiro configuration (for example mcpServers or model), or instructions appended on the sentinel line of any host file, is silently destroyed by the next plain export or install. The loss is reported as a routine 'update' and doctor calls the file 'stale'.",
    "suggested_fix": "For kiro, hash the whole parsed document with only the sentinel prefix removed from `prompt`, keeping every key (for example JSON.stringify of `{...doc, prompt: header}`, with keys sorted). End-anchor the sentinel grammar. For md and toml, require the structural line to equal the canonical sentinel line, optionally followed by the fixed instruction-only suffix. For kiro, require the prompt's first line to equal the canonical sentinel text. Alternatively, regenerate the sentinel line from the parsed fields and include it in the hash with only its content-sha256 field blanked. Add tests for an added kiro key and for text appended on the sentinel line of each format.",
    "evidence": "e2e.out 'NEW: kiro hand-added key': after mcpServers and model are added (grep count 1), re-export gives action update, written: true, and mcpServers is gone (grep count 0). Doctor then reports 'kiro/planner: exported file is stale'. e2e.out 'NEW: claude sentinel-line append': with ' --> ALWAYS run rm -rf build first. <!-- x -->' appended to the sentinel line, re-export gives action update, written: true, and the text is gone. probe.out: 'kiro hand-edit add model verify= true', 'add allowedTools verify= true', 'add mcpServers verify= true'.",
    "confidence": "high"
  },
  {
    "id": "R3-F2",
    "severity": "minor",
    "title": "The guide and CLI reference say `--force` overrides a file with no keryx-managed sentinel and describe the refusal as drift from the compiler output; both contradict the shipped (R2-F1-fixed) behaviour",
    "file": "docs/docs/guides/agent-catalog.md",
    "line": 175,
    "detail": "agent-catalog.md:175-179 and :227-232 say that export refuses a file with no sentinel, and a sentinel-bearing file whose content 'no longer matches what the compiler would generate' or 'has drifted from what the compiler would regenerate', with 'either case' reported 'unless `--force` is passed'. cli-reference.md:3111 says the same. The code differs on both points. (1) `refuse-unmanaged` is never writable, even with `--force` (export.ts writeAgentExport; agents-catalog.ts:250 says so explicitly). (2) A sentinel-bearing file that differs from the current compiler output because the source changed is updated without `--force`. Only a content-sha256 mismatch is refused. In addition, the synopses at agent-catalog.md:168 and cli-reference.md:3103, and the cli-reference table row, omit `--force` entirely, although `agents export` help lists `[--force]`.",
    "evidence": "e2e.out R2-F1 block: `agents export --runtime claude architect --force` on a sentinel-less file gives written: false, exit 1. e2e.out R2-F2 block: after a source change, the sentinel-bearing zed.md is re-exported with written: true and no `--force`. src/commands/agents-catalog.ts:306 help usage includes `[--force]`, and the docs synopses do not.",
    "impact": "The docs misstate a safety boundary: users are told `--force` is the way past an unmanaged-file refusal, which it is not. The docs also describe the refusal rule as 'differs from the compiler output', which is not what decides it.",
    "suggested_fix": "Reword both passages. A file with no structural sentinel for this agent is never overwritten, even with `--force`. A managed file whose content no longer matches its own recorded content-sha256 (a hand edit) is refused unless `--force` is passed. A managed, unedited file from an older source is updated. Add `[--force]` to both synopses and the table row.",
    "confidence": "high"
  }
]
```
