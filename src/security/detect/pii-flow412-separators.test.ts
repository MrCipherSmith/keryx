import { describe, expect, test } from "bun:test";
import { applyRedaction } from "../redact";
import { detectPii } from "./pii";

// Flow 412 AC3 and AC4: invisible characters, look-alike hyphens, line breaks, extra card separators and fullwidth
// letters inside a number hid it from the ASCII rules. Offsets always refer to the ORIGINAL text.

const found = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId);

const SHY = "­";

describe("invisible characters inside a number (flow 412 AC3)", () => {
  const invisibles: ReadonlyArray<readonly [string, string]> = [
    ["U+200B", "​"],
    ["U+200D", "‍"],
    ["U+2060", "⁠"],
    ["U+00AD", SHY],
  ];
  for (const [name, invisible] of invisibles) {
    test(`${name} inside an SSN`, () => {
      const ssn = `078${invisible}-05-1120`;
      const content = `my number ${ssn} ok`;
      const [match] = found(content, "pii.ssn");
      expect(match?.value).toBe(ssn);
      expect(content.slice(match?.start, match?.end)).toBe(ssn);
    });
    test(`${name} inside a card`, () => {
      const card = `4111${invisible}1111 1111 1111`;
      expect(found(`card ${card} ok`, "pii.credit-card").map((match) => match.value)).toEqual([card]);
    });
    test(`${name} inside a phone`, () => {
      const phone = `415${invisible}-555-0199`;
      expect(found(`tel ${phone} ok`, "pii.phone")).toHaveLength(1);
    });
    test(`${name} inside an IPv4`, () => {
      const ip = `192.168${invisible}.1.10`;
      expect(found(`host ${ip} ok`, "pii.ip").map((match) => match.value)).toEqual([ip]);
    });
  }
});

describe("look-alike hyphens (flow 412 AC3)", () => {
  const hyphens: ReadonlyArray<readonly [string, string]> = [
    ["U+058A", "֊"],
    ["U+30FC", "ー"],
    ["U+2043", "⁃"],
    ["U+00AD", SHY],
  ];
  for (const [name, hyphen] of hyphens) {
    test(`${name} between SSN groups`, () => {
      const ssn = `078${hyphen}05${hyphen}1120`;
      expect(found(`n ${ssn} x`, "pii.ssn").map((match) => match.value)).toEqual([ssn]);
    });
  }
});

describe("line breaks and tabs inside a number (flow 412 AC3)", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["SSN with a newline after a dash", "pii.ssn", "078-05-\n1120"],
    ["SSN with a newline before a dash", "pii.ssn", "078-05\n-1120"],
    ["SSN with a tab", "pii.ssn", "078\t-05-1120"],
    ["SSN split by newlines", "pii.ssn", "078\n05\n1120"],
    ["card split by newlines", "pii.credit-card", "4111\n1111\n1111\n1111"],
    ["card split by tabs", "pii.credit-card", "4111\t1111\t1111\t1111"],
    ["phone with a newline", "pii.phone", "415-555\n0199"],
    ["phone with tabs", "pii.phone", "415\t555\t0199"],
    ["IPv4 with a newline before a dot", "pii.ip", "192.168.1\n.10"],
    ["IPv4 with a tab before a dot", "pii.ip", "192\t.168.1.10"],
  ];
  for (const [name, policyId, value] of cases) {
    test(name, () => {
      const content = `x ${value} y`;
      const [match] = found(content, policyId);
      expect(match?.value).toBe(value);
      expect(content.slice(match?.start, match?.end)).toBe(value);
    });
  }

  test("two numbers on adjacent lines are not fused into an SSN", () => {
    expect(found("078-05-1120\n415-555-0199", "pii.ssn").map((match) => match.value)).toEqual(["078-05-1120"]);
  });
});

describe("card separators (flow 412 AC3)", () => {
  for (const separator of [".", "/", "_"]) {
    test(`"${separator}" between groups`, () => {
      const card = ["4111", "1111", "1111", "1111"].join(separator);
      const content = `pay ${card} now`;
      const [match] = found(content, "pii.credit-card");
      expect(match?.value).toBe(card);
      expect(match?.start).toBe(4);
    });
  }

  test("a dotted group of digits that fails Luhn is not a card", () => {
    expect(found("4111.1111.1111.1112", "pii.credit-card")).toHaveLength(0);
  });
});

describe("an IBAN in fullwidth letters (flow 412 AC4)", () => {
  const iban = "ＧＢ８２ＷＥＳＴ１２３４５６９８７６５４３２";

  test("is reported with offsets into the original text", () => {
    const content = `iban ${iban} end`;
    const [match] = found(content, "pii.iban");
    expect(match?.value).toBe(iban);
    expect(match?.start).toBe(5);
    expect(match?.end).toBe(5 + iban.length);
    expect(content.slice(match?.start, match?.end)).toBe(iban);
  });

  test("redaction removes exactly the original characters", () => {
    const content = `iban ${iban} end`;
    const redacted = applyRedaction(content, found(content, "pii.iban"));
    expect(redacted.startsWith("iban ")).toBe(true);
    expect(redacted.endsWith(" end")).toBe(true);
    expect(redacted).not.toContain("Ｇ");
  });

  test("a fullwidth IBAN with a wrong checksum is not reported", () => {
    const bad = `${iban.slice(0, -1)}３`;
    expect(found(`iban ${bad} end`, "pii.iban")).toHaveLength(0);
  });
});
