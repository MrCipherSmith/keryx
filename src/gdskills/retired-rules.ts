/**
 * Rules that used to ship in `src/gdskills/bundled/rules/core/` and were
 * deliberately removed from the bundle — with the exact sha256 of every
 * content version that was ever shipped under that file name.
 *
 * `installBundledRules` force-copies the bundled rules directory over
 * `<project>/.metaproject/rules/core/` on every `keryx init`, `keryx update`
 * and `keryx skills install`, but a plain `cp` only ever adds or overwrites
 * files that still exist in the bundle — it never removes a file the bundle
 * stopped shipping. So a rule deleted from the bundle stayed installed in
 * every existing project forever, even though nothing referenced it anymore.
 *
 * This registry is how the installer tells "a rule we retired, unmodified"
 * (safe to delete) apart from "a project's own file that happens to share a
 * retired rule's name" (must be kept — the project may have repurposed it,
 * and deleting someone's edited content without asking is not a call an
 * installer gets to make). The distinction is the content hash, not the
 * file name: only an installed copy whose sha256 matches one of the hashes
 * recorded here is known to be an untouched leftover of the rule keryx
 * retired.
 *
 * Include every content version a name ever shipped, not just the last one —
 * a project that installed an older version of the file (before a later
 * in-place edit) still holds an untouched copy of *that* version, and it
 * should be removed too.
 *
 * The hashes below are of the content *after* normalisation (decode as
 * UTF-8, strip one leading U+FEFF byte-order mark, `\r\n` -> `\n`), not of
 * raw bytes — the files themselves were and are shipped LF, BOM-less, so
 * this only matters for how the installer compares an installed copy; see
 * `removeUnmodifiedRetiredRules` in `install.ts`.
 */
export type RetiredRuleEntry = {
  /** File name as it appeared in `bundled/rules/core/`, e.g. `foo.mdc`. */
  fileName: string;
  /** sha256 (hex, of normalised text — see above) of every distinct content version ever shipped under this name, oldest first. */
  shippedSha256: string[];
  /** Why this rule was retired. */
  reason: string;
  /**
   * Set when the rule was not dropped but moved to another layer (ADR-0001
   * D1): the layer-relative path it ships at now, e.g. `process/git-rules.mdc`.
   * The bundle installs the new path on the same run; the entry only decides
   * what happens to the stale `core/<fileName>` copy.
   */
  movedTo?: string;
  /**
   * Byte size of the largest version in `shippedSha256`. Bounds the read the
   * same way `RETIRED_RULE_SIZE_CAP_BYTES` does for `RETIRED_RULES`; required
   * on a move because a moved rule can be far larger than any rule retired so
   * far. Omitted entries fall back to the registry-wide cap.
   */
  largestShippedBytes?: number;
};

/** A rule that moved out of `rules/core/` into another layer. */
export type MovedRuleEntry = RetiredRuleEntry & { movedTo: string; largestShippedBytes: number };

/**
 * Retired in commit 72a850b0 ("fix(skills): retire two dead review rules and
 * the current-model strategy", Flow 252 T5): both were dead weight kept
 * installed by every project even though nothing routed to them anymore.
 */
