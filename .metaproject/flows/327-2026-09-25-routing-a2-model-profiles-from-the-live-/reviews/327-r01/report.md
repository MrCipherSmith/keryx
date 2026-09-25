# Review — flow 327, Routing A2: model profiles and a derived default routing table (PR #718)

PR #718 gives every connected model a profile (strength tier, input/output
price, context length, priority, availability — each field's value with a
recorded source: curated / reported / guessed / operator / unknown) and
derives a default routing table from the session's own connected provider
when nothing is configured: cheapest for quick/subagents/docs, strongest
for planning/review. `keryx routing profile list|set` and `/routing`
expose the profile fields and sources. Four review rounds ran against
this branch, each addressing the previous round's findings; the module
headers of `src/harness/routing/model-profile.ts` and
`src/harness/routing/derive-default-table.ts` document the review history
in detail and are the primary evidence cited below, alongside the fix
commits' own messages (each headed "Review of PR #718"/"Review round N of
PR #718").

**Round 1** reviewed the initial commit (`caf0d091ed65fa2e28984ada2eb76ae56da4adf5`,
"feat(routing): model profiles and a derived default routing table") and
raised five findings, all fixed in `6f1b6f93da9a143c4423d09337fccd0a0ae615a3`:

- **F-001 (major)** — NaN comparator: with two unknown prices, the ranking
  comparator returned NaN and the pick fell back to list order, letting
  `opus-4.7` outrank the session's own `opus-5.5`.
- **F-002 (major)** — no non-chat filter: nothing excluded embedding,
  image, TTS, moderation or rerank models from being derived as routing
  targets.
- **F-003 (minor)** — profiles stored in `auth.json`: 500+ model profiles
  were written into the credentials file rather than their own file.
- **F-004 (major)** — lock race: the profile read-modify-write against
  `auth.json` had no lock, an unlocked race on concurrent writes.
- **F-005 (minor)** — no CLI tests: `keryx routing profile` and
  `providers test` had no CLI-level test coverage.

**Round 2** reviewed the round-1 fix and raised three findings, all fixed
in `3e2c6f99e65ec5bc28476d40860b9b88ec05dceb`:

- **F-006 (major)** — hyphenated versions: the version parser only
  recognised dotted version forms, so real Anthropic ids (hyphenated, e.g.
  `claude-opus-4-8`) and `gpt-4o` never version-compared correctly, and a
  newer same-family model could lose to an older one on plain alphabetical
  order.
- **F-007 (minor)** — `auth.json` lock: `saveShellConfig` and the one-time
  profile migration both wrote `auth.json` with no lock between them.
- **F-008 (minor)** — imagen: the round-1 non-chat filter did not catch
  image-generation model families (`imagen`, `flux`, `stable-diffusion`,
  `sdxl`, `midjourney`), which could still be derived as chat routing
  targets.

**Round 3** reviewed the round-2 fix and raised two findings, all fixed in
`7d3b04940e2a49c2b070c82378f2debf8bd07a06`. Notably, F-010 is a regression
that round 2's OWN fix (the `auth.json` sync lock) introduced — round 3
caught it before merge:

- **F-009 (major)** — size tokens as versions: parameter-size markers
  (`7b`, `70b`, `1.5b`, `8x7b`) were misread as version numbers, so
  `qwen2.5-coder-7b` and `qwen2.5-coder-32b` compared as different
  versions of the same family instead of being recognised as different
  families entirely; only OpenAI's `4o` letter form should parse as a
  version, not any letter suffix.
- **F-010 (major)** — `Atomics.wait` lock freeze: the round-2 fix's shared
  `auth.json` sync lock (`withAuthFileLockSync`) made every
  `saveShellConfig` call — including hot, latency-sensitive TUI paths like
  `/reasoning` and `/think` — take an `Atomics.wait`-based mutex that could
  block the whole process for up to 2s under contention, to guard a race
  only the migration strip actually needed protection against.

