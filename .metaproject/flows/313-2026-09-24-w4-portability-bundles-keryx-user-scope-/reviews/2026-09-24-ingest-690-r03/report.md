# Review round 3 (final): PR #690, flow 313 W4 portability

## Scope and method

- **Worktree:** `/Users/Goodea/goodea/keryx-ape-313-w4`, branch `flow/313-w4`, HEAD `c4ad2a60` (checked).
- **What was reviewed:**
  - This attempt's fixes, `cb09b7b2..c4ad2a60` (`pr-690-r3-fixes.diff`).
  - The full PR diff. `pr-690-r3.diff` was empty, so it was regenerated as `review313-r3/pr-690-full.diff` (merge-base `e04715a2..HEAD`).
  - The frozen ACs.
- **How findings were confirmed:**
  - Probes ran against the real modules, or against `bun src/cli.ts` in fresh `git init` projects with a scratch `KERYX_HOME`, on macOS APFS.
  - The pre-fix tree `cb09b7b2` was extracted with `git archive` to `S3/old-cb09`. "fails-on-old" checks copy each new test file there under a new name, run it, and delete it. The copies have been removed.
- **Probe locations:** `S3` below means `/private/tmp/claude-502/-Users-Goodea-goodea-keryx/e4ee6e6a-388e-4015-b287-e00b261e73d6/scratchpad/review313-r3`.

  | Directory | Lane | Probes |
  |---|---|---|
  | `S3/bundle/` | bundle core | `own`, `pdir`, `pid`, `pid2`, `ptar`, `punin`, `pbig`, `pquad*`, `bC`, `p1r2`, `p3r2`, `p7r2`, `p8`, `p10b`, `vk`, `porigin` |
  | `S3/ext/` | external and audit | `pa`, `pb`, `pc`, `pc2`, `pd`, `pf`, `pg`, `pi`, `pj`, `pk`, `pl`, `rexec`, `p9r2`; `old/pl.ts` is the pre-fix comparison |
  | `S3/mem/` | memory and MCP | `p2`, `p3`, `p5`, `p6`, `p7`, `p8`, `p9.sh`, `p10`; `main-e047` is a merge-base copy |
  | `S3/rules/` | rules and integrations | `b1`–`b6` scripts and outputs, `reg1.sh`, `f6-cli.sh`, `f7-distill.sh`, `f15-fence.ts`, `sym1esc`, `r2rerun/optin.ts` |
  | `S3/roundtrip/` | this repo's export and import | `src-proj`, `dst-proj`, `import-1.json`, `probe-secrets.ts`, `REPORT.md` |

- **Two lanes need a caveat:**
  - The ext lane's subagent was stopped before it ran any probes. Every ext verdict below comes from probes I re-ran or wrote myself: `pa`, `pb`, `pc`, `pc2`, `pd`, `pf`, `pg`, `pi`, `pj`, `pk`, `pl`, `rexec` and `p9r2`.
  - I spot-reproduced the bundle, mem and rules majors myself: `own.ts`, `p10.ts`, `p9.sh` and `b1-metarules.sh`.
- **Repo state:** nothing was edited, staged or committed.
  - `git status` shows only the orchestrator's modified `flow.json` and `journal.md`, which were already there at the start.
  - `keryx ctx` wrote logs under the gitignored `.metaproject/data/gdctx/`.

### Suites and tooling

- **Targeted suites:** 3757 pass, 4 skip, 27 fail, across 243 files, in 76 s wall at 582 MB max RSS (`S3/suites.log`). The run adds `src/ctx`, which round 2 did not run.
  - **All 27 failures are environmental.** They are in `src/wiki/{freshness,refresh,source-gate,staleness}` (20), `src/ctx/orient.test.ts` (5), `src/lib/git-hooks.test.ts` (1) and `src/lib/security-pre-push.test.ts` (1).
  - Each one fails at a fixture `git commit`, which the global author-email hook refuses.
  - `orient.test.ts` fails the same 5 tests on `old-cb09`.
- **Typecheck:** `bunx tsc --noEmit -p .` is clean (16.7 s).
- **Lint:** `eslint` on the 48 `src` files this attempt changed exits 0.
- **Test cost:**

  | Suite | Result | Wall | Max RSS |
  |---|---|---|---|
  | `src/bundle` + `src/commands/bundle.test.ts` | 169 pass | 1.5 s | 181 MB |
  | audit, external and governance | 283 pass | 1.7 s | — |
  | `src/memory`, `src/mcp`, `src/wiki` | wiki failures are environmental | 19.9 s | 302 MB |
  | `src/integrations`, `src/rules`, `src/ctx` | 5 environmental failures | 18.3 s | 145 MB |

  - There is no new slow test.
  - There is no dedicated `src/lib/symlink-safety.test.ts`.

### Counts

- **New findings:** 1 blocker, 4 major, 19 minor, 5 info.
- **Round-2 verification (30 findings):** 21 resolved, 9 partial, 0 unresolved.
- **Re-listed below under their original ids:**
  - Two partials are still major: R1-F20 and R2-F5.
  - Seven partials are minor: R1-F13, R2-F3, R2-F6, R2-F10, R2-F12, R2-F15 and R2-F21.

The blocker, R3-F1, was introduced by this attempt's R2-F12 fix. It turns every W8 content check on skill files into a fail-open.

---

## Round-2 verification

- **R1-F1: resolved.**
  - `S3/bundle/p1r2.ts` case 1: B is now `[conflict] (owned-by-other-bundle)`.
  - `own.ts` O1: after `--force`, uninstall of A leaves the file alone and uninstall of B removes it.
  - Test: `plan.test.ts` "R1-F1: … a DIFFERENT bundle owns it -> conflict owned-by-other-bundle". fails-on-old: yes.
  - A case-variant path still dodges the lookup: see R3-F2.
- **R1-F2: resolved.**
  - `S3/ext/pa.ts longs` and `keyonly`: the key and the `ſ` registry are both refused as `path-escape` (not portable). The key cannot be planted, `verify` shows no entries, and scout lists nothing.
  - `pg.ts`: after the key is deleted, the result is `external-imports-key-missing` and the key is not regenerated. An empty key gives `external-imports-key-invalid`.
  - Tests: `external.test.ts` "registry integrity (R1-F2 follow-up)" (7 tests) and `paths.test.ts` "state/** and the legacy … key path are reserved". fails-on-old: yes.
  - A residual DoS through a directory at the registry path is R3-F15; it cannot forge a registry.
- **R1-F5: resolved.** `S3/mem/p3.ts` S1b: a root at mode 0300 gives `incomplete` with `{".","unreadable-folder"}`. Test: `store.test.ts` "R1-F5: a root at mode 0300 …". fails-on-old: yes.
- **R1-F9: resolved, with no regression test.**
  - `S3/bundle/p7r2.ts`: the `index.md` key is refused as `corrupt-ledger`, and the `RULES/A.MD` fold collision is refused.
  - `uninstall.test.ts` is unchanged since cb09 (see R2-F21).
- **R1-F13: partial.**
  - Fixed: all 24 `rexec.ts` shapes are now caught, and the table test fails on old (17 cases).
  - Still open: `S3/ext/pk.ts` imports 15 of 18 schema-valid argv hooks under `--allow-hooks`.
    - Examples: `python3 -c "exec(urlopen(...).read())"`, `node -e "fetch(..).then(eval)"`, `perl -MLWP::Simple`, and `curl -so /tmp/p URL; chmod +x; /tmp/p`.
    - Also: `c''url … | s''h`, `c${X}url`, base64 piped to `sh`, `busybox sh`, `nc -e /bin/sh` and `bash -i >& /dev/tcp/…`.
    - Also: `sh -c "$P"` with the payload in `command.env`.
  - A list of known-bad shapes cannot close this class; see the re-listing below.
- **R1-F17: resolved.**
  - `S3/ext/pf.ts`: an appended line gives `checksum-mismatch`. A symlinked file, a symlinked directory and a symlinked sourceRef each give `symlink-refused`, and scout skips all of them.
  - Test: `external.test.ts` "a symlink added … after acceptance is reported symlink-refused". fails-on-old: yes.