export const RETIRED_RULES: RetiredRuleEntry[] = [
  {
    fileName: "review-agent-profile.mdc",
    // Created in fd43d35a (initial commit) and never modified before being
    // deleted in 72a850b0 — one content version, ever.
    shippedSha256: [
      "e29a832821e501fa8a0acb5130007db1e21f1cee29f8ab6b2a1a7b35f9945281",
    ],
    reason:
      "Byte-identical duplicate of code-review-ai-assistant.mdc — nothing distinguished the two, and only the latter was ever routed to.",
  },
  {
    fileName: "review-strict-profile.mdc",
    // Two content versions: the original from fd43d35a, and the revision
    // from ff9dd071 that shipped until the deletion in 72a850b0.
    shippedSha256: [
      "2e8847426bfba76ece8a208952402edadc6a062920aed07a721902b635a3f0e6",
      "bc7e6df820682f75cbc1349e70d98b5692aa1c4bae903e28f41a67edb7a5a484",
    ],
    reason:
      "Outlived the review-strict skill it backed; review-orchestrator's Step 6 now resolves the model tier directly via `keryx review tier` instead.",
  },
  {
    fileName: "gproject-contracts.mdc",
    // Two content versions: the original from fd43d35a, and the revision
    // from 74c097f3 that shipped until the planning pipeline it served was
    // removed (flow 488).
    shippedSha256: [
      "1ebb040da6d00057c486229854e1450146dce59e6002b5b17e3e90e9b908ceac",
      "c0ec8f1165ec2c228ae841fbe438a4ba2429bd7e181736674a94553b663070bd",
    ],
    reason:
      "Served the gproject subagent skills, which were removed together with the orchestrator they were dispatched by; no shipped skill loads it anymore.",
  },
  {
    fileName: "code-review-ai-assistant.mdc",
    // One content version, ever: created in fd43d35a (initial commit) and never
    // modified before the deletion in flow 488. Its bytes equal those of
    // `review-agent-profile.mdc` above, so the hash is the same one.
    shippedSha256: [
      "e29a832821e501fa8a0acb5130007db1e21f1cee29f8ab6b2a1a7b35f9945281",
    ],
    reason:
      "Backed only the code-ai-review skill, which was removed in flow 488 (its checks live in review-logic, review-frontend and the other review-* skills); no shipped skill or rule loads it anymore.",
  },
];

/**
 * Rules moved out of `rules/core/` into another layer (ADR-0001 migration,
 * P3/P4). On `keryx init`, `keryx update` and `keryx skills install` an
 * installed `core/<fileName>` whose hash matches one of `shippedSha256` is
 * removed — the bundle has just installed `movedTo` — and a copy that matches
 * none is kept and reported: the project edited it, and those edits now sit at
 * a path nothing loads.
 *
 * Record every content version the file ever shipped under `core/`, including
 * the last one before the move, and the largest version's byte size. A move
 * that also edits the file in the same release needs nothing extra: the new
 * content ships only at `movedTo`, never under `core/`.
 *
 * Hashes were collected from the bundled file at every `v*` release tag and at
 * the commit that moved it (normalised as above); `largestShippedBytes` is the
 * largest of those blobs.
 */
