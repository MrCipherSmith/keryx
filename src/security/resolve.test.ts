import { expect, test } from "bun:test";
import {
  buildFinding,
  egressSourceHasOverride,
  egressSourceOverrideAction,
  resolveDecision,
} from "./resolve";
import {
  computeConfigChecksum,
  DEFAULT_SECURITY_CONFIG,
  mergeSecurityConfig,
  verifyConfigChecksum,
} from "./config";
import { detectExfil } from "./detect/exfil";
import type { SecurityConfig } from "./types";

// GDCTX-2: `ctx read README.md --mode full` used to redact CI/npm/license badge
// `<img src>`/markdown-image URLs as `[REDACTED:url]` even though the file was
// read with `source: "trusted-project"` — `resolve.ts` selected a policy by
// category alone and never looked at `source`. These tests cover the fix at
// the `resolveDecision`/`buildFinding` level: the data-driven
// `policies.egress.sourceOverrides` table, the credential-shaped-query gate
// that keeps an attacker/model-controlled URL redacted even from a trusted
// file, and that a finding is still recorded (never silently skipped) when
// the resolved action becomes `allow`.

function exfilMatch(content: string) {
  const matches = detectExfil(content);
  expect(matches.length).toBe(1);
  return matches[0]!;
}

const HTML_BADGE = `<img src="https://github.com/o/r/actions/workflows/ci.yml/badge.svg">`;
const MARKDOWN_BADGE = `![npm](https://img.shields.io/npm/v/x.svg?style=flat)`;

test("trusted-project HTML badge URL: action allow, finding recorded, content unredacted", () => {
  const match = exfilMatch(HTML_BADGE);
  const config = DEFAULT_SECURITY_CONFIG;
  const finding = buildFinding(match, config, { source: "trusted-project", content: HTML_BADGE });
  expect(finding.action).toBe("allow");
  // Paper trail: the finding still exists (GDCTX-2 design §2, "no silent skip").
  expect(finding.policyId).toBe("egress.html-image-exfil");
  expect(finding.category).toBe("egress");

  const decision = resolveDecision(config, {
    matches: [match],
    source: "trusted-project",
    content: HTML_BADGE,
  });
  expect(decision.findings).toHaveLength(1);
  expect(decision.findings[0]?.action).toBe("allow");
  expect(decision.redacted).toBeUndefined();
});

test("trusted-project markdown badge URL: action allow, content unredacted", () => {
  const match = exfilMatch(MARKDOWN_BADGE);
  expect(match.policyId).toBe("egress.markdown-image-exfil");
  const config = DEFAULT_SECURITY_CONFIG;
  const decision = resolveDecision(config, {
    matches: [match],
    source: "trusted-project",
    content: MARKDOWN_BADGE,
  });
  expect(decision.findings[0]?.action).toBe("allow");
  expect(decision.redacted).toBeUndefined();
});

test("tool-output source: the override never applies, badge URL still redacted as before", () => {
  const match = exfilMatch(HTML_BADGE);
  const config = DEFAULT_SECURITY_CONFIG;
  const decision = resolveDecision(config, {
    matches: [match],
    source: "tool-output",
    content: HTML_BADGE,
  });
  expect(decision.findings[0]?.action).toBe("block");
  expect(decision.redacted).toBeDefined();
  expect(decision.redacted).toContain("[REDACTED:url]");
  expect(decision.redacted).not.toContain("badge.svg");
});

test("credential-shaped query param NAME keeps redaction even from trusted-project", () => {
  for (const query of ["?token=abc123", "?key=abc123", "?auth=abc123"]) {
    const content = `<img src="https://img.shields.io/npm/v/x.svg${query}">`;
    const matches = detectExfil(content);
    const urlMatch = matches.find((m) => m.policyId === "egress.html-image-exfil");
    expect(urlMatch).toBeDefined();
    const action = egressSourceOverrideAction(
      DEFAULT_SECURITY_CONFIG.policies.egress,
      urlMatch!,
      "trusted-project",
    );
    // undefined ⇒ caller falls back to the policy's own (redacting) action.
    expect(action).toBeUndefined();
  }
});