- **R1-F20: partial.**
  - Fixed: markdown-block, the settings-file install and uninstall, and `ensureMetaprojectReference` refuse an escaping link. `settings-file.test.ts` and `agent-entrypoints.test.ts`, fails-on-old: yes.
  - Still open: `rules sync`, `keryx update`, `rules distill`, the OpenCode plugin writer and install-state all write through an escaping `.metaproject/rules`, entrypoints or `.opencode` link.
  - Evidence: `S3/rules/b1-metarules.sh`, which I reproduced: `OUT/rules/claude-md.md`, `OUT/rules/core/*.mdc` and `OUT/entry/index.md` are all written outside the project, with exit 0. See the re-listing below.
- **R1-F22: resolved.**
  - `S3/bundle/p10b.ts`: `rules/ſ.md` is refused as `path-escape`.
  - Tests: the `manifest.test.ts` ASCII case and prefix tests (these pass on old, which already handled ASCII), plus the `paths.test.ts` Unicode tests (fails-on-old: yes).
- **R1-F28: resolved.**
  - The verify-side walk now uses the capped `collectSkillDirectorySnapshot`, which names symlinks, unreadable directories, unreadable files and FIFOs. `pb.ts` shows `perm-dir`, `perm-file` and `fifo`, each rejected with a named reason.
  - The no-final-newline and whitespace-only behaviour is unchanged, but it is now documented at `docs/docs/integrations.md:140-141,259-261`, which the fix brief allowed.
- **R2-F1: resolved.**
  - `S3/bundle/vk.ts`, `p3r2.ts` and `p10b.ts` all refuse. `pid.ts` covers 32 shapes, and no non-ASCII alias reaches a reserved file.
  - Test: `paths.test.ts` "refuses a non-ASCII path segment" (ſ, full-width, NFD, ß, İ) and "validateKindPath itself refuses non-ASCII aliases". fails-on-old: yes (9 of 48).
- **R2-F2: resolved.**
  - `pg.ts` confirms an empty key is refused.
  - The code at `external.ts:185-216` refuses a symlink, a non-regular file, a wrong size, a wrong mode and a wrong uid. The key is created with `wx` and mode 0600, and the MAC uses `timingSafeEqual`.
  - Tests fail on old.
  - Residuals (hardlinks, a symlinked `state/`) are in R3-I3.
- **R2-F3: partial.**
  - Fixed: `p9r2.ts` refuses `argv ["sh","-c","curl … | sh"]` as `bundle-hook-remote-exec`. Test: `hook-audit.e2e.test.ts` "R2-F3 …". fails-on-old: yes.
  - Still open: `command.env`, which the schema allows, is never walked (`index.ts:204-228`). `pk.ts` "env-var-indirection" imports.
- **R2-F4: resolved.**
  - `S3/bundle/pquad.ts`: the 100k-entry archive is refused as `archive-too-large` in 0.43 s at 259 MB. In round 2 it took 95 s.
  - Test: `manifest.test.ts` "R2-F4 …". fails-on-old: yes.
  - The remaining cost of parsing before the cap is R3-F19.
- **R2-F5: partial.**
  - Fixed: CRLF and a lone CR. `S3/mem/p2.ts` shows no leak. The R2-F5 tests fail on old.
  - Still open: a U+2028 or U+2029 inside `Target-Harnesses` still parses as absent.
    - I reproduced `S3/mem/p10.ts`: MCP bound to claude, and unbound, returns the codex-only secrets through `memory.search`, `wiki.ask`, resources list and resources read.
    - CLI handoff from codex to claude gives `complete`, exit 0, with `target_harnesses: null`.
  - This is the same class. See the re-listing below.
- **R2-F6: partial.**
  - Fixed: a real install with an unsafe rule name exits 0 as `installed`, with a warning, and install state is recorded (`S3/rules/f6-cli.sh`). The tests fail on old.
  - Still open:
    - `--dry-run` gives `warnings: []`, so it never mentions the skip.
    - `integrations doctor` straight after that install reports `invalid` and exits 1, because `surfaces-rules.ts:98-102` still merges `skipped` into problems.
- **R2-F7: resolved.**
  - `S3/rules/f7-distill.sh` A and B: B is a copy of this repo's own `CLAUDE.md`, `AGENTS.md` and `.metaproject`. Every managed block stays 1/1 through sync, distill and sync, and is 0/0 after uninstall.
  - The R2-F7 distill tests (3) fail on old.
- **R2-F8: resolved.**
  - `S3/rules/reg1.sh`: `CLAUDE.md -> AGENTS.md`, `GEMINI.md -> AGENTS.md` and `.github/copilot-instructions.md -> ../AGENTS.md`. Init, default install, `--surface rules`, doctor and uninstall all exit 0 on all 11 runtimes, and `AGENTS.md` is byte-identical afterwards.
  - The F8 tests (4) fail on old.
  - A leftover half-applied install when the link escapes is R3-F12.
- **R2-F9: resolved.**
  - `S3/ext/pd.ts`: 15 of 15 trials give `codes=0,0 verifyOk=true recorded=2`.
  - The `external.test.ts` concurrency test fails on old.
  - A stale lock is R3-F23.
- **R2-F10: partial.**
  - Fixed: `pc.ts` catches zero-width characters, the soft hyphen, Cyrillic homoglyphs, full-width forms, NBSP, NFD and HTML comments. `pb.ts` rejects the `byp-*` fixtures. The R2-F10 tests fail on old.
  - Still open: `S3/ext/pc2.ts`. Mathematical-bold letters and Unicode tag characters evade both the auto-run and the injection checks. Bidi controls, combining marks outside U+0300–036F, U+2064 and double-encoded entities evade the auto-run check.
- **R2-F11: resolved.** `S3/ext/pi.ts`: plain, `\n`-escaped and `\u`-escaped actions are all refused as `bundle-auto-run-directive`.
- **R2-F12: partial, and the fix introduced R3-F1.**
  - Fixed: a PNG asset is accepted (`pb.ts` fp-png), and fenced `curl | sh` in docs is medium (fp-curl-doc is accepted).
  - Still open:
    - `pj.ts` still flags prose `curl … | python3 -m json.tool` and `curl … | node -e 'console.log(1)'` as high.
    - UTF-16 text is still `audit-not-applicable`.
    - The allowlist accepts any text that starts with a magic prefix (R3-F1).
    - The fence downgrade can be forced by an unterminated fence (R3-F6).
- **R2-F13: resolved.**
  - `pg.ts`: an unreadable file rejects only its own candidate (`unreadable-file`), and the other candidate is recorded.
  - `pb.ts`: `unreadable-dir`, `unreadable-file` and `special-file-refused`.
  - The test fails on old.
- **R2-F14: resolved.**
  - `S3/mem/p3.ts` S10 reports `misplaced-harness-header`. `p5.ts` shows the fenced, indented and in-fence `##` variants all hidden.
  - The tests fail on old.
- **R2-F15: partial.**
  - Fixed in agent-entrypoints: markers match as whole lines, errors name the file, and there is a pre-scaffold check. The F15 tests fail on old.
  - Still open:
    - `computeFencedRanges` is not reused. `S3/rules/f15-fence.ts` B: a fenced example pair gets replaced.
    - `distill.ts` still matches markers as substrings, which loses data (R3-F4).
- **R2-F16: resolved, with no regression test.**
  - `S3/bundle/bC.ts`: the failure message prints.
  - After `rm CLAUDE.md`, the re-import (`unchanged: 1`) re-renders `claude: installed`, exit 0, and the block is present.
- **R2-F17: resolved.** The internal wording is removed, `integrations.md:236-270` documents the caveats, skips and symlink rule, and the `--surface` help is corrected.
- **R2-F18: resolved.** `export --kind hook-config,memory-entry` gives `empty-bundle`, exit 1, and no file. The test fails on old.
- **R2-F19: resolved.**
  - `plan.ts:91-100` and `:378-380`.
  - "an old bundle's TTL floors to importDay + 30d" fails on old.
  - The identical-a-day-later test guards the side effect of the fix.
