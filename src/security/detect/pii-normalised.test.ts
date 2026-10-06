import { describe, expect, test } from "bun:test";
import { applyRedaction } from "../redact";
import { detectPii } from "./pii";

// SEC-F-004: the number rules are ASCII, so a number written with fullwidth or Arabic-Indic digits, a typographic
// hyphen, an unusual space or a leading word character was invisible. SEC-F-005: the SSN guard must not be
// defeatable by text next to the number, and must know the other tax and insurance labels.

const found = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId);
const values = (content: string, policyId: string) => found(content, policyId).map((match) => match.value);

describe("an SSN written with look-alike characters is detected (SEC-F-004)", () => {
  const ssns: ReadonlyArray<readonly [string, string]> = [
    ["fullwidth digits", "\uff10\uff17\uff18-\uff10\uff15-\uff11\uff11\uff12\uff10"],
    ["Arabic-Indic digits", "\u0660\u0667\u0668-\u0660\u0665-\u0661\u0661\u0662\u0660"],
    ["Extended Arabic-Indic digits", "\u06f0\u06f7\u06f8-\u06f0\u06f5-\u06f1\u06f1\u06f2\u06f0"],
    ["mathematical bold digits", "\u{1d7ce}\u{1d7d5}\u{1d7d6}-\u{1d7ce}\u{1d7d3}-\u{1d7cf}\u{1d7cf}\u{1d7d0}\u{1d7ce}"],
    ["U+2010 hyphen", "078\u201005\u20101120"],
    ["U+2011 non-breaking hyphen", "078\u201105\u20111120"],
    ["U+2013 en dash", "078\u201305\u20131120"],
    ["U+2212 minus", "078\u221205\u22121120"],
  ];
  for (const [name, ssn] of ssns) {
    test(name, () => {
      const content = `my number is ${ssn} thanks`;
      const [match] = found(content, "pii.ssn");
      expect(match?.value).toBe(ssn);
      // Offsets refer to the original text.
      expect(match?.start).toBe(13);
      expect(content.slice(match?.start, match?.end)).toBe(ssn);
    });
  }

  test("redaction replaces exactly the original characters", () => {
    const content = "id \uff10\uff17\uff18-\uff10\uff15-\uff11\uff11\uff12\uff10 end";
    const redacted = applyRedaction(content, detectPii(content));
    expect(redacted.startsWith("id ")).toBe(true);
    expect(redacted.endsWith(" end")).toBe(true);
    expect(redacted).not.toContain("\uff10");
  });

  test("a fullwidth SSN after astral characters keeps the right offsets", () => {
    const content = "\u{1f600}\u{1f600} \uff10\uff17\uff18-\uff10\uff15-\uff11\uff11\uff12\uff10";
    const [match] = found(content, "pii.ssn");
    expect(match?.start).toBe(5);
    expect(match?.end).toBe(content.length);
  });
});

describe("an SSN joined to a word character is detected (SEC-F-004)", () => {
  test("a letter or an underscore does not hide it", () => {
    expect(values("user_078-05-1120", "pii.ssn")).toEqual(["078-05-1120"]);
    expect(values("x078-05-1120", "pii.ssn")).toEqual(["078-05-1120"]);
    expect(values("078-05-1120_a", "pii.ssn")).toEqual(["078-05-1120"]);
    expect(values("078-05-1120x", "pii.ssn")).toEqual(["078-05-1120"]);
  });

  test("a digit on either side still means it is part of a longer number", () => {
    expect(values("1078-05-1120", "pii.ssn")).toEqual([]);
    expect(values("078-05-11201", "pii.ssn")).toEqual([]);
  });

  test("an invalid SSN is still not reported", () => {
    expect(values("x000-12-3456", "pii.ssn")).toEqual([]);
    expect(values("x666-12-3456_a", "pii.ssn")).toEqual([]);
  });
});