export const MOVED_RULES: MovedRuleEntry[] = [
  // ADR-0001 P3: engineering procedures leave core for the process layer.
  movedProcedure("git-rules.mdc", 1860, [
    // 1 version shipped under core/, first in v0.1.0.
    "a05ecc4e2fb58d0b2682f3001f0265b9e22cb2d6c9cd971a286c02a884e01ce5",
  ]),
  movedProcedure("git-concurrency.mdc", 6190, [
    // 1 version shipped under core/, first in v0.2.98.
    "4a353db8f8fe2d32be10de0f55c7d6c4f1beeb0b9c456df061bb7814b99d296d",
  ]),
  movedProcedure("commit-message-formatting.mdc", 709, [
    // 1 version shipped under core/, first in v0.1.0.
    "5c828dc756c77485f45ff032dc7db357b352dcc7df3abb4bc8bfa2515db8cd91",
  ]),
  movedProcedure("documentation-management.mdc", 4743, [
    // 2 versions shipped under core/, first in v0.1.0.
    "7da069e6538d7330bcf84120cd2e1f3058f75652364532d9fa9d255fe4adccc0",
    "0a78b912ff19ea2297e4d7ec2e69a2068f5f669eebb9614d89351ebe0ce245fd",
  ]),
  movedProcedure("skill-authoring.mdc", 8867, [
    // 1 version shipped under core/, first in v0.4.29.
    "5dabb3c43ff3162526fb1f4d421c3e617ebbf230bee2308cd999ec3fc7e9ed21",
  ]),
  movedProcedure("skill-lifecycle.mdc", 4775, [
    // 4 versions shipped under core/, first in v0.1.0.
    "c5c5d10d2fbfb469ff2f82eb5fa5a39288081ed80f962e9209c2ab2c45b867fb",
    "1421433c5398a29ac2eafa5d09665271dc5467d6bc6df9860969e5235acd3e1c",
    "da5e28558fafea452b46523a0082d28204f6e8c04c8d338dbf1be20eb0581ff9",
    "fc47bf698eb340f7f5961901b492c765a4cb5b9b65384923cb647b96317fd522",
  ]),
  movedProcedure("skills-storage-workflow.mdc", 14418, [
    // 8 versions shipped under core/, first in v0.1.0.
    "63acfd421e837763d79c65f2c819a9ccd776af44aff20a1731a31d3474084b9f",
    "385323f727e0facea21a49c9a217db62ecf1550739ae5fe377abf5c7aed1fccb",
    "fbde33232944a30eb62919a4887ac71c7801443b7f377ba1a106c8f22ec641df",
    "c9a3815377d764a7cf906024ec38909fb3630f6e9f0213ae53c4a5ff15e945bf",
    "1a81023a223456c64a17991a61f20419256ac1ec034231a905aabfa75715ab02",
    "9cfc4bc18c3976859e59d7511ab98fd263bbb503c8f1a0ca8108127751acc397",
    "afa8b9cd2e06ec7d16b8c1954def8cb37b7de397d58663c17e313c0d913c738e",
    "bda0bd6be44316ce683dfd0224e7a683ddde7f685419bdf1a6bd2d719eac5b66",
  ]),
  movedProcedure("model-selection.mdc", 18597, [
    // 8 versions shipped under core/, first in v0.1.0.
    "975a7c432c07bfa2a0b86fea302e79fa797916f6eb69cf9f963fa2d4a108a953",
    "b59361a362acef4184993289dd8005f5d76e55cc96d07337d2862716bb4001d0",
    "3ebaccbe473c8c50594f776e1a32ba98aad22908c2ecfde7c66813ed1ea180ba",
    "f73cd7a917ba9b9439acd4130ddadce4d643670b0075fffd8227163953f31b33",
    "58678df6acf1cc35f7218261b2289bf482dac6c195269eb4beea91101326b0fe",
    "5e9972f49d75a37da4c95d9a63f47a79b961c38b1622e64563293127634888f7",
    "5f0837347e95b70d791991989c6f526d61813dfa9236d479be85e5b0b3d26157",
    "67fed6cdbb1b75747db44b10cadc898915ffc0f345aa0dce27192d98f2fa0fd8",
  ]),
  movedProcedure("opus-5-5-prompting.mdc", 5999, [
    // 1 version shipped under core/, first in v0.2.163.
    "6f102d82adda6902dca8d8b3ca8c6282e822af1a28f6e609434134ce51a1443c",
  ]),
  movedProcedure("jobs-documentation.mdc", 9012, [
    // 4 versions shipped under core/, first in v0.1.0.
    "3c0167aa2b746d768da794b82077e2ec90b66b895219d6c9bc8e5408395fbbef",
    "01b1af1ad773a9d51aab5b1ceeb10e1e934f545ac10e3c07ca091e6df0f24103",
    "895a5edbbcc06d7a9bfd6563d6d9931300409701b3d7ef82e9fe8fa99b10e53a",
    "8ffab0515f92109df778f519f2cc72e9da8a85cd319390bd00b93d3a84b725e8",
  ]),
  movedProcedure("requirements-management.mdc", 1502, [
    // 2 versions shipped under core/, first in v0.1.0.
    "b4c303fe1e5ee84ef71ee4edca2f0e48bdcfef0a65d0ca96119dcdd02f5ed117",
    "212a53ccec34d2924d322297017d5776c2747bdd578a1ee8c6ac6c7fd23c62d5",
  ]),
  movedProcedure("requirements-package-standard.mdc", 3889, [
    // 2 versions shipped under core/, first in v0.1.0.
    "27f88ba1e3081dbd53bf418b598068e4e7dc99ad5e0b70dd6ffb23088fd5dedb",
    "305b93e48c21ad2cf21b02ada335e47e14ba624231077323efc6c136f938c6b3",
  ]),
  movedProcedure("implementation-plans.mdc", 2959, [
    // 2 versions shipped under core/, first in v0.1.0.
    "b71331adbb20b999a3be89f4d30695cb075c04d03dd16be0b0a7dd2b4fdfa0f1",
    "875b4de145ee96cbe763ca1830a0792efafcf3f52ab7f7e07ecb97e864078599",
  ]),
];