- **R2-F20: resolved.**
  - `S3/bundle/p8.ts`: a mode-000 user file is refused as `target-unreadable` at inspect and import, and its bytes survive.
  - The unit tests cover `readTargetFile` only; there is none at the call sites.
  - An uninstall misreport caused by the new early return is R3-F17.
- **R2-F21: partial.**
  - Added: R1-F23, R1-F24, the Unicode refusal, R2-F4, R2-F18 and R2-F19.
  - Still missing:
    - R1-F12 (content validation and agent-origin rewrite; the behaviour is correct per `S3/ext/p9r2.ts`);
    - R1-F9 uninstall kind shape and fold;
    - R2-F16 render retry;
    - R2-F20 at plan, apply and uninstall;
    - the negative `readOctal`;
    - a negative binary-allowlist case (R3-F1).
  - The two new "memory/'s parent chain contains a symlink" tests pass on cb09, so they do not discriminate.

### Round-2 info items

- **R2-I1:**
  - `visibility ?? true` is kept, and documented as evaluated and not applied.
  - The private-dir check never fires in production, because `root` is `~/.keryx` itself (`S3/mem/p8.ts`).
  - The `sac.review` dedup still reads unfiltered (`src/sac/decision-dedup.ts:195`).
  - The whitespace mismatch now has an impact: R3-F8.
- **R2-I2:** the MAC now covers `schemaVersion` and `version`. But `version` is stored only inside the registry, so it does not detect a rollback, although the comment at `external.ts:69-78` says it does.
- **R2-I3:** unchanged: the TOCTOU window, `distill.ts:262` writing before the check at `:263`, and harmless exotic separators.
- **R2-I4:**
  - Done: a negative octal is folded to 0 (no test).
  - Not done:
    - inspect forcing `allowHooks` (now documented; `p9r2.ts` inspect reports `ok` for a hooks bundle that import refuses);
    - the extra copy in `parseUstar`;
    - the bomb reported as `archive-invalid`;
    - `writeAppliedState` following a symlinked `data/bundles`;
    - `resolveProjectRoot` stopping at `~/.git`.

---

## Class closure (fix brief `w4-fix2.md`)

### 1. Path identity (portable-ASCII segments): closed for Unicode and case aliases of reserved files; open narrowly

- **What holds:**
  - Every entry point enforces `^[A-Za-z0-9][A-Za-z0-9._-]*$`: `normalizeBundlePath`, `validateKindPath` itself, manifest duplicates and prefixes (lower-cased), uninstall ledger keys (normalized, kind shape, global fold) and export source names.
  - `state/**` and the legacy key path are reserved.
- **Bypass attempts** (`S3/bundle/pid.ts`, `pid2.ts`, `pdir.ts`, `ptar.ts`, `own.ts`):

  | Attempt | Result |
  |---|---|
  | `..`, `-x`, `.gitkeep`, `./`, `a/../`, `SKILL.MD`, `HOOKS.json`, `Data/Learning/` | refused |
  | `skills/external-imports.json/SKILL.md` | **accepted**: a directory at the registry path, which is a DoS (R3-F15) |
  | a case-variant manifest path against another bundle's ledger key | **accepted**: a second, colliding ledger key (R3-F2) |
  | symlink, hardlink, GNU `L` and pax tar members | refused |
  | unlisted `rules/A.md` or `rules/ſ.md` | refused |
  | `SKILL.md.`, `external-imports.json.`, `CON/` | accepted; Windows-only aliases (R3-I1) |
  | a hardlink or symlink target onto a reserved file | not reachable: apply uses temp file plus rename, and symlinked chains are refused |

- **Regressions:**
  - Export now refuses the whole bundle on one non-portable name (R3-F21). `rules/Code Style.md` round-tripped on cb09.
  - This repo itself has no non-portable names in `.metaproject/{skills,rules,project-skills,memory,wiki}` (`S3/roundtrip/badsegs2.txt` is empty; `S3/mem/p9.sh` lists 20 memory files, none failing).
  - The 222-entry project export of this repo exports with zero skips.

### 2. Trust in attacker-writable state: closed for bundle writers

- The key lives under reserved `state/`, is checked strictly, and is not regenerated when missing.
- **Bypass attempts:**
  - Plant the key via a bundle, at the legacy or `ſ` path (`pa.ts longs`, `keyonly`): refused.
  - Delete the key with a registry present (`pg.ts`): `external-imports-key-missing`, no regeneration.
  - An empty key with a MAC made from the empty key (`pg.ts`): `external-imports-key-invalid`.
  - A bundle directory at `skills/external-imports.json/` (`pdir.ts`): cannot forge a registry, but blocks imports (R3-F15).
  - A stale lock file (`S3/ext/w/pg`, lock written by hand): every import is refused permanently (R3-F23).
- **Residuals:** a hardlinked key and a symlinked `~/.keryx/state` directory are accepted (code, `external.ts:185-216,239`). Only a local user can create them (R3-I3).

### 3. Fail-open parsing: OPEN

- **Memory:** CRLF and CR are fixed, and misplaced headers are hidden.
  - U+2028/U+2029 in a header still fails open (`S3/mem/p10.ts`; R2-F5 re-listed).
  - Near-miss keys such as `Target-Harness`, `Target Harnesses`, a full-width colon or a ZWSP in the key parse as absent (`p5.ts`; R3-F7).
  - A guard/parser whitespace mismatch lets `memory.propose` write entries that wedge every handoff (`p7.ts`; R3-F8).
  - A FIFO or directory named `*.md` hangs or breaks MCP resources list (`p6.ts`; R3-F9).
  - The scaffold `index.md` and `templates/entry.md` make every handoff `incomplete` (R3-F3).
- **Hook argv:** argv is walked, but `command.env` is not (`pk.ts`). There are 15 of 18 denylist misses (R1-F13).
- **Audit binary allowlist:** a magic prefix plus one invalid byte skips every text check (`S3/ext/pl.ts`; R3-F1).
- **Fence downgrade:** can be forced by an unterminated, `~~~` or deeply indented fence (`pl.ts`; R3-F6).

### 4. Symlink policy: OPEN

- **The helper itself is correct** (`S3/rules/b4-helper.ts`) for nested chains, a symlinked root, a case-variant root, cycles and dangling links. Cycles are refused as "broken symlink", so symlink cycles are NOT accepted.
- **But only about 4 of 12 writer sites use it.**
- **Bypass attempts:**
  - `.metaproject/rules -> outside`: `rules sync`, `update` and `distill` write repo-controlled text outside the project (`b1-metarules.sh`, reproduced; R1-F20 re-listed).
  - A dangling escaping `Claude.md` link: `keryx init` writes the template outside before refusing (`b2-dangling.sh`; R3-F11).
  - Cycles or dangling links on the rules-sync path: raw ENOENT/ELOOP crash (R3-F14).
  - `GEMINI.md -> .git/config` and `CLAUDE.md -> .git/hooks/pre-commit`: accepted, corrupting git config or hooks (`b3-gitlinks.sh`; R3-F13).
  - `.opencode -> outside` and `.metaproject/data/integrations -> outside`: the plugin and install state are written outside (`b5-otherwriters.sh`).
  - Lexical `..` without a symlink: the helper returns ok. No current caller passes such a path (R3-I4).

### 5. Ownership: OPEN

- **What holds:** a same-key takeover needs `--force`, and the old owner's uninstall leaves the file alone. `--force RULES/X.md` and a bare `--force` fail closed.
- **Bypass attempts:**
  - A case-variant path (O2, O3, O4) bypasses the check, and uninstall then fails for every bundle in the scope (R3-F2).
  - A spoofed bundle id (O5) silently updates another bundle's files (R3-F18).
  - A forced transfer is never reported outside `--dry-run` (R3-F16).
  - A forged ledger record (O6) needs local write access, so it is info.

---

## Regressions and cross-cutting checks

