// T80 probe: without editing any production file (read-only constraint), verify
// that the two new pinning regressions (src/lib/security-pre-push.test.ts and
// src/security/templates.test.ts) would actually FAIL against the pre-T79 text,
// by applying their own assertion predicates directly to the OLD strings quoted
// verbatim in T76-review.md / T73-implementation.md, rather than reverting the
// source file and re-running bun test (forbidden here: read-only on production).

// --- src/lib/templates.ts, renderSecurityPrePushHook, OLD text (T76-review.md
// F-001 "Problem" field, quoted verbatim) ---
const oldHeader =
  "# Run the Metaproject Security guard over the changed/committable content before\n" +
  "  # a push. Blocking is delegated to the CLI, which honors security.config.json\n" +
  "  # mode: 'advisory' (default) always exits 0 (warn, never block); 'enforced'/'ci' exit non-zero on a blocking\n" +
  "  # (secret/critical) finding.";
const oldLoop = "  # enforced/ci mode blocked on this file.";

// New file's actual test assertions (src/lib/security-pre-push.test.ts:109-131),
// reproduced verbatim as predicates over a `hook` string.
function checkPrePushPins(hook: string) {
  const results: Record<string, boolean> = {};
  results["containsGatewayTriple"] = hook.includes("'enforced'/'ci'/'gateway' exit non-zero");
  results["notMatchOldSplit"] = !/'enforced'\/'ci'\s+exit non-zero/.test(hook);
  results["loopContainsGateway"] = hook.includes("# enforced/ci/gateway mode blocked on this file.");
  results["loopNotOldForm"] = !hook.includes("# enforced/ci mode blocked on this file.");
  results["notSecretCriticalParenthetical"] = !hook.includes("(secret/critical)");
  results["containsFailingOrNeedsApproval"] = hook.includes("failing or needs-approval gate");
  return results;
}

const oldCombined = oldHeader + "\n" + oldLoop;
const oldPinResults = checkPrePushPins(oldCombined);

// --- src/security/templates.ts, renderSecurityManifest, OLD text (pre-T79,
// per T73-implementation.md line 90 / T76-review.md F-004: had gateway named
// since T68, but still narrowed to "secret/critical finding") ---
const oldManifestHooks =
  "  runs `keryx security scan` over the changed/committable content. Blocking\n" +
  "  follows `security.config.json` `mode`: `advisory` (default) warns and allows\n" +
  "  the push; `enforced`/`ci`/`gateway` block the push (non-zero exit) on a\n" +
  "  secret/critical finding.";

function checkManifestPins(manifest: string) {
  return {
    notSecretCriticalFinding: !manifest.includes("secret/critical finding"),
    containsFailingOrNeedsApproval: manifest.includes("failing or needs-approval gate"),
    gatewayStillHolds: manifest.includes("`enforced`/`ci`/`gateway` block the push"),
  };
}
const oldManifestResults = checkManifestPins(oldManifestHooks);

// --- Now the ACTUAL current (post-T79) production output, imported for real,
// unmodified -- to confirm GREEN against the same predicates, matching `bun test`'s
// own report. ---
import { renderSecurityPrePushHook } from "../../../../src/lib/templates";
import { renderSecurityManifest } from "../../../../src/security/templates";

const currentHook = renderSecurityPrePushHook();
const currentManifest = renderSecurityManifest();

console.log(JSON.stringify({
  "OLD text (reconstructed from T76-review.md's verbatim quote), pre-push hook pins": oldPinResults,
  "OLD text, manifest pin": oldManifestResults,
  "CURRENT (unmodified) pre-push hook, same predicates": checkPrePushPins(currentHook),
  "CURRENT (unmodified) manifest, same predicates": checkManifestPins(currentManifest),
}, null, 2));
