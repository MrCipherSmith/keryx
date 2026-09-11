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
 */
export type RetiredRuleEntry = {
  /** File name as it appeared in `bundled/rules/core/`, e.g. `foo.mdc`. */
  fileName: string;
  /** sha256 (hex) of every distinct content version ever shipped under this name, oldest first. */
  shippedSha256: string[];
  /** Why this rule was retired. */
  reason: string;
};

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
];

/** One installed retired-rule file the installer found and what it did with it. */
export type RetiredRuleOutcome =
  | { fileName: string; action: "removed" }
  | { fileName: string; action: "kept-modified" };