- **This repo's project-scope round trip** (`S3/roundtrip/`):
  - Export: 222 entries, zero skips.
  - Import into a fresh project is refused whole as `audit-failed`, with 4 hits on 3 files. All of them are false positives:
    - the AWS placeholder `AKIAIOSFODNN7EXAMPLE` in `rules/core/security-baseline.mdc`;
    - a backticked `?token=` in a memory entry;
    - injection-defense text in `review-pr-feedback/SKILL.md`, which the skill uses to teach defence against it.
  - The pre-fix CLI (`old-cb09`) refuses the same bundle with the same ids, so this attempt did not cause it (R3-F5).
  - With those three files excluded, the flow works: import, inspect identical, re-import unchanged, and uninstall. Uninstall leaves empty directories behind (R3-F24).
- **Memory in this repo and in a fresh `keryx init`:** the strict scan returns `incomplete` because of the two scaffold files, so handoff exits 1 in every initialized project (R3-F3, reproduced).
- **In-root symlink layouts:** no regression (`S3/rules/reg1.sh`).
- **Performance:**
  - The inspect DoS is fixed.
  - A 1.6M-entry manifest-only archive (4.6 MB) still takes 6 s at 1.68 GB before it is refused (R3-F19).
  - Re-inspecting a 9,999-entry bundle takes 39 s, because the ledger is re-read for every entry. That predates round 3 (R3-F20).
  - A valid bundle of exactly 10,000 entries cannot be opened (R3-F22).

---

## New findings

### Blocker

#### R3-F1: blocker: the binary-asset allowlist trusts a magic prefix, so any skill file (script, markdown) starting with `GIF89a`/`%PDF`/PNG magic plus one invalid UTF-8 byte skips every W8 content check
- **File:** `src/security/audit-harness/index.ts:158-169` (`knownBinaryAssetType`) and `:366-372`. Consumed at `src/gdskills/governance/scout.ts` (`auditSkillSnapshot` ignores the note) and `src/bundle/audit.ts:71`.
- **Mechanism:**
  - A file that fails `isTextContent` but starts with an allowlisted magic is recorded as `scanned`, with a note that never fails the gate.
  - The file name and extension are ignored, and the GIF and PDF magics are plain ASCII.
- **Impact:** a remote-exec script or a prompt-injection reference file passes both external vetting (AC9) and bundle import (AC12) with zero findings.
  - `S3/ext/pl.ts`, all on HEAD:
    - `scripts/setup.sh` = `GIF89a;curl … | sh` plus `\xff`: VET accepted, `pass 0`, IMPORTED.
    - `reference.md` = `%PDF-1.4\n` plus an injection or auto-run directive plus `\xff`: accepted, IMPORTED.
    - `notes.md` with a PNG magic prefix plus a directive: accepted, IMPORTED.
  - The same script without the invalid byte is refused, which shows the only thing skipping the checks is the byte that makes the file "binary".
  - On `old-cb09` (`S3/ext/old/pl.ts`) all three are refused (`audit-not-applicable` / `audit-incomplete`). This is a regression introduced by this attempt's R2-F12 fix.
  - A `.sh` file beginning `GIF89a;` still runs its second command under `sh`. A markdown file with a magic prefix is still read as text by an agent.
- **Suggested fix:**
  - Accept an allowlisted binary only when the extension matches the detected type (`.png/.jpg/.gif/.webp/.ico/.pdf/.woff/.woff2`) and the type is structurally valid, not just its first bytes.
  - Refuse any allowlisted-magic file with a script, markdown, text or JSON name, or with no extension.
  - Add negative tests: a GIF-magic `.sh`, a PDF-magic `.md` and a PNG-magic `.md`.
- **Confidence:** high.
- **class_scope:**
  - Sites: `index.ts:158-169`, `:366-372`; `scout.ts` skill snapshot audit (the note is ignored); `bundle/audit.ts:71` (only the surface error is checked).
  - Enumeration: read every `knownBinaryAssetType` and `isTextContent` caller, then ran `pl.ts` through both `vetExternalCatalog` and the CLI `bundle import`.

### Majors

#### R3-F2: major: a case-variant path dodges the ownership lookup, and the resulting colliding ledger keys block uninstall for every bundle in the scope
- **File:** `src/bundle/plan.ts:391` (the exact-key `entries[targetRelative]` lookup), `:395`; `apply.ts:205-213`; `uninstall.ts:89-103`.
- **Impact:** bundle B shipping `rules/X.md`, when A owns `rules/x.md`:
  - It plans `unmanaged-differs`, not `owned-by-other-bundle`.
  - If A's file is absent, it plans `new` with no `--force` needed.
  - Apply records both keys. After that, `bundle uninstall` of A and of B both refuse `corrupt-ledger` until someone edits the ledger by hand, and A's other files are stranded.
  - An ordinary same-bundle case rename reaches the same state.
- **Suggested fix:**
  - Build a `caseFold(key) -> key` index per ledger and look up through it.
  - Treat a fold hit with a different original key as that record: `owned-by-other-bundle`, or a rename of this bundle's own record.
  - At apply, replace the old-cased key.
- **Evidence:** `S3/bundle/own.ts` (reproduced):
  - O2: `ledger {"rules/X.md":"bundle-b","rules/x.md":"bundle-a"}`, and both uninstalls print `corrupt-ledger … collide`.
  - O3: `import B (no force): 0`, and `rules/keep.md` is stranded.
- **Confidence:** high.
- **class_scope:**
  - Sites: `plan.ts:391,395`; `apply.ts:205-213` and the ledger writes for identical entries; `uninstall.ts:89-103,111`.
  - Enumeration: read every `state.entries[...]` read and write in `src/bundle/`.

#### R3-F3: major: the `keryx init` memory scaffold makes every `memory handoff` `incomplete` (exit 1), in every initialized project including this repo
- **File:** `src/memory/store.ts:337-356` (the unexpected-entry rule); the scaffold comes from `src/memory/templates.ts` (`renderMemoryIndexScaffold`, `renderMemoryEntryTemplate`).
- **Impact:**
  - `memory/index.md` and `memory/templates/entry.md` are always flagged `unexpected-entry`.
  - CLI and MCP handoff never return `complete`, so AC7's `complete` result is unreachable and the exit code means nothing.
  - This came in with the round-1 R1-F27 fix, and was missed in round 2.
- **Suggested fix:** allowlist the scaffold files Keryx itself writes, and document the allowlist. Add a handoff test on an init-scaffolded root that expects `complete`.
- **Evidence:** `S3/mem/p9.sh`, reproduced on a copy of this repo's memory: `handoff claude->codex exit=1 {"status":"incomplete",…"index.md" unexpected-entry,"templates/entry.md" unexpected-entry}`. A fresh init (`S3/mem/init-proj`) behaves the same.
- **Confidence:** high.
- **class_scope:**
  - Sites: `store.ts:337-356`; callers `src/commands/memory.ts:550` and `src/memory/service.ts:263`.
  - Enumeration: read the strict scan and its two callers; diffed the output against a fresh `keryx init` scaffold.

#### R3-F4: major: `rules distill` still matches markers as substrings, so an inline prose mention of `<!-- keryx:index -->` above the real block silently deletes the human sections in between
- **File:** `src/rules/distill.ts:113-123` and `:135-147`.
- **Impact:** data loss, with distill exiting 0. The following `rules sync` overwrites the only copy. This is the R2-F15 class, left open in distill. It is already present on `old-cb09` (`S3/rules/b6-old.sh`).
- **Suggested fix:** use the whole-line `indexOfMarkerLine` together with `computeFencedRanges` in both distill matchers, and refuse when markers are ambiguous.
- **Evidence:** `S3/rules/b6-distill-prose.sh` and `b6.out`: `KEEP-ME-1` and `KEEP-ME-2` are absent after distill then sync.
- **Confidence:** high.
- **class_scope:**
  - Sites: `distill.ts:113-123,135-147`; `agent-entrypoints.ts:134-142` (whole-line matching, but not fence-aware).
  - Enumeration: `keryx ctx rg` for `indexOf(` and the marker constants in `src/rules` and `src/integrations/markdown-block.ts`.

