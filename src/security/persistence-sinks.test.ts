import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prepareOutputForPersistence, type GuardResult } from "./guard";

const sinkFiles = [
  "src/memory/write.ts",
  "src/wiki/service.ts",
  "src/sac/wiki-owner-writer.ts",
  "src/gdskills/project-skills.ts",
  "src/metrics/lifecycle.ts",
  "src/testing/service.ts",
  "src/testing/coverage-map.ts",
];

const pass: GuardResult = { allowed: true, decision: { gate: "pass", action: "allow", findings: [] } };
const redacted: GuardResult = {
  allowed: true,
  redacted: "token=[REDACTED]",
  decision: { gate: "pass", action: "redact", findings: [] },
};

// T44: the materializer must carry the redaction outcome outward, not just the
// bytes — a caller could not otherwise tell "these are your original bytes"
// (bytesPreserved) apart from "this was re-serialized or masked" (redaction).
// See T24-recheck2.md#T24R2#F-002 and T41-implementation.md section 3.
test("materializer preserves allowed output when no redaction is supplied", () => {
  expect(prepareOutputForPersistence(pass, "token=raw")).toEqual({
    allowed: true,
    content: "token=raw",
    redaction: { state: "none", reasons: [] },
    bytesPreserved: true,
  });
});

test("materializer applies the secret floor even when a guard omitted redaction", () => {
  const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const serialized = JSON.stringify({ metric: secret, count: 123456789 });
  const output = prepareOutputForPersistence(pass, serialized);
  expect(output.allowed).toBe(true);
  if (!output.allowed) return;
  expect(output.content).not.toContain(secret);
  expect(JSON.parse(output.content)).toMatchObject({ count: 123456789 });
  // Outcome 2 of 3: content masked. A caller can tell this was NOT a byte-exact
  // pass-through — the floor found and redacted a secret.
  expect(output.redaction.state).toBe("redacted");
  expect(output.redaction.reasons).toContain("secrets.aws-access-key");
  expect(output.bytesPreserved).toBe(false);
  expect(output.content).not.toBe(serialized);

  // The refused branch also carries its outcome: a numeric value under a
  // credential key has no safe representation, and the format-unsafe verdict
  // that decided that is attached, not just the constant reason string.
  const numericRefusal = prepareOutputForPersistence(pass, JSON.stringify({ password: 123456789 }));
  expect(numericRefusal.allowed).toBe(false);
  if (numericRefusal.allowed) return;
  expect(numericRefusal.redaction).toEqual({
    state: "format-unsafe",
    reasons: ["sensitive-numeric-field"],
  });
});

test("materializer uses the guard's redacted output and refuses blocked writes", () => {
  expect(prepareOutputForPersistence(redacted, "token=raw")).toEqual({
    allowed: true,
    content: "token=[REDACTED]",
    redaction: { state: "none", reasons: [] },
    bytesPreserved: false,
  });
  // A guard-level refusal never reaches the floor at all, so there is no
  // OutputRedaction outcome to attach — the `redaction` key stays absent
  // rather than being fabricated.
  const blocked = prepareOutputForPersistence({ ...redacted, allowed: false, reason: "blocked" }, "token=raw");
  expect(blocked).toEqual({
    allowed: false,
    reason: "blocked",
  });
  expect("redaction" in blocked).toBe(false);
});

// T24R#F-001 / T32: the reviewer demonstrated these duplicate-member shapes
// against the real persistence materializer with a throwaway probe
// (T24-recheck-f002-class.ts / T24-recheck-boundary.ts persistence.*). A
// duplicate JSON member whose dropped value carried a credential must never
// be materialized with the original bytes, regardless of escape spelling or
// what the surviving value is. The current contract (T36) is that the safe
// canonical form comes back with a redacted state, not a blanket refusal —
// so these assert the canonical, secret-free content, not `allowed:false`.
const CREDENTIAL = "tr0ub4dor-correct-horse";
const AWS_SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const DUPLICATE_MEMBER_SHAPES: Array<{
  name: string;
  serialized: string;
  forbidden: string[];
  expected: unknown;
}> = [
  {
    name: "JSON-escaped duplicate value",
    serialized: `{"a":"AKIA\\u0049OSFODNN7EXAMPLE","a":"safe"}`,
    forbidden: [AWS_SECRET, "\\u0049"],
    expected: { a: "safe" },
  },
  {
    name: "fully escaped duplicate value",
    serialized: `{"a":"\\u0041\\u004bIAIOSFODNN7EXAMPLE","a":"safe"}`,
    forbidden: [AWS_SECRET, "\\u0041", "\\u004b"],
    expected: { a: "safe" },
  },
  {
    name: "credential survivor is an empty string",
    serialized: `{"pwd":"${CREDENTIAL}","pwd":""}`,
    forbidden: [CREDENTIAL],
    expected: { pwd: "" },
  },
  {
    name: "credential survivor is null",
    serialized: `{"api_key":"${CREDENTIAL}","api_key":null}`,
    forbidden: [CREDENTIAL],
    expected: { api_key: null },
  },
  {
    name: "credential survivor is false",
    serialized: `{"secret":"${CREDENTIAL}","secret":false}`,
    forbidden: [CREDENTIAL],
    expected: { secret: false },
  },
];

for (const shape of DUPLICATE_MEMBER_SHAPES) {
  test(`materializer never restores the original bytes of a duplicate member hiding a credential (${shape.name})`, () => {
    const output = prepareOutputForPersistence(pass, shape.serialized);
    expect(output.allowed).toBe(true);
    if (!output.allowed) return;
    expect(output.content).not.toBe(shape.serialized);
    for (const token of shape.forbidden) {
      expect(output.content).not.toContain(token);
    }
    expect(JSON.parse(output.content)).toEqual(shape.expected);
    // Outcome 3 of 3: a duplicate member was dropped, so the safe canonical
    // form was emitted instead of the original bytes — the caller can tell
    // this apart from both a byte-preserved pass-through and a masked value.
    expect(output.redaction.state).toBe("redacted");
    expect(output.redaction.reasons).toContain("serialized-content-normalized");
    expect(output.bytesPreserved).toBe(false);
  });
}

test("materializer keeps a metric string beside a long digit run allowed and redacted", () => {
  const serialized = JSON.stringify({ metric: AWS_SECRET, count: 123456789 });
  const output = prepareOutputForPersistence(pass, serialized);
  expect(output.allowed).toBe(true);
  if (!output.allowed) return;
  // Redacted, not byte-identical: the secret is gone but the long digit run
  // survives untouched (digit length alone is never sensitivity, policies.md).
  expect(output.content).not.toBe(serialized);
  expect(output.content).not.toContain(AWS_SECRET);
  expect(JSON.parse(output.content)).toEqual({ metric: "[REDACTED:secret]", count: 123456789 });
});

for (const sinkFile of sinkFiles) {
  test(`${sinkFile} materializes guarded output before persistence`, async () => {
    const source = await readFile(path.join(process.cwd(), sinkFile), "utf8");
    expect(source).toContain("prepareOutputForPersistence");
    expect(source).toContain("output.content");
  });

  test(`${sinkFile} blocks before its guarded write`, async () => {
    const source = await readFile(path.join(process.cwd(), sinkFile), "utf8");
    expect(source).toContain("output.reason");
    expect(source).toContain("output.allowed");
  });
}
