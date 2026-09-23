import { expect, test } from "bun:test";
import { buildFinding, egressSourceOverrideAction, resolveDecision } from "./resolve";
import { DEFAULT_SECURITY_CONFIG, mergeSecurityConfig } from "./config";
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

test("mergeSecurityConfig: the default override is present at policies.egress.sourceOverrides", () => {
  const config = mergeSecurityConfig({});
  expect(config.policies.egress.sourceOverrides).toEqual({
    "egress.html-image-exfil": { "trusted-project": "allow" },
    "egress.markdown-image-exfil": { "trusted-project": "allow" },
  });
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
  // The overridden entry is gone; the untouched one survives the merge.
  expect(config.policies.egress.sourceOverrides?.["egress.html-image-exfil"]).toEqual({
    "trusted-project": "redact",
  });
  expect(config.policies.egress.sourceOverrides?.["egress.markdown-image-exfil"]).toEqual({
    "trusted-project": "allow",
  });

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