#### R3-F5: major: this repo's own project-scope bundle cannot be imported: W8 detector false positives refuse all 222 entries
- **File:** `src/security/detect/secrets.ts` and `src/security/detect/injection.ts`, as wired into `src/security/audit-harness/index.ts:412-475`.
- **Flagged content:**
  - `.metaproject/rules/core/security-baseline.mdc:29`: the placeholder `AKIAIOSFODNN7EXAMPLE`.
  - `.metaproject/memory/known-mistakes/gdctx-redaction-ignores-trust-tag.md`: a backticked `?token=`.
  - `.metaproject/skills/gdskills/review/review-pr-feedback/SKILL.md`: injection-defense prose, which is flagged twice.
- **Impact:**
  - Export and import of a project's own `.metaproject/`, the main W4 portability workflow, fails closed on ordinary security documentation. Nothing is written.
  - This attempt did not cause it: `old-cb09` refuses the same bundle.
  - AC12's fail-closed rule is met to the letter. Whether a suppression works on the import path was not checked.
- **Suggested fix:**
  - Exempt the documented AWS `…EXAMPLE` keys.
  - Require a value after `?token=`.
  - Downgrade injection phrases that are quoted or meta-discussed, or inside fences.
  - Document the suppression path for `bundle import`.
- **Evidence:** `S3/roundtrip/import-1.json`, `probe-secrets.ts`/`.out`, and `S3/roundtrip/oldcheck` (same ids on the pre-fix CLI).
- **Confidence:** high.
- **class_scope:**
  - Sites: the secret detector (AWS key and URL-query patterns), the injection detector (ignore-instructions), and the `imported-bundles` audit path.
  - Enumeration: a full export and import of this repo; every refusal id mapped to its detector rule.

### Minors

- **R3-F6: fence-based downgrade can be forced.**
  - File: `src/security/audit-harness/checks.ts:647-671,681`.
  - An unterminated fence, a `~~~` fence or an 8-space-indented fence downgrades remote-exec text to medium, so it is accepted.
  - Evidence: `S3/ext/pl.ts` fence-unterminated, fence-tilde-unterminated and fence-deep-indent: all accepted and imported. On old they are refused.
  - Fix: downgrade only inside properly closed CommonMark fences indented at most 3 spaces.
- **R3-F7: near-miss memory header keys parse as absent.**
  - File: `src/memory/store.ts:384`.
  - `Target-Harness`, `Target Harnesses`, `Target_Harnesses`, a full-width colon, a ZWSP inside the key and a U+2010 hyphen all leave the entry visible to all, with no problem raised.
  - Evidence: `S3/mem/p5.ts`.
  - Fix: after NFKC and stripping ignorable characters, loose-match header keys, and treat a non-exact match as invalid (hidden, with a problem).
- **R3-F8: guard/parser whitespace mismatch lets `memory.propose` poison handoff.**
  - File: guard `src/memory/templates.ts:22` and `src/mcp/tools.ts:78` use `[ \t]*`; the parser `store.ts:384` uses `\s*`.
  - An MCP harness can write proposals with an NBSP, VT, FF, BOM or U+3000 before `Target-Harnesses:`. After that, every handoff is `incomplete`.
  - Evidence: `S3/mem/p7.ts`.
  - Fix: use one whitespace class for both, and share the test fixtures.
- **R3-F9: MCP resources list hangs on a FIFO, or throws EISDIR on a directory, named `*.md`.**
  - File: `src/memory/store.ts:75-81` (`collectEntries` reads without `lstat`), reached from `src/mcp/resources.ts:163`.
  - Main lists fine in both cases.
  - Evidence: `S3/mem/p6.ts` against `main-e047`.
  - Fix: skip anything that is not a regular file, using `lstat`.
- **R3-F10: the lenient memory path follows symlinks; the strict scan refuses them.**
  - File: `store.ts:75-81`.
  - A `lessons/link.md -> /outside` is served through `memory.search`, `wiki.ask` and MCP. This is already present on main.
  - Evidence: `S3/mem/p6.ts`.
  - Fix: the same `lstat` check as R3-F9.
- **R3-F11: `writeTextIfMissing` writes through a dangling escaping link before the check.**
  - File: `src/rules/agent-entrypoints.ts:57`, via `:221` and `:289-294`; the check is at `:69-74`.
  - `keryx init` creates the template outside the root, then refuses.
  - Evidence: `S3/rules/b2-dangling.sh` case A.
- **R3-F12: an install is half-applied when a later surface refuses an escaping link.**
  - File: `src/integrations/installer.ts:418`; the custom surfaces run at `:466`.
  - `.gemini/settings.json` and its install state are written, then the command exits 1.
  - Evidence: `S3/rules/sym1esc`.
  - Fix: check every selected target before the first write.
- **R3-F13: in-root links into `.git/`, or onto another harness's managed file, are accepted.**
  - File: `src/lib/symlink-safety.ts:67-71`.
  - `GEMINI.md -> .git/config` corrupts the config (git exits 128). `CLAUDE.md -> .git/hooks/pre-commit` appends to the hook, which breaks commits; nothing is executed.
  - Evidence: `S3/rules/b3-gitlinks.sh`.
  - Fix: refuse real paths under `<root>/.git/`, and any other surface's settings file.
- **R3-F14: dangling or cyclic entrypoint links crash with a raw ENOENT/ELOOP.**
  - File: `src/rules/agent-entrypoints.ts:207`.
  - The error has no named reason. `CLAUDE.md -> AGENTS.md` created before `AGENTS.md` exists crashes `init`.
  - Evidence: `S3/rules/b2-dangling.sh` B and C, and `dang-k`.
- **R3-F15: reserved files are matched only as exact paths.**
  - File: `src/bundle/paths.ts:153,170-174`.
  - `skills/external-imports.json/SKILL.md` creates a directory at the registry path. After that, `import --external` and `verify --external-imports` exit 1 with EISDIR. Recoverable with `bundle uninstall`.
  - Evidence: `S3/bundle/pdir.ts`.
  - Fix: reserve each exact name as a directory prefix too.
- **R3-F16: a forced ownership transfer is not reported.**
  - File: `src/commands/bundle.ts:384-403,546`; `docs/docs/cli-reference.md:2120` claims the reason is printed.
  - Only `--dry-run` shows `owned-by-other-bundle`.
  - Evidence: `S3/bundle/own.out` O1 and O1j.
- **R3-F17: uninstall deletes as it walks, so a later refusal reports `removed: []` for files already deleted.**
  - File: `src/bundle/uninstall.ts:110-171`; the new early return is at `:150`.
  - Evidence: `S3/bundle/punin.ts`.
  - Fix: validate every record first, then unlink in a second pass.
- **R3-F18: ownership is keyed on a self-declared bundle id.**
  - File: `src/bundle/plan.ts:395`.
  - A bundle declaring another's id, or reusing `--id` across projects, silently updates the owner's files with exit 0. The audit still runs.
  - Evidence: `own.ts` O5.
  - Fix: record provenance in the ledger, and conflict when the provenance differs.
- **R3-F19: the entry cap runs after the full JSON parse and schema validation.**
  - File: `src/bundle/manifest.ts:22-36`, before `:60`.
  - A 4.6 MB manifest-only archive takes 6 s at 1.68 GB before it is refused.
  - Evidence: `S3/bundle/pquad3.ts`, `pquad2.ts`.
  - Fix: cap the size of `bundle.json` in the reader, and check the length before the schema.
- **R3-F20: plan re-reads the ledger for every entry.**
  - File: `src/bundle/plan.ts:385-386`.
  - Re-inspecting or re-importing 9,999 entries takes about 39 s (also on cb09).
  - Evidence: `S3/bundle/pbig.ts`.
  - Fix: read once per scope, and use a Set in `commands/bundle.ts:366-368`.
- **R3-F21: export refuses the whole bundle on one non-portable source name.**
  - File: `src/bundle/export.ts:403-414`; the walk that picks up dotfiles is at `:179-200`.
  - `rules/Code Style.md`, a non-ASCII name or `.gitkeep` aborts everything. `rules/Code Style.md` round-tripped on cb09.
  - Evidence: `S3/bundle/w/exp-*`, `S3/roundtrip/export-user.json`.
  - Fix: skip with a named reason into `skipped`, or document the restriction.