**Round 4** re-read the round-3 fix and **approved**. The PR's final commit
(`124f7f55d3d1dab53d08bd2f2ccb3d77d6907f44`, "docs(rules): model-selection
examples use generic ids") is a documentation-only cleanup after approval.

PR #718 squash-merged as `e59eeb35fdb9cfaae3313c7ae102b7ece88aedf8` into
`main`; CI was 19/19 green on the PR (`gh pr view 718 --json
statusCheckRollup`: 0 checks with a non-success, non-skipped conclusion).
Flow 327's own AC14 confirmation (recorded before merge) records
`bun run test:core`: 11856 pass / 34 fail / 7 skip across 11897 tests, all
34 failures pre-existing and unrelated (grep-verified against
routing/model-profile/derive/provider-catalog/providers paths — zero
failures there), plus clean typecheck/lint and `keryx health run` passing
at score 94.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/routing/derive-default-table.ts",
    "problem": "With two candidate models carrying unknown (undefined) prices, the ranking comparator's price subtraction produced NaN, and NaN comparisons in a sort fall back to (effectively) list order rather than a defined ranking.",
    "impact": "The derived default routing table could pick a weaker model than the session's own connected model for planning/review categories -- observed concretely as `opus-4.7` outranking the session's `opus-5.5` -- silently degrading routing quality with no error or warning.",
    "suggested_fix": "Rank primarily by family size class (opus > sonnet > haiku, flagship > mini/flash/lite) via the existing tier ladder, and only within the same family/vendor use a parsed version number to break ties, never a raw price subtraction that can produce NaN.",
    "evidence": "derive-default-table.ts's module header (`src/harness/routing/derive-default-table.ts` lines 1-3): 'rewritten 2025-09-25 -- review of PR #718's NaN tie-break, which let opus-4.7 beat the session's own opus-5.5'. Fix commit 6f1b6f93da9a: 'with two unknown prices the comparator returned NaN and the pick fell back to list order (opus-4.7 over the session's opus-5.5)'.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/routing/derive-default-table.ts -- the single ranking comparator `deriveDefaultTable` uses to order candidates"
      ],
      "enumeration_method": "grepped `NaN` and the ranking comparator's definition in derive-default-table.ts; the module header explicitly names this as the one root cause rewritten for AC10, and the file is the only place candidate models are ranked for the derived table."
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/routing/model-profile.ts",
    "problem": "Nothing excluded a non-chat model (embedding, image, TTS, moderation, rerank) from being derived as a chat routing target -- any model reported by a provider's /models endpoint was eligible, regardless of its actual capability.",
    "impact": "A connected provider offering embedding or moderation endpoints alongside chat models could have `/routing`'s derived categories silently pick a non-chat model, producing broken or nonsensical completions for quick/subagents/planning/review categories.",
    "suggested_fix": "Detect non-chat model ids from a pattern covering the common non-chat endpoint families (embed, image, tts, moderation, rerank, etc.) and exclude them from derivation entirely.",
    "evidence": "model-profile.ts's module header: 'operator decision 2026-09-25: never auto-derive a non-chat model'. `isNonChatModelId` (model-profile.ts) matches against a pattern covering embed(ding)/image/dall-e/tts/whisper/audio/moderation/rerank.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/routing/model-profile.ts isNonChatModelId -- the single filter every derivation path calls before considering a model"
      ],
      "enumeration_method": "grepped `isNonChatModelId` usage across src/harness/routing; it is called once, at the single point derive-default-table.ts filters candidates, so there is exactly one enforcement site."
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "blocker",
    "file": "src/harness/routing/model-profile.ts",
    "problem": "Model profiles (500+ entries once a live catalog refresh ran) were stored inside `auth.json`, the same file holding provider credentials, rather than in their own file.",
    "impact": "The credentials file grew unboundedly with non-secret profile data, mixing a security-sensitive file (API keys) with routine catalog data, and making every `auth.json` read/write slower and riskier than necessary -- a security-boundary violation, not just an organizational nit.",
    "suggested_fix": "Move profiles into their own file (`model-profiles.json`, mode 0600) alongside the existing `provider-catalog.json` sibling, with a one-time migration that strips the legacy `modelProfiles` field from `auth.json`.",
    "evidence": "model-profile.ts's module header: 'AC3, rewritten 2026-09-25 -- review of PR #718: 500+ profiles inside the credentials file and an unlocked read-modify-write race'; profiles now live in their own `model-profiles.json` (`modelProfilesFilePath`, model-profile.ts).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/routing/model-profile.ts modelProfilesFilePath / loadStoredModelProfiles / saveStoredModelProfiles -- the single storage boundary every profile read/write goes through"
      ],
      "enumeration_method": "grepped every reader/writer of `auth.json`'s `modelProfiles` field and of the new `model-profiles.json`; profile storage has exactly one boundary in this module, now separated from `shellConfigPath`."
    }
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/routing/model-profile.ts",
    "problem": "The profile read-modify-write against its storage (originally embedded in `auth.json`) took no lock, an unlocked race whenever two writers (e.g. a live catalog refresh and `providers test`) touched profiles concurrently.",
    "impact": "A concurrent profile write from two sources (a startup catalog refresh racing an operator's `providers test`) could silently clobber one writer's update -- a lost-update race with no error and nothing on the record showing it happened.",
    "suggested_fix": "Write profiles under the same `withFileLock` pattern `provider-catalog-cache.ts` already uses for its own on-disk cache.",
    "evidence": "model-profile.ts's module header names 'an unlocked read-modify-write race' as part of the same AC3 rewrite as F-003; profiles are now written 'atomically under withFileLock (../../lib/fs.ts), the SAME pattern provider-catalog-cache.ts uses'.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/routing/model-profile.ts -- every writer of model-profiles.json (the live catalog refresh path and the `providers test` single-entry path)"
      ],
      "enumeration_method": "grepped `withFileLock`/`model-profiles.json` writers in model-profile.ts; both writers share the one lock the module header describes, mirroring the same audit already done for provider-catalog-cache.ts in flow 309's review."
    }
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/commands/routing.test.ts",
    "problem": "`keryx routing profile` (list/set) and the profile-updating side of `providers test` had no CLI-level test coverage -- only the underlying pure functions were unit-tested.",
    "impact": "A regression in the CLI wiring (flag parsing, output formatting, exit codes) for `routing profile` or `providers test`'s profile update could ship without any test catching it.",
    "suggested_fix": "Add CLI-level tests exercising `keryx routing profile list`/`set` and `providers test`'s profile-updating behaviour end to end.",
    "evidence": "Fix commit 6f1b6f93da9a: 'CLI tests for routing profile and providers test.' src/commands/providers.model-profiles.test.ts and src/commands/routing.test.ts now exist and are part of the AC14-confirmed green test:core run.",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/routing/derive-default-table.ts",
    "problem": "The version parser only recognised dotted version forms, but real Anthropic ids are hyphenated (`claude-opus-4-8`), and OpenAI's `gpt-4o` needed to read as version 4 of the gpt family -- neither parsed, so a newer same-family model could lose to an older one purely on list/alphabetical order.",
    "impact": "The derived routing table could stay pinned to an older model within the same family even after a newer one appeared, since the ranking had no version signal to prefer it.",
    "suggested_fix": "Make the version parser conservative but hyphen-aware: merge a run of 2-3 adjacent short (1-2 digit) hyphen-separated tokens into one dotted version (`4-8` -> `4.8`), while still refusing a lone date/snapshot stamp or multiple version-looking runs in the same id.",
    "evidence": "derive-default-table.ts's module header: 'parseModelVersion is conservative (rewritten round 2 -- real Anthropic ids are hyphenated, not dotted, and the original parser refused every one of them)'. Fix commit 3e2c6f99e65e: 'claude-opus-4-8 reads as version 4.8 and gpt-4o as version 4 of the gpt family, so a newer same-family model never loses on alphabetical order'.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/routing/derive-default-table.ts parseModelVersion/findVersionGroups/parseVersionGroup -- the single version-parsing path every family/version comparison uses"
      ],
      "enumeration_method": "grepped `parseVersion`/`findVersionGroups`/`parseVersionGroup` in derive-default-table.ts; version parsing happens in exactly one place, reused by every ranking comparison."
    }
  },
  {
    "id": "F-007",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/lib/shell-config.ts",
    "problem": "`saveShellConfig` and the one-time profile migration (which strips the legacy `modelProfiles` field from `auth.json`) both wrote `auth.json` with no lock between them.",
    "impact": "A profile migration write racing an unrelated `saveShellConfig` call (e.g. a `/reasoning` or `/think` TUI action) could interleave and corrupt or lose part of either write to the credentials file.",
    "suggested_fix": "Guard the race between the two writers.",
    "evidence": "Fix commit 3e2c6f99e65e: 'saveShellConfig and the one-time profile migration both take a sync lock on auth.json (profiles lock first)'. NOTE: this specific mechanism (a shared sync lock) was itself replaced in round 3 once it was found to freeze hot TUI paths (see F-010); the underlying race it closed is now guarded differently (see verifications.json).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/shell-config.ts saveShellConfig -- one writer of auth.json",
        "src/harness/routing/model-profile.ts stripModelProfilesFromAuthJsonUnlocked -- the migration strip, the other writer of auth.json"
      ],
      "enumeration_method": "grepped every writer of auth.json across src/lib and src/harness/routing; exactly these two write it, so the race is fully enumerated between them."
    }
  },
  {
    "id": "F-008",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/harness/routing/model-profile.ts",
    "problem": "The round-1 non-chat filter's pattern did not cover image-generation model families (`imagen`, `flux`, `stable-diffusion`, `sdxl`, `midjourney`), so they could still be derived as chat routing targets.",
    "impact": "A connected provider offering an image-generation endpoint under one of these family names could still be picked as a routing default for a chat category.",
    "suggested_fix": "Extend the non-chat detection pattern to cover the named image-generation families.",
    "evidence": "Fix commit 3e2c6f99e65e: 'imagen, flux, stable-diffusion, sdxl and midjourney are never derived'. model-profile.ts's `isNonChatModelId` pattern (line ~130) now includes `imagen|flux|stable-diffusion|sdxl|midjourney` in its regex, with the module header crediting 'round 2 item 1'.",
    "confidence": "high"
  },
  {
    "id": "F-009",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/routing/derive-default-table.ts",
    "problem": "Parameter-size markers (`7b`, `70b`, `1.5b`, `8x7b`) were misread as version numbers, so `qwen2.5-coder-7b` and `qwen2.5-coder-32b` compared as two versions of the same family instead of being recognised as different families entirely; separately, only OpenAI's `4o` letter form should parse as a version, but any letter suffix was accepted.",
    "impact": "Family-grouping and version comparison for size-suffixed model ids (common in open-weight model catalogs) produced wrong results, potentially ranking a smaller/larger parameter-count variant as a 'newer version' of an unrelated model.",
    "suggested_fix": "Keep parameter-size markers as part of the family key (so differently-sized models never merge into one family), and restrict letter-suffix version parsing to the specific `4o`-style case rather than any letter.",
    "evidence": "derive-default-table.ts's own comment (lines 108-120): 'original [a-z] shape also matched a parameter-size marker -- 7b in qwen2.5-coder-7b, 32b, 70b, 34b -- and misread the size as a version, which both (a) let familyKey merge qwen2.5-coder-7b and [a larger variant] ... A parameter-size marker (7b, 70b, 1.5b, 8x7b -- a total or MoE [count]) [is now kept in the family key]'. Fix commit 7d3b04940e2a: 'only OpenAI's 4o letter form parses as a version'.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/routing/derive-default-table.ts familyKey/parseModelVersion -- the single family-key and version-parsing pair every size-suffixed model id passes through"
      ],
      "enumeration_method": "grepped `7b|70b|8x7b|1.5b` and `familyKey` in derive-default-table.ts; the size-marker handling and the version parser it interacts with are both defined once in this file."
    }
  },
  {
    "id": "F-010",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/routing/model-profile.ts",
    "problem": "Round 2's own fix (F-007) introduced a shared `auth.json` sync lock (`withAuthFileLockSync`) guarding every `saveShellConfig` call, including hot, latency-sensitive TUI paths like `/reasoning` and `/think`. The lock used an `Atomics.wait`-based mutex that could block the whole process for up to 2s under contention -- to guard a race that only the migration strip actually needed protection against.",
    "impact": "Any `saveShellConfig` call made while another writer held the sync lock -- including everyday TUI interactions unrelated to profile migration -- could freeze the entire process for up to 2 seconds, a severe UX regression introduced by the prior round's own fix.",
    "suggested_fix": "Remove the shared sync lock from `saveShellConfig`'s hot path entirely, and give the migration strip its own narrow, lock-free read/verify/write instead -- re-read `auth.json` right before writing, retry once on a concurrent change, then leave the field for the next run rather than blocking anything.",
    "evidence": "model-profile.ts's module header (lines 28-37): 'Round 2 item 2 introduced, then round 3 REMOVED, a shared auth.json sync lock (withAuthFileLockSync): it made every saveShellConfig call ... take an Atomics.wait-based mutex that could block the whole process for up to 2s on contention ... saveShellConfig is back to its pre-lock, unconditional read-merge-write ... the migration strip now protects itself with a narrow, LOCK-FREE read/verify/write instead'. Fix commit 7d3b04940e2a: 'The sync auth.json lock is gone, restoring config writes as they were; the one-time profile migration re-reads auth.json right before writing, retries once on a concurrent change'. Confirmed no `Atomics` usage remains in src/harness or src/commands (one comment-only reference, at model-profile.ts line 31, documenting the removed approach).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/shell-config.ts saveShellConfig -- the one hot-path writer the sync lock wrapped",
        "src/harness/routing/model-profile.ts stripModelProfilesFromAuthJsonUnlocked (the migration strip) -- the one caller that actually needed the guard, now lock-free"
      ],
      "enumeration_method": "grepped `Atomics` across src/harness and src/commands (one match, a comment describing the removed lock) and `withAuthFileLockSync`/`saveShellConfig` callers; the sync lock had exactly one wrapper and the module header names both call sites it affected."
    }
  }
]
```
