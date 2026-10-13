STATUS: DONE

REVIEW_RESULT
```json
{
  "reviewer": "review-architecture",
  "status": "DONE_WITH_CONCERNS",
  "summary": "The nine sites the PR touches are correct and behaviour-preserving, but the fix is per call site, so the class F-045 names is not closed: five more commands still pass a user-typed or repo-supplied revision to git without --end-of-options, and --flag=--output=<file> still makes git write that file.",
  "findings": [
    {
      "id": "F-001",
      "severity": "major",
      "location_class": "in-diff",
      "file": "src/commands/flow-check-ac.ts",
      "quote": "const mergeBase = await spawn([\"git\", \"merge-base\", \"HEAD\", refName], opts);",
      "problem": "assertGitRevision plus --end-of-options was added at nine hand-picked sites; there is no shared builder or chokepoint, so the PR's claim (every place a user-typed ref reaches git is closed) is false. Unguarded sinks of the same shape: flow-check-ac.ts:167,170,191,194 (resolveDiffAgainstBase, resolveIngestDiff), health/run.ts:621, testing/service.ts:759, wiki/freshness/run.ts:115. Sources: --diff (flow check-ac), --since (health, test, wiki), review ingest --ref, and flow.baseBranch read from committed flow.json (also rendered by the TUI inspector, tui/inspector-sources.ts:283).",
      "impact": "Trigger: an operator or model runs one of these commands with --flag=--output=/abs/file, or opens a repo whose flow.json has baseBranch \"--output=/abs/file\". Outcome: git writes (overwrites) that file. The committed-content vector needs no flag at all.",
      "evidence": "Scratch repo, worktree src/cli.ts, each run left the file on disk: `flow check-ac 001 --diff=--output=<abs>/pwned.txt` -> pwned.txt written. flow.json baseBranch=\"--output=<abs>/pwned2.txt\" then plain `flow check-ac 001` -> pwned2.txt written (99 B diff). `test run --changed --since=--output=<abs>/s1.txt` -> written. `health run --changed --since=--output=<abs>/s2.txt` -> written. `wiki freshness --since=--output=<abs>/w1.txt` -> written. Direct call of resolveIngestDiff(defaultGitSpawn, \"--output=<abs>\", \"HEAD\") -> written (merge-base fails, the fallback puts refName straight into git diff). None of these commands is in TRUST_ROUTINE_KEYRYX (gate prints false for all), so the exposure is runtime only, but the PR's own title and test header claim the class.",
      "suggested_fix": "Put one function in src/lib/git-revision.ts that returns the argv fragment, e.g. gitRevisionOperand(ref): string[] => [\"--end-of-options\", assertGitRevision(ref)], and use it at all argv builders above and the nine already fixed. In resolveDiffAgainstBase/resolveIngestDiff also stop falling back to the raw refName after a failed merge-base. Replace the fixed-file literal pin with a source guard that lists every `\"git\", \"diff\"|\"merge-base\"|\"log\"|\"rev-list\"` argv taking a non-literal operand and fails if it lacks the helper.",
      "confidence": "high",
      "reviewer": "review-architecture",
      "class_scope": {
        "sites": [
          "src/commands/flow-check-ac.ts:167",
          "src/commands/flow-check-ac.ts:170",
          "src/commands/flow-check-ac.ts:191",
          "src/commands/flow-check-ac.ts:194",
          "src/commands/flow.ts:1362 (--diff into runCheckAc)",
          "src/commands/review.ts:976 (review ingest target.ref into resolveIngestDiff)",
          "src/tui/inspector-sources.ts:283 (flow.baseBranch from flow.json)",
          "src/health/run.ts:621 (health --changed --since)",
          "src/testing/service.ts:759 (test run --changed --since)",
          "src/wiki/freshness/run.ts:115 (wiki freshness --since and queue base)",
          "already correct: review.ts:3545,3598,3674; review-jev-{select,risk,rules,docs,contract,scenarios}.ts"
        ],
        "enumeration_method": "keryx ctx rg --all for optionValue(args, \"--ref|--base|--diff|--since|--from|--to|--head|--target\") (39 matches, each read), then keryx ctx rg --all for every git argv spawn (148 matches in 65 files) and a read of each one whose operand is a variable. Excluded after reading: review/bot/run.ts:184 (baseSha is GitHub base.sha), flow/service.ts:2527 (prefixed origin/), review-run.ts (URL validated), --head (hex checked), ctx diff (deliberate passthrough). gh sinks (autonomous-run.ts:191, tui-shell.ts:627) read only; not judged."
      }
    },
    {
      "id": "F-002",
      "severity": "minor",
      "location_class": "in-diff",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "expect(text.split(needle).length - 1, `${file}: ${needle}`).toBe(times);",
      "problem": "Every site carries two obligations (assertGitRevision and --end-of-options) and the argv builder is copy-pasted nine times (six jev files, three in review.ts). The only guard counts a literal string in eight named files: it cannot see a ninth site (F-001 is that case), and it still passes if the literal sits in a comment or dead code. The jev behaviour tests return early when Jev is off, so they prove nothing in CI, as the test's own comment admits.",
      "impact": "The next copy of the builder, or a refactor, re-opens the hole with green tests.",
      "evidence": "F-001: five commands outside the pinned list reproduce the bug while the 8-row table passes. Pin lists review.ts, review-jev-select/risk/contract/docs/scenarios/rules only.",
      "suggested_fix": "One helper (F-001) and a guard that enumerates git spawns across src instead of naming files; keep the CLI runs for review slice/scope/blast-radius/floor as the behavioural proof.",
      "confidence": "high",
      "reviewer": "review-architecture"
    },
    {
      "id": "F-003",
      "severity": "minor",
      "location_class": "in-diff",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "return words.some((w) => /^--[^=]+=-/.test(w));",
      "problem": "The gate keeps its own notion of option-ness (regex on --long=-..., review entries only, plus the EXEC_FLAGS recursion) beside the runtime's startsWith(\"-\"). The regex also matches the legitimate stdin spelling: review readers treat \"-\" as standard input (review.ts:2621 --result, 3159 --refuted, 3206 --scope).",
      "impact": "Over-block: `keryx review complete --result=-`, `review ingest ... --scope=-`, `--refuted=-` now prompt, while the space form `--result -` stays routine. Fail-closed, no document or skill spells the glued form (rg over src, docs, skills: 0 matches), so low cost.",
      "evidence": "isTrustRoutineCommand: `review complete --result=-` false, `review complete --result -` true, `review ingest --target pr --ref 12 --scope=-` false, with --scope - true.",
      "suggested_fix": "Exempt a lone `-` value (/^--[^=]+=-.+/) or accept the prompt and note it in the table comment. Do not widen the regex to other rows without a runtime sink behind them.",
      "confidence": "high",
      "reviewer": "review-architecture"
    }
  ],
  "stats": { "blocker": 0, "major": 1, "minor": 2, "info": 0 }
}
```

## Summary (architecture)

**Major**
- F-001 The fix sits at nine call sites, not at a chokepoint, so the class is open. Five more commands (flow check-ac, review ingest's AC freshness check, TUI inspector via flow.json baseBranch, health/test/wiki --since) still let `--output=<file>` reach git; all reproduced end to end (file written). Remedy: one operand helper in src/lib/git-revision.ts plus an enumerating guard.

**Minor**
- F-002 Nine duplicated argv builders with two obligations each, guarded only by a literal-count test over eight named files.
- F-003 The gate's `--x=-` regex is a second definition of option-ness and over-blocks the glued stdin spelling (`--result=-`, `--scope=-`); fail-closed.

**Questions**
- Does the operator want F-001's untouched sites fixed in this PR, or carried as a new flow? I scored them in-diff because the PR claims the class; if they count as pre-existing, F-001 moves to that lane and nothing here blocks.

**Pre-existing**
- resolveDiffAgainstBase and resolveIngestDiff fall back to the raw refName when merge-base fails, which is what hands a hostile string to git diff (flow-check-ac.ts:169,193).
- gh pr view takes target.ref and branch names positionally (autonomous-run.ts:191, tui-shell.ts:627); read-only, not judged.

**Verified clean**
- assertGitRevision in a leaf module (no imports): boundary and dependency direction fine.
- Legit revisions behave identically with and without --end-of-options for diff and merge-base (git 2.43.0, scratch repo): HEAD, HEAD~1, main..HEAD, main...feat, tag v1, HEAD^{}, @{u}, feat@{1}, :/one, HEAD^{commit}, a sha. Hostile `--output=` after eoo exits 128, no file.
- --end-of-options needs git 2.24 (2019). CI uses ubuntu-latest and macos-latest (ci.yml); I did not read their git versions. No minimum git is documented in README, docs or package.json.
- Abbreviated `--outp=` is not accepted by git diff 2.43 (no file written), so no abbreviation hole in EXEC_FLAGS.
- review/bot/run.ts baseSha, --head, review-run --ref are not user-controlled strings.

Routing audit: graph_used no (not-relevant, ripgrep enumeration), wiki_used no (not-relevant), ctx_used yes, raw_rg_used no. Scratch files under the scratchpad architecture folder; one stray `keryx ctx rg` raw log landed in the ignored .metaproject/data/gdctx/raw.
