# Review 310 R5: PR #684 (flow 310, W2), final narrow verification round

Scope: fix commit a29e6235 (plus the record commit 7fd965c5) on flow/310-w2 (head 7fd965c5), in /Users/Goodea/goodea/keryx-ape-310-w2. The review was read-only on the repo. All CLI probes ran in fresh git repos under scratchpad/review310-r5/ (script e2e.sh, output e2e.out).

R4 disposition:
- **R4-F2: resolved.** `hasManagedAgentExports` now counts only verified files. In e2e.out:
  - All exports hand-edited (r-dry): dry-run and the real run both report `nothing-to-remove`, and all 10 files remain.
  - Mixed directory (r-mix): dry-run reports `would-remove`, and the real run reports `removed`, keeps planner.md and warns about it.
  - Only an unmanaged file (r-unm): dry-run and the real run both report `nothing-to-remove`.
  - All files verified, across all runtimes (r-clean): would-remove and removed agree on claude, codex, opencode and kiro.
  - The only other reader of hand-edited files, `probeAgentsExports`/doctor, does not go through this function, so a hand-edited file is still visible there.
  - Note only: the dry-run still gives no "would keep" warnings. Round 4 marked that as optional.
- **R4-F1: resolved as specified, but one gap remains (R5-F1 below).**
  - A single explicit runtime is still strict:
    - `--runtime claude --surface bogus` exits 1.
    - `--runtime cursor --surface agents` exits 1 with "unknown surface selector(s) agents".
  - A multi-runtime request is now lenient:
    - `doctor --runtime all --surface agents` after `install --runtime all --surface agents` exits 0. The four agents hosts report ok, and every other runtime prints `· <id> — no matching surface`.
    - A comma list behaves the same, and `--json` also exits 0.
    - `--surface agents --surface bogus` exits 0, the same as install.
  - `--runtime all --surface bogus` exits 1 with a single "No selected runtime declares surface(s): bogus" line.
  - The gap: under the lenient path, a runtime that is skipped is not doctored at all. For doctor, `--surface` is additive: claude is still checked on every recorded surface, and the opt-in surface is added on top. So the skip silently drops health checks on the skipped runtimes.
  - The cli-reference wording for the strict/lenient/error rules matches the code, but "Exits 1 when any requested runtime's doctor result is not ok" no longer holds (see R5-F1). This skip-the-runtime approach is the one the R4-F1 suggested fix proposed, so the gap traces back to that suggestion. It is new behavior, not a re-litigation of an earlier round.

Regression checks:
- Default `install`, `doctor`, `uninstall --dry-run` (23 would-remove), `uninstall` and `doctor` with `--runtime all` all exit 0 (r-reg).
- The requested test set gives 485 pass, 0 fail across 22 files.
- Note only: the installer.test.ts test named "selecting something no runtime declares at all still errors, even under lenientSelectors" asserts `noMatchingSurface: true` rather than an error. The error comes from the CLI aggregate, which integrations.test.ts covers, so the test name is misleading but the coverage is fine.

```json keryx:findings
[
  {
    "id": "R5-F1",
    "severity": "minor",
    "title": "`integrations doctor --runtime <multi> --surface agents` skips runtimes without an agents surface entirely, so their recorded-surface drift is hidden and the command exits 0",
    "file": "src/integrations/installer.ts",
    "line": 750,
    "detail": "With `lenientSelectors`, `doctorIntegration` returns `{ ok: true, noMatchingSurface: true }` before its surface loop whenever none of the selectors match this runtime. For doctor, though, `--surface` is additive, not restrictive. The loop (installer.ts:775-797) always checks every surface, and `explicitlySelected` only brings in opt-in surfaces that have no install record. A matched runtime (claude) is therefore still fully doctored on ctx-guard, orient and the rest, while an unmatched runtime (cursor) is not doctored at all. install/uninstall can skip a whole runtime safely because their `--surface` restricts the work to the selected surfaces, and doctor's does not. The skip also breaks the documented contract in the cli-reference doctor row: 'Exits 1 when any requested runtime's doctor result is not ok'. A skipped runtime is requested, broken, and reported as ok.",
    "class_scope": {
      "sites": [
        "src/integrations/installer.ts:748-752 (lenient early return with noMatchingSurface)",
        "src/commands/integrations.ts:397-414 (handleDoctor treats noMatchingSurface as skip-only output, not counted toward exit 1)",
        "docs/docs/cli-reference.md doctor row ('skipped for that runtime' plus 'Exits 1 when any requested runtime's doctor result is not ok')"
      ],
      "enumeration_method": "Found every lenientSelectors/noMatchingSurface/resolveSurfaceSelectionLenient site with `keryx ctx rg --all`. Only doctor combines a lenient skip with additive `--surface` semantics. Reproduced with the CLI in scratchpad/review310-r5/r-drift."
    },
    "impact": "In r-drift, `install --runtime claude,cursor` is run, then .cursor/hooks.json is corrupted. `doctor --runtime claude,cursor` exits 1 and names three invalid cursor surfaces. `doctor --runtime claude,cursor --surface agents` exits 0 and prints only '· cursor — no matching surface'. The natural follow-up to `install --runtime all --surface agents`, which is `doctor --runtime all --surface agents`, therefore reports a broken cursor, windsurf, gemini or other install as healthy.",
    "suggested_fix": "For doctor, do not early-return under lenient selection. Drop the selectors this runtime does not declare and run the normal full doctor loop. `explicitlySelected` already ignores unknown names, so in practice this means removing the early return. Keep an 'error only if no selected runtime declares any selector' check in handleDoctor, computed from whether `resolveSurfaceSelectionLenient` matched on any runtime. If a per-runtime marker is still wanted, a note such as '· <id> — agents not declared' can sit alongside the normal doctor output instead of replacing it. Add a test with drift on an unmatched runtime under `--runtime all --surface agents` that expects exit 1, and adjust the cli-reference sentence.",
    "evidence": "scratchpad/review310-r5/e2e.out lines 82-106: `doctor --runtime claude,cursor` gives [exit=1] with the cursor orient, security-check-input and security-check-output surfaces invalid ('file is not valid JSON'); `doctor --runtime claude,cursor --surface agents` gives '· cursor — no matching surface' and [exit=0]; `doctor --runtime cursor --surface block` gives [exit=1].",
    "confidence": "high"
  }
]
```