function movedProcedure(fileName: string, largestShippedBytes: number, shippedSha256: string[]): MovedRuleEntry {
  return {
    fileName,
    shippedSha256,
    reason: "an engineering procedure, not a coding principle — ADR-0001 P3 moved it to the process layer",
    movedTo: `process/${fileName}`,
    largestShippedBytes,
  };
}

/**
 * Byte size of the largest content version `RETIRED_RULES` has ever shipped,
 * across the registered rules: `review-agent-profile.mdc`'s only version (1494
 * bytes, commit fd43d35a), `review-strict-profile.mdc`'s two versions (1994
 * bytes at commit fd43d35a, 2248 bytes at commit ff9dd071) and
 * `gproject-contracts.mdc`'s two versions (6023 bytes at commit fd43d35a, 6031
 * bytes at commit 74c097f3 — the largest). Measured with `git cat-file -s
 * <blob>` against each commit's tree entry for the file.
 */
const LARGEST_SHIPPED_RETIRED_RULE_BYTES = 6031;

/**
 * Size cap used by `removeUnmodifiedRetiredRules` (install.ts): an installed
 * file at a retired name that is larger than this is not a plausible
 * untouched leftover of anything keryx ever shipped under that name, so the
 * installer keeps it (with a warning) instead of reading and hashing
 * arbitrary, potentially attacker-controlled bytes. 4x the largest version
 * ever shipped is generous headroom above real content while still bounding
 * the read — see round-1 finding S-001.
 */
export const RETIRED_RULE_SIZE_CAP_BYTES = LARGEST_SHIPPED_RETIRED_RULE_BYTES * 4;

/** The read cap for one entry: 4x its own largest version when recorded, the registry-wide cap otherwise. */
export function retiredRuleSizeCapBytes(entry: RetiredRuleEntry): number {
  return entry.largestShippedBytes === undefined ? RETIRED_RULE_SIZE_CAP_BYTES : entry.largestShippedBytes * 4;
}

/**
 * Which step of `removeUnmodifiedRetiredRules` (install.ts) was in flight
 * when a `kept-error` outcome's error was thrown: `lstat`/`read` failures
 * mean the file was never confirmed as an unmodified shipped copy, while
 * `unlink` means it *was* confirmed and only the removal itself failed
 * (round-2 finding L-008 — those two cases need different wording, since
 * "could not be read" is wrong for a file that was read and hash-matched).
 */
export type RetiredRuleFailureStage = "lstat" | "read" | "unlink";

/**
 * Why a moved rule's new path is not there, so the warning names the real fix:
 * `not-shipped` — this keryx bundle lacks the file (an incomplete package);
 * `layer-unusable` — the installed layer is a symlink, a file, or absent;
 * `missing` — the layer is a plain directory but the file did not land in it.
 */
export type MovedDestinationCause = "not-shipped" | "layer-unusable" | "missing";

/**
 * One installed retired-rule file the installer found and what it did with it.
 * `movedTo` is copied from a `MOVED_RULES` entry, so the report can say where
 * the rule went.
 */
export type RetiredRuleOutcome = { fileName: string; movedTo?: string } & (
  | { action: "removed" }
  | { action: "kept-modified" }
  /** A moved rule's old copy matched a shipped version, but its new path is not an installed regular file. */
  | { action: "kept-destination-missing"; cause: MovedDestinationCause }
  | { action: "kept-not-regular-file" }
  | { action: "kept-oversized"; sizeBytes: number }
  | { action: "kept-error"; stage: RetiredRuleFailureStage; errorCode: string }
);