- **R3-F22: the archive cap counts `bundle.json`, but the manifest cap does not.**
  - File: `src/bundle/archive.ts:275-277` vs `manifest.ts:60`.
  - A valid 10,000-entry bundle cannot be opened.
  - Evidence: `S3/bundle/pbig.ts`.
- **R3-F23: a stale registry lock blocks external imports permanently.**
  - File: `src/bundle/external.ts:591-610`.
  - After a crash or kill, every `import --external` is refused `external-imports-locked`. The pid written into the lock is never checked, and no recovery is documented.
  - Evidence: a hand-written lock in `S3/ext/w/pg` gives "held by another process; timed out after 3000ms".
  - Fix: break a lock whose pid is dead, and name the recovery step in the message.
- **R3-F24: `bundle uninstall` leaves empty directories.**
  - `git status` differs from the pre-import snapshot.
  - Evidence: `S3/roundtrip/dst-pre-status.txt` vs `dst-post-status.txt`.
  - Fix: prune empty ancestor directories under the scope root.

### Info

- **R3-I1:** trailing-dot segments and Windows device names still count as portable (`paths.ts:63`: `SKILL.md.`, `external-imports.json.`, `CON/`). The fix brief said trailing dots were rejected "by construction"; they are not. This only matters on Windows, where support is best-effort.
- **R3-I2:** a symlink tar member whose name ends in `/` is treated as a directory. `writeAppliedState` follows a symlinked `data/bundles`. There is no ENAMETOOLONG refusal (only reachable through the in-memory API).
- **R3-I3:** the key check ignores a hardlinked key and a symlinked `~/.keryx/state` (`external.ts:185-216,239`). The registry `version` counter does not detect rollback, although its comment claims replay protection (`:69-78`).
- **R3-I4:** `refuseEscapingSymlink` accepts lexical `..` escapes and cannot see hardlinks (`symlink-safety.ts:49-52`). No current caller passes `..`. `src/agents/export.ts:148-163` uses its own, stricter symlink policy.
- **R3-I5:** the external staging case-collision check (`scout.ts:760-770`) does not fold `ſ`. Not reproduced: it would need a catalog on a case-sensitive volume. A ZWJ joining two words ("automatically‍execute") evades the auto-run check. MCP handoff problem lists name the file paths of entries restricted to other harnesses (`S3/mem/p2b.ts`).

---