test("a harmless query string (?style=flat, ?branch=main) does not block the override", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?branch=main&style=flat">`;
  const match = detectExfil(content)[0]!;
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBe("allow");
});

test("a query VALUE that a secret detector flags keeps redaction even with a benign param name", () => {
  // `note` is not in the credential-shaped name list, but the value itself is
  // an AWS-shaped key — the design's "value is hit by the existing secret
  // detectors" half of the gate.
  const content = `<img src="https://example.com/x.svg?note=AKIAIOSFODNN7EXAMPLE">`;
  const match = detectExfil(content)[0]!;
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

test("mergeSecurityConfig: the shipped default is NOT materialized into policies.egress.sourceOverrides (F1)", () => {
  // F1 (review round 1): the shipped default used to be copied into every
  // merged config's `policies.egress.sourceOverrides`, which is exactly the
  // block `configChecksum` hashes (`computeConfigChecksum`) — so a config file
  // rendered before GDCTX-2 existed, whose checksum was computed over a
  // `policies.egress` with no `sourceOverrides` key at all, started reading as
  // TAMPERED. The shipped default must stay OUT of the merged/checksummed
  // config; it is applied at resolution time instead (see the
  // `egressSourceOverrideAction` tests below, which prove it still applies).
  const config = mergeSecurityConfig({});
  expect(config.policies.egress.sourceOverrides).toBeUndefined();
});

test("F1: a config checksummed the PRE-GDCTX-2 way (no sourceOverrides key) still verifies", () => {
  // Simulates a `security.config.json` written before this feature shipped:
  // `computeConfigChecksum` hashed `policies` with no `sourceOverrides` entry
  // at all. Loading it through today's merge must reproduce the SAME checksum,
  // or every pre-existing config in the wild reads as tampered the moment this
  // build runs `security status` / `security policy validate` against it.
  const config = mergeSecurityConfig({});
  const oldChecksum = computeConfigChecksum(config);
  const rendered: SecurityConfig = { ...config, configChecksum: oldChecksum };
  const reloaded = mergeSecurityConfig(rendered);
  expect(verifyConfigChecksum(reloaded).match).toBe(true);

  // And the shipped override still applies to a fresh (never configured)
  // workspace's resolution — the fix moves WHERE the default lives, not
  // whether it takes effect.
  const match = exfilMatch(HTML_BADGE);
  const action = egressSourceOverrideAction(reloaded.policies.egress, match, "trusted-project");
  expect(action).toBe("allow");
});

test("a project can disable the override through its own security config", () => {
  const config: SecurityConfig = mergeSecurityConfig({
    policies: {
      ...DEFAULT_SECURITY_CONFIG.policies,
      egress: {
        enabled: true,
        action: "block",
        sourceOverrides: {
          "egress.html-image-exfil": { "trusted-project": "redact" },
        },
      },
    },
  });
  // F1: only what the operator actually wrote is stored/checksummed — the
  // shipped default for the OTHER policyId is not copied in here at all.
  expect(config.policies.egress.sourceOverrides).toEqual({
    "egress.html-image-exfil": { "trusted-project": "redact" },
  });

  // The operator's own entry wins at resolution time; the untouched policyId
  // still resolves through the shipped default (merged in by
  // `egressSourceOverrideAction`, not stored on `config`).
  const markdownMatch = exfilMatch(MARKDOWN_BADGE);
  expect(
    egressSourceOverrideAction(config.policies.egress, markdownMatch, "trusted-project"),
  ).toBe("allow");

  const match = exfilMatch(HTML_BADGE);
  const decision = resolveDecision(config, {
    matches: [match],
    source: "trusted-project",
    content: HTML_BADGE,
  });
  expect(decision.findings[0]?.action).toBe("redact");
  expect(decision.redacted).toBeDefined();
  expect(decision.redacted).toContain("[REDACTED:url]");
});

test("an action other than allow is never gated on the query string", () => {
  // A project tightening its own policy (source override to something other
  // than `allow`) is not a widening of what is released, so it is never
  // subject to the credential-query gate — only `allow` is.
  const config: SecurityConfig = mergeSecurityConfig({
    policies: {
      ...DEFAULT_SECURITY_CONFIG.policies,
      egress: {
        enabled: true,
        action: "block",
        sourceOverrides: {
          "egress.html-image-exfil": { "tool-output": "warn" },
        },
      },
    },
  });
  const match = exfilMatch(HTML_BADGE);
  const action = egressSourceOverrideAction(config.policies.egress, match, "tool-output");
  expect(action).toBe("warn");
});

// F2 (review round 1): `hasCredentialShapedQuery` used to parse the RAW
// `match.value` span while `detectExfil`/a real renderer classify and fetch
// the DECODED destination (`exfil.ts#renderableUrl`). Every case below is a
// query string that reads as credential-free to a naive raw-bytes parse but
// decodes (or splits, or stem-matches) to a credential-shaped one — each was a
// confirmed bypass that returned `allow` before the fix. All must now keep the
// policy's stricter (redacting) action, i.e. `egressSourceOverrideAction`
// returns `undefined`.
const EGRESS_POLICY = DEFAULT_SECURITY_CONFIG.policies.egress;

function overrideActionFor(content: string): ReturnType<typeof egressSourceOverrideAction> {
  const match = exfilMatch(content);
  return egressSourceOverrideAction(EGRESS_POLICY, match, "trusted-project");
}

test("F2 bypass: double-encoded &amp;amp; before a credential-shaped param name", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?a=1&amp;amp;token=abc123">`;
  expect(overrideActionFor(content)).toBeUndefined();
});

test("F2 bypass: numeric character reference spells the param name (&amp;#116;oken)", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?&amp;#116;oken=abc123">`;
  expect(overrideActionFor(content)).toBeUndefined();
});

