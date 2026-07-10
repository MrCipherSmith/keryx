import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  detectPii,
  isValidIban,
  isValidCreditCard,
  isValidSsn,
  isValidIp,
} from "./pii";
import { applyRedaction } from "../redact";
import type { EvalCase } from "../eval/harness";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);

// AC4.1/AC4.2 — valid-checksum items flagged with the right policyId; invalid
// items NOT flagged (the known regex false positives are eliminated).
test("AC4.1/AC4.2: valid-checksum PII flagged, invalid-checksum NOT flagged", async () => {
  const cases = (
    JSON.parse(await readFile(path.join(FIXTURES, "structured-pii", "cases.json"), "utf8"))
      .cases
  ) as EvalCase[];
  for (const c of cases) {
    const matches = detectPii(c.input);
    const fired = matches.some((m) => m.policyId === c.detector);
    expect(`${c.id}:${fired}`).toBe(`${c.id}:${c.expected === "positive"}`);
  }
});

test("AC4.1: IBAN mod-97 and credit-card Luhn validators", () => {
  expect(isValidIban("DE89370400440532013000")).toBe(true);
  expect(isValidIban("GB82WEST12345698765432")).toBe(true);
  expect(isValidIban("DE00370400440532013000")).toBe(false);
  expect(isValidCreditCard("4111111111111111")).toBe(true);
  expect(isValidCreditCard("4111 1111 1111 1111")).toBe(true);
  expect(isValidCreditCard("4111111111111112")).toBe(false);
});

test("AC4.2: SSN area/group/serial and IP range validators", () => {
  expect(isValidSsn("123-45-6789")).toBe(true);
  expect(isValidSsn("666-12-3456")).toBe(false);
  expect(isValidSsn("000-12-3456")).toBe(false);
  expect(isValidSsn("123-00-6789")).toBe(false);
  expect(isValidSsn("123-45-0000")).toBe(false);
  expect(isValidIp("8.8.8.8")).toBe(true);
  expect(isValidIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
  expect(isValidIp("256.256.256.256")).toBe(false);
  expect(isValidIp("999.1.1.1")).toBe(false);
});

// AC0.3 — masks are typed and fixed-width (length-hiding), no raw value leaks.
test("AC0.3: structured-PII masks are typed and fixed-width", () => {
  const content = "IBAN DE89370400440532013000, card 4111111111111111, ip 8.8.8.8";
  const matches = detectPii(content);
  const masks = new Set(matches.map((m) => m.mask));
  expect(masks.has("iban")).toBe(true);
  expect(masks.has("cc")).toBe(true);
  expect(masks.has("ip")).toBe(true);
  const redacted = applyRedaction(content, matches);
  expect(redacted).not.toContain("DE89370400440532013000");
  expect(redacted).not.toContain("4111111111111111");
  expect(redacted).toContain("[REDACTED:iban]");
  expect(redacted).toContain("[REDACTED:cc]");
});