```json keryx:findings
[
{"id":"R3-F1","severity":"blocker","title":"binary-asset allowlist trusts a magic prefix: GIF/PDF/PNG-prefixed scripts and markdown with one invalid byte skip every W8 content check","file":"src/security/audit-harness/index.ts","line":158,"class":"fail-open parsing (audit coverage)","impact":"remote-exec scripts and prompt-injection reference files pass external vetting (AC9) and bundle import (AC12) with zero findings; regression introduced by the R2-F12 fix (old-cb09 refuses all three)","suggested_fix":"require extension to match detected type plus structural validity; refuse allowlisted magic on script/markdown/text/JSON/extensionless names; add negative tests","evidence":"S3/ext/pl.ts: gif-magic-script, pdf-magic-md, png-magic-md VET accepted pass 0 and IMPORTED; same script without the invalid byte refused; S3/ext/old/pl.ts all refused on cb09","confidence":"high","class_scope":{"sites":["src/security/audit-harness/index.ts:158-169","src/security/audit-harness/index.ts:366-372","src/gdskills/governance/scout.ts auditSkillSnapshot (ignores coverage note)","src/bundle/audit.ts:71 (only surface error checked)"],"enumeration_method":"read every knownBinaryAssetType/isTextContent caller; ran pl.ts through vetExternalCatalog and CLI bundle import on HEAD and cb09"}},
{"id":"R3-F2","severity":"major","title":"case-variant path dodges the ownership lookup and plants colliding ledger keys that block uninstall for every bundle in the scope","file":"src/bundle/plan.ts","line":391,"class":"ownership / path identity (ledger keys not canonicalised at plan/apply)","impact":"bundle B's rules/X.md vs A's rules/x.md plans unmanaged-differs, or new without --force if absent; both keys recorded; all uninstalls refuse corrupt-ledger; A's other files stranded","suggested_fix":"fold-indexed ledger lookup; treat fold hit as the record (owned-by-other-bundle or own rename); replace old-cased key at apply","evidence":"S3/bundle/own.ts O2/O3/O4 (reproduced): ledger {rules/X.md:bundle-b, rules/x.md:bundle-a}; both uninstalls corrupt-ledger; O3 import without force exit 0","confidence":"high","class_scope":{"sites":["src/bundle/plan.ts:391","src/bundle/plan.ts:395","src/bundle/apply.ts:205-213","src/bundle/uninstall.ts:89-103","src/bundle/uninstall.ts:111"],"enumeration_method":"read every state.entries[...] read/write in src/bundle"}},
{"id":"R3-F3","severity":"major","title":"keryx init memory scaffold (index.md, templates/entry.md) makes every memory handoff incomplete, exit 1","file":"src/memory/store.ts","line":337,"class":"over-broad fail-closed rule","impact":"AC7 complete is unreachable in any initialized project including this repo; handoff exit code meaningless","suggested_fix":"allowlist Keryx-written scaffold files; handoff test on an init-scaffolded root expecting complete","evidence":"S3/mem/p9.sh (reproduced) on a copy of this repo's memory: incomplete with index.md and templates/entry.md unexpected-entry; S3/mem/init-proj same; same on old-cb09","confidence":"high","class_scope":{"sites":["src/memory/store.ts:337-356","src/commands/memory.ts:550","src/memory/service.ts:263","src/memory/templates.ts renderMemoryIndexScaffold/renderMemoryEntryTemplate"],"enumeration_method":"read strict scan and its two callers; compared with fresh keryx init output"}},
{"id":"R3-F4","severity":"major","title":"rules distill matches markers as substrings; a prose mention of <!-- keryx:index --> deletes human sections silently","file":"src/rules/distill.ts","line":113,"class":"marker matching (R2-F15 class residual)","impact":"silent data loss with exit 0; following rules sync overwrites the only copy","suggested_fix":"whole-line marker matching plus computeFencedRanges in both distill matchers; refuse ambiguous markers","evidence":"S3/rules/b6-distill-prose.sh, b6.out: KEEP-ME-1/2 gone after distill+sync; S3/rules/b6-old.sh same on cb09","confidence":"high","class_scope":{"sites":["src/rules/distill.ts:113-123","src/rules/distill.ts:135-147","src/rules/agent-entrypoints.ts:134-142"],"enumeration_method":"keryx ctx rg indexOf( and marker constants across src/rules and src/integrations/markdown-block.ts"}},
{"id":"R3-F5","severity":"major","title":"this repo's own project-scope bundle cannot be imported: W8 detector false positives refuse all 222 entries","file":"src/security/audit-harness/index.ts","line":412,"class":"audit precision on legitimate content","impact":"the core W4 portability workflow fails closed on ordinary security documentation (AWS EXAMPLE key, backticked ?token=, injection-defense prose); not caused by this attempt (cb09 identical)","suggested_fix":"exempt AWS ...EXAMPLE keys; require a value after ?token=; downgrade quoted/meta-discussed/fenced injection phrases; document suppression for bundle import","evidence":"S3/roundtrip/import-1.json (audit-failed, 4 ids on 3 files); probe-secrets.out; S3/roundtrip/oldcheck same ids on old CLI","confidence":"high","class_scope":{"sites":["src/security/detect/secrets.ts aws-access-key, url-sensitive-query","src/security/detect/injection.ts ignore-instructions","src/security/audit-harness/index.ts:412-475"],"enumeration_method":"full export/import round trip of this repo; each refusal id mapped to its detector rule"}},
{"id":"R3-F6","severity":"minor","title":"fence-based remote-exec downgrade can be forced by unterminated, ~~~ or deeply indented fences","file":"src/security/audit-harness/checks.ts","line":647,"class":"fail-open parsing","impact":"remote-exec instructions in SKILL.md imported at medium","suggested_fix":"downgrade only inside closed CommonMark fences indented <=3 spaces","evidence":"S3/ext/pl.ts fence-unterminated/tilde/deep-indent accepted+imported; refused on cb09","confidence":"high"},
{"id":"R3-F7","severity":"minor","title":"near-miss memory header keys parse as absent (entry visible to all, no problem)","file":"src/memory/store.ts","line":384,"class":"fail-open parsing","impact":"intended restriction silently lost","suggested_fix":"NFKC + strip ignorables, loose-match keys, non-exact match = invalid","evidence":"S3/mem/p5.ts singular-key, space-key, underscore-key, fullwidth-colon, zwsp-key, u2010-hyphen-key","confidence":"high"},
{"id":"R3-F8","severity":"minor","title":"guard/parser whitespace mismatch lets memory.propose write entries that wedge every handoff","file":"src/memory/templates.ts","line":22,"class":"fail-open parsing","impact":"any MCP harness can make handoff incomplete until a human deletes the file","suggested_fix":"one whitespace class for guard and parser with shared fixtures","evidence":"S3/mem/p7.ts: NBSP/VT/FF/BOM/U+3000 proposals written; handoff then incomplete","confidence":"high"},
{"id":"R3-F9","severity":"minor","title":"MCP resources list hangs on a FIFO / throws EISDIR on a directory named *.md (new vs main)","file":"src/memory/store.ts","line":75,"class":"robustness","impact":"one odd entry breaks or hangs listing for all resource classes","suggested_fix":"lstat and skip non-regular files in collectEntries","evidence":"S3/mem/p6.ts vs main-e047","confidence":"high"},
{"id":"R3-F10","severity":"minor","title":"lenient memory path follows symlinks while the strict scan refuses them","file":"src/memory/store.ts","line":75,"class":"strict/lenient parity","impact":"outside file served via memory.search, wiki.ask, MCP (already on main)","suggested_fix":"same lstat check as R3-F9","evidence":"S3/mem/p6.ts symlink case","confidence":"high"},
{"id":"R3-F11","severity":"minor","title":"writeTextIfMissing writes through a dangling escaping link before the pre-scaffold check","file":"src/rules/agent-entrypoints.ts","line":57,"class":"symlink policy (check after write)","impact":"keryx init creates a template file outside the root, then refuses","suggested_fix":"check inside writeTextIfMissing or validate before defaults","evidence":"S3/rules/b2-dangling.sh case A","confidence":"high"},
{"id":"R3-F12","severity":"minor","title":"install half-applied when a later surface refuses an escaping link","file":"src/integrations/installer.ts","line":418,"class":"atomicity","impact":"settings.json and install state written, exit 1","suggested_fix":"preflight every selected target before the first write","evidence":"S3/rules/sym1esc","confidence":"high"},
{"id":"R3-F13","severity":"minor","title":"in-root links into .git/ or onto another harness's managed file are accepted","file":"src/lib/symlink-safety.ts","line":67,"class":"symlink policy","impact":".git/config corrupted (git exit 128); pre-commit hook appended (commits fail); cross-harness hook merge","suggested_fix":"refuse realpaths under <root>/.git/ and other surfaces' settings files","evidence":"S3/rules/b3-gitlinks.sh","confidence":"high"},
{"id":"R3-F14","severity":"minor","title":"dangling/cyclic entrypoint links crash with raw ENOENT/ELOOP","file":"src/rules/agent-entrypoints.ts","line":207,"class":"error handling","impact":"no named reason; CLAUDE.md -> AGENTS.md before AGENTS.md exists crashes init","suggested_fix":"route realpath failures through the helper's named refusal","evidence":"S3/rules/b2-dangling.sh B/C, dang-k","confidence":"high"},
{"id":"R3-F15","severity":"minor","title":"reserved files matched only as exact paths; registry path can be taken as a directory","file":"src/bundle/paths.ts","line":153,"class":"path identity","impact":"import --external and verify exit 1 EISDIR until bundle uninstall; no forgery","suggested_fix":"reserve each exact name also as a directory prefix","evidence":"S3/bundle/pdir.ts","confidence":"high"},
{"id":"R3-F16","severity":"minor","title":"forced ownership transfer not reported in human or --json output","file":"src/commands/bundle.ts","line":401,"class":"ownership reporting","impact":"users cannot see a takeover; docs claim the reason is printed","suggested_fix":"print forced entries with reason and previous owner; transferred field in --json","evidence":"S3/bundle/own.out O1/O1j","confidence":"high"},
{"id":"R3-F17","severity":"minor","title":"uninstall deletes during the walk; a later refusal reports removed: [] for already-deleted files","file":"src/bundle/uninstall.ts","line":150,"class":"reported status vs disk effect","impact":"ledger and output disagree with disk","suggested_fix":"validate all records first, unlink in a second pass","evidence":"S3/bundle/punin.ts","confidence":"high"},
{"id":"R3-F18","severity":"minor","title":"ownership keyed on self-declared bundle id; id spoof or --id reuse silently updates another bundle's files","file":"src/bundle/plan.ts","line":395,"class":"ownership","impact":"silent overwrite, exit 0 (audit still runs)","suggested_fix":"record provenance in the ledger; conflict on provenance mismatch; document --id as TOFU","evidence":"S3/bundle/own.out O5","confidence":"medium"},
{"id":"R3-F19","severity":"minor","title":"entry cap runs after full JSON parse and schema validation","file":"src/bundle/manifest.ts","line":22,"class":"algorithmic DoS residual (R2-F4)","impact":"4.6 MB manifest-only archive: 6 s, 1.68 GB before refusal","suggested_fix":"cap bundle.json size in the reader; check contents.length before schema","evidence":"S3/bundle/pquad3.ts, pquad2.ts","confidence":"high"},
{"id":"R3-F20","severity":"minor","title":"plan re-reads the ledger per entry; 9,999-entry re-inspect takes 39 s","file":"src/bundle/plan.ts","line":385,"class":"performance","impact":"slow re-import of large bundles (pre-existing)","suggested_fix":"read ledger once per scope; Set lookups in commands/bundle.ts:366-368","evidence":"S3/bundle/pbig.ts","confidence":"high"},
{"id":"R3-F21","severity":"minor","title":"export refuses the whole bundle on one non-portable source name","file":"src/bundle/export.ts","line":403,"class":"regression of legitimate content","impact":"rules/Code Style.md (round-tripped on cb09), non-ASCII names, .gitkeep abort the export","suggested_fix":"skip into skipped with a named reason, or document","evidence":"S3/bundle/w/exp-*; S3/roundtrip/export-user.json","confidence":"high"},
{"id":"R3-F22","severity":"minor","title":"archive cap counts bundle.json, manifest cap does not; valid 10,000-entry bundle cannot be opened","file":"src/bundle/archive.ts","line":275,"class":"robustness","impact":"boundary bundle refused","suggested_fix":"exclude bundle.json from the archive count; boundary test","evidence":"S3/bundle/pbig.ts","confidence":"high"},
{"id":"R3-F23","severity":"minor","title":"stale external-imports lock blocks every import permanently","file":"src/bundle/external.ts","line":591,"class":"availability","impact":"after a crash all --external imports refused, no documented recovery","suggested_fix":"break lock whose pid is dead; name recovery in the message","evidence":"hand-written lock in S3/ext/w/pg: 'held by another process; timed out after 3000ms'","confidence":"high"},
{"id":"R3-F24","severity":"minor","title":"bundle uninstall leaves empty directories","file":"src/bundle/uninstall.ts","line":166,"class":"cleanup","impact":"target tree differs from pre-import snapshot","suggested_fix":"prune empty ancestors under the scope root","evidence":"S3/roundtrip/dst-pre-status.txt vs dst-post-status.txt","confidence":"high"},
{"id":"R1-F13","severity":"minor","title":"hook remote-exec denylist still misses 15 of 18 schema-valid argv shapes","file":"src/security/audit-harness/checks.ts","line":561,"class":"audit shape gap","impact":"python/node/perl fetch-exec, curl -o+chmod+exec, quote/var-split, base64|sh, busybox, nc -e, /dev/tcp import with --allow-hooks","suggested_fix":"treat any interpreter -c/-e/-M or network tool in a hook as at least a medium review finding; walk command.env","evidence":"S3/ext/pk.ts (15/18 IMPORTED); rexec.ts 24/24 caught","confidence":"high"},
{"id":"R1-F20","severity":"major","title":"rules sync, update, distill, OpenCode plugin and install-state writers bypass the symlink helper and write outside the project","file":"src/rules/agent-entrypoints.ts","line":87,"class":"symlink-following write (helper applied to 4 of ~12 writers)","impact":"a cloned repo shipping .metaproject/rules -> outside gets repo-controlled text written outside on keryx update/rules sync/distill; OpenCode uninstall deletes outside","suggested_fix":"one safeWriteFile/safeRm calling refuseEscapingSymlink immediately before every write; test asserting no raw writeFile in these modules","evidence":"S3/rules/b1-metarules.sh (reproduced): OUT/rules/claude-md.md, OUT/rules/core/*.mdc, OUT/entry/index.md written, exit 0; b5-otherwriters.sh","confidence":"high","class_scope":{"sites":["src/rules/agent-entrypoints.ts:76-77,87-90,94-97,221,289-304","src/rules/distill.ts:218-219,235-236,262,273-287","src/integrations/surfaces.ts:324-337","src/integrations/install-state.ts:214-215,294","update core-rules scaffold"],"enumeration_method":"keryx ctx rg --all over fs write verbs in src/integrations, src/rules, src/commands/integrations.ts cross-referenced with refuseEscapingSymlink callers"}},
{"id":"R2-F3","severity":"minor","title":"hook audit walks argv but not command.env","file":"src/security/audit-harness/index.ts","line":204,"class":"audit walker out of sync with schema","impact":"sh -c \"$P\" with the payload in env imports","suggested_fix":"walk command.env values and cwd; variable-expanding shell argv at least medium","evidence":"S3/ext/pk.ts env-var-indirection IMPORTED","confidence":"high"},
{"id":"R2-F5","severity":"major","title":"U+2028/U+2029 in a memory harness header still parses as absent: restriction lost on every surface, handoff complete","file":"src/memory/store.ts","line":34,"class":"line-separator-dependent header parse fails open","impact":"codex-only entries served to claude and unbound callers via memory.search, wiki.ask, resources list/read (AC6); CLI handoff complete exit 0 with target_harnesses null (AC7)","suggested_fix":"normalize \\u2028/\\u2029/\\u0085 with CR/CRLF, or treat them in the header block as invalid; add fixtures","evidence":"S3/mem/p10.ts (reproduced): memory.search [LSSECRET,PSSECRET] for claude and unbound; handoff codex->claude exit 0 complete","confidence":"high","class_scope":{"sites":["src/memory/store.ts:34-36","src/memory/store.ts:384","src/memory/store.ts:518","src/memory/store.ts:534","src/memory/store.ts:545","src/memory/store.ts:557","src/memory/service.ts:263,327,354","src/commands/memory.ts:550","src/mcp/resources.ts:163,247","src/wiki/ask.ts:482"],"enumeration_method":"read every single-line regex in store.ts and every parseEntry consumer"}},
{"id":"R2-F6","severity":"minor","title":"rules-export skip: dry-run omits the warning; doctor reports invalid exit 1 right after a successful install","file":"src/integrations/surfaces-rules.ts","line":98,"class":"reported status does not match disk effect","impact":"inconsistent status across install/dry-run/doctor","suggested_fix":"carry skip messages into dry-run warnings; doctor treats skip as warning","evidence":"S3/rules/f6-cli.sh, f6.out","confidence":"high"},
{"id":"R2-F10","severity":"minor","title":"normaliser misses mathematical alphanumerics, tag characters, bidi controls, other combining marks, U+2064, double entities","file":"src/security/audit-harness/checks.ts","line":43,"class":"text normalisation gap","impact":"directives evade auto-run and (for math/tag) injection checks","suggested_fix":"NFKC, strip all Default_Ignorable_Code_Point and tag chars, iterate entity decoding","evidence":"S3/ext/pc2.ts: math-bold 0/0, tag-chars 0/0, bidi/combining/invisible autorun 0","confidence":"high"},
{"id":"R2-F12","severity":"minor","title":"prose false positives remain (curl|python3 -m json.tool, curl|node -e); UTF-16 still refused; allowlist introduced R3-F1","file":"src/security/audit-harness/checks.ts","line":561,"class":"audit false positive","impact":"legitimate docs still flagged high outside fences","suggested_fix":"see R3-F1; narrow interpreter-pipe rule to stdin-exec shapes","evidence":"S3/ext/pj.ts 3/7 flagged; pb.ts fp-utf16 audit-not-applicable","confidence":"high"},
{"id":"R2-F15","severity":"minor","title":"agent-entrypoints marker matching is not fence-aware; distill still substring-matches (see R3-F4)","file":"src/rules/agent-entrypoints.ts","line":134,"class":"marker matching","impact":"fenced example pair replaced, real block goes stale","suggested_fix":"reuse computeFencedRanges","evidence":"S3/rules/f15-fence.ts case B","confidence":"high"},
{"id":"R2-F21","severity":"minor","title":"regression tests still missing: R1-F12, R1-F9 uninstall, R2-F16 retry, R2-F20 call sites, readOctal, binary-allowlist negative","file":"src/bundle/uninstall.test.ts","line":1,"class":"test adequacy","impact":"regressions would go unnoticed (R3-F1 shipped because no negative allowlist test exists)","suggested_fix":"add tests that fail on cb09","evidence":"cb09..c4ad test diff; fails-on-old runs; two memory-symlink tests pass on cb09","confidence":"high"},
{"id":"R3-I1","severity":"info","title":"trailing-dot segments and Windows device names pass the portable rule (brief claimed trailing dots rejected)","file":"src/bundle/paths.ts","line":63,"class":"path identity (Windows only)","impact":"reserved-file aliases on Win32 only","suggested_fix":"refuse segments ending in '.' and device basenames if Windows is a target","evidence":"S3/bundle/pid.out, pid2.ts","confidence":"medium"},
{"id":"R3-I2","severity":"info","title":"bundle hardening leftovers: symlink tar member named with '/', writeAppliedState follows symlinked data/bundles, inspect forces allowHooks, parseUstar copy, bomb misreported","file":"src/bundle/archive.ts","line":259,"class":"hardening","impact":"none demonstrated end to end","suggested_fix":"refuse non-regular/non-dir typeflags; lstat ledger dir chain","evidence":"S3/bundle/ptar.out; S3/ext/p9r2.ts inspect ok","confidence":"medium"},
{"id":"R3-I3","severity":"info","title":"key check ignores hardlinked key and symlinked state/; registry version comment claims replay protection it lacks","file":"src/bundle/external.ts","line":185,"class":"hardening","impact":"local-user-only","suggested_fix":"nlink==1, lstat state/ 0700; fix the comment or store the high-water version in state/","evidence":"code reading external.ts:69-78,185-216,239","confidence":"medium"},
{"id":"R3-I4","severity":"info","title":"symlink helper accepts lexical '..' and cannot see hardlinks; agents export uses its own policy","file":"src/lib/symlink-safety.ts","line":49,"class":"hardening","impact":"no current caller passes '..'","suggested_fix":"reject '..' segments; check final containment","evidence":"S3/rules/b4-helper.ts 1a-1d, 4","confidence":"high"},
{"id":"R3-I5","severity":"info","title":"misc: staging case-collision misses ſ (unreproduced), ZWJ joins evade auto-run, handoff problems name other harnesses' entry paths, private-dir check never fires in production, sac.review dedup unfiltered","file":"src/gdskills/governance/scout.ts","line":760,"class":"hardening","impact":"none demonstrated end to end","suggested_fix":"see individual notes","evidence":"S3/ext/pc.ts zwj-autorun; S3/mem/p2b.ts, p8.ts; src/sac/decision-dedup.ts:195","confidence":"medium"}
]
```