describe("a card, a phone number, an IBAN and an IP written with look-alikes are detected (SEC-F-004)", () => {
  test("a card grouped with no-break spaces", () => {
    expect(values("pay 4111\u00a01111\u00a01111\u00a01111 now", "pii.credit-card")).toEqual(["4111\u00a01111\u00a01111\u00a01111"]);
  });

  test("a card in fullwidth digits", () => {
    const card = "\uff14\uff11\uff11\uff11 \uff11\uff11\uff11\uff11 \uff11\uff11\uff11\uff11 \uff11\uff11\uff11\uff11";
    expect(values(`pay ${card} now`, "pii.credit-card")).toEqual([card]);
  });

  test("a phone number with a non-breaking hyphen and fullwidth digits", () => {
    expect(values("call 415\u2011555\u20110199 now", "pii.phone")).toEqual(["415\u2011555\u20110199"]);
    const phone = "\uff0b\uff11 \uff14\uff11\uff15 \uff15\uff15\uff15 \uff10\uff11\uff19\uff19";
    expect(values(`call ${phone} now`, "pii.phone")).toEqual([phone]);
  });

  test("an IBAN grouped with no-break spaces", () => {
    const iban = "GB82\u00a0WEST\u00a01234\u00a05698\u00a07654\u00a032";
    expect(values(`pay ${iban}, thanks`, "pii.iban")).toEqual([iban]);
  });

  test("an email with a fullwidth at sign and dot", () => {
    expect(values("write x\uff20example\uff0ecom now", "pii.email")).toEqual(["x\uff20example\uff0ecom"]);
  });

  test("plain ASCII text is not changed", () => {
    expect(values("078-05-1120 and 415-555-0199 and 4111 1111 1111 1111", "pii.ssn")).toEqual(["078-05-1120"]);
    expect(values("a.b@example.com", "pii.email")).toEqual(["a.b@example.com"]);
  });

  test("a long input is normalised without changing spans", () => {
    const filler = "café ".repeat(30_000);
    const ssn = "\uff10\uff17\uff18-\uff10\uff15-\uff11\uff11\uff12\uff10";
    const content = `${filler}${ssn} ${filler}${ssn}`;
    const spans = found(content, "pii.ssn");
    expect(spans.map((span) => span.start)).toEqual([filler.length, filler.length * 2 + ssn.length + 1]);
    for (const span of spans) {
      expect(content.slice(span.start, span.end)).toBe(ssn);
    }
  });
});

describe("the SSN identifier guard (SEC-F-005)", () => {
  const MD5 = "d41d8cd98f00b204e9800998ecf8427e";
  const SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

  test("the new labels keep an SSN next to a hash", () => {
    for (const label of ["tax id", "Tax ID:", "TIN", "tin:", "ITIN", "national insurance", "National Insurance no."]) {
      expect(values(`${label} ${MD5}-078-05-1120`, "pii.ssn")).toEqual(["078-05-1120"]);
    }
  });

  test("a word that merely contains tin is not a label", () => {
    expect(values(`routine ${SHA1}-078-05-1120`, "pii.ssn")).toEqual([]);
    expect(values(`tinder ${SHA1}-078-05-1120`, "pii.ssn")).toEqual([]);
  });

  test("an SSN joined to a hash by an underscore, or to a part of one, is reported", () => {
    expect(values(`${MD5}_078-05-1120`, "pii.ssn")).toEqual(["078-05-1120"]);
    expect(values(`078-05-1120_${MD5}`, "pii.ssn")).toEqual(["078-05-1120"]);
    expect(values(`${MD5.slice(0, 31)}-078-05-1120`, "pii.ssn")).toEqual(["078-05-1120"]);
  });

  test("an SSN-shaped fragment hyphen-joined to a whole 32, 40 or 64 character hash stays suppressed", () => {
    expect(values(`${MD5}-078-05-1120`, "pii.ssn")).toEqual([]);
    expect(values(`078-05-1120-${SHA1}`, "pii.ssn")).toEqual([]);
  });
});