test("F2 bypass: numeric character reference inside a markdown image URL (t&amp;#111;ken)", () => {
  const content = `![npm](https://img.shields.io/npm/v/x.svg?t&amp;#111;ken=abc123)`;
  expect(overrideActionFor(content)).toBeUndefined();
});

test("F2 bypass: a `;`-separated query pair (not just `&`)", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?a=1;token=abc123">`;
  expect(overrideActionFor(content)).toBeUndefined();
});

test("F2 bypass: a credential stem compounded with an unrelated word (x_token)", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?x_token=abc123">`;
  expect(overrideActionFor(content)).toBeUndefined();
});

test("F2 bypass: a credential stem compounded with unrelated words (access_key_id)", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?access_key_id=abc123">`;
  expect(overrideActionFor(content)).toBeUndefined();
});

test("F2 bypass: an OAuth-shaped `code` param name", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?code=abc123">`;
  expect(overrideActionFor(content)).toBeUndefined();
});

// Control: a param name that merely CONTAINS a stem's letters with no word
// boundary (no separator, no camelCase transition) is NOT a false positive —
// otherwise ordinary benign badge query params would stop passing at all.
test("F2 control: a param name containing stem letters with no word boundary stays allowed", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?barcode=123&areacode=1">`;
  expect(overrideActionFor(content)).toBe("allow");
});

// F10 (review round 1): `egressSourceHasOverride` is what `guard.ts#redactRaw`
// now consults to skip its second, config-aware detection pass. It must read
// `true` for the shipped default (even with no explicit config) and for a
// source the operator's own config names, and `false` for a source neither
// table mentions.
test("F10: egressSourceHasOverride reflects the shipped default with no config at all", () => {
  expect(egressSourceHasOverride(DEFAULT_SECURITY_CONFIG.policies.egress, "trusted-project")).toBe(
    true,
  );
  expect(egressSourceHasOverride(DEFAULT_SECURITY_CONFIG.policies.egress, "tool-output")).toBe(
    false,
  );
});

test("F10: egressSourceHasOverride reflects an operator's own explicit override", () => {
  const config: SecurityConfig = mergeSecurityConfig({
    policies: {
      ...DEFAULT_SECURITY_CONFIG.policies,
      egress: {
        enabled: true,
        action: "block",
        sourceOverrides: {
          "egress.html-image-exfil": { "tool-output": "warn" },
        },
      },
    },
  });
  expect(egressSourceHasOverride(config.policies.egress, "tool-output")).toBe(true);
  expect(egressSourceHasOverride(config.policies.egress, "untrusted-external")).toBe(false);
});
