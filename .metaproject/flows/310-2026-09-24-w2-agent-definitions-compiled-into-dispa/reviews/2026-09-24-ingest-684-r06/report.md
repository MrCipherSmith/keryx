# Review 310 R6: PR #684 (flow 310, W2), final narrow verification round

Scope: fix commit 27fe9bc3 (plus the record commit d3a695cb) on flow/310-w2 (head d3a695cb), in /Users/Goodea/goodea/keryx-ape-310-w2. The review was read-only on the repo. All CLI probes ran in fresh git repos under scratchpad/review310-r6/ (script e2e.sh, output e2e.out).

R5 disposition: **R5-F1 resolved.**

What changed:
- `doctorIntegration` no longer returns early under lenient selection. It records `noMatchingSurface` and then runs the full surface loop.
- `handleDoctor` prints the normal status line and full output for every runtime, and adds an informational "declares none of the requested surface(s)" note where it applies.
- The aggregate "No selected runtime declares surface(s)" error is unchanged. It fires only when every result has `noMatchingSurface`.

Evidence from e2e.out:
- **Original repro (r-drift).** After a claude,cursor install, `.cursor/hooks.json` was corrupted.
  - `doctor --runtime claude,cursor --surface agents` now exits 1 and lists all four invalid cursor surfaces, the same as the run without `--surface`.
  - `doctor --runtime all --surface agents` also exits 1.
  - In the `--json` output, every runtime that lacks agents still has a non-empty `surfaces` list: cursor 4, windsurf 3, gemini-cli 2 and so on.
- **Error rules.**
  - `--runtime all --surface bogus` exits 1 with a single "No selected runtime declares surface(s): bogus" line, in both text and `--json` mode.
  - `--surface agents --surface bogus` on claude,cursor exits 0.
  - A single runtime stays strict: `claude --surface bogus` and `cursor --surface agents` both exit 1 with "unknown surface selector(s)".
  - `claude --surface agents`, before agents was ever installed, still doctors the opt-in surface.
- **Install/uninstall still restrict to the selected surfaces (r-restrict).**
  - `install --runtime claude,cursor --surface agents` writes only `.claude/agents`, creates no `.cursor`, and prints `· cursor — no matching surface`. Dry-run and uninstall dry-run behave the same.
  - `install`/`uninstall --dry-run --runtime claude --surface ctx-guard` touch only ctx-guard.
  - `printNoMatchingSurface` is still used by the install/uninstall reporter.
- **Tests and typecheck.** The requested test set gives 486 pass, 0 fail across 22 files. `tsc --noEmit` is clean.
- **Docs.** The rewritten doctor row in cli-reference is accurate: `--surface` adds to the normal checks and never narrows them, a single runtime is strict, a multi-runtime selection drops unknown selectors without skipping any runtime, the command errors only when no runtime declares a selector, and the exit-1 rules match. One small point: the doc places the "declares none" note only under the all-miss error case, but it also prints for each non-matching runtime when some runtimes do match. That is still accurate and not worth a finding.

No new findings.

```json keryx:findings
[]
```
