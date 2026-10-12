import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412 AC2: a card, IBAN, IPv4 or phone glued to a letter was invisible, because every rule demanded a non-word
// character next to it. The checksum (Luhn, mod 97) or the address range is still the guard.

const found = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId);
const valuesOf = (content: string, policyId: string) => found(content, policyId).map((match) => match.value);

describe("a value glued to letters is reported (flow 412 AC2)", () => {
  test("card after a word", () => {
    expect(valuesOf("id4111111111111111", "pii.credit-card")).toEqual(["4111111111111111"]);
  });

  test("card between underscores", () => {
    expect(valuesOf("x_4111111111111111_y", "pii.credit-card")).toEqual(["4111111111111111"]);
  });

  test("phone after a word", () => {
    const content = "tel415-555-0199";
    const [match] = found(content, "pii.phone");
    expect(match?.value).toBe("415-555-0199");
    expect(match?.start).toBe(3);
  });

  test("IBAN before a word", () => {
    expect(valuesOf("GB82WEST12345698765432dolor", "pii.iban")).toEqual(["GB82WEST12345698765432"]);
  });

  test("IPv4 before a word", () => {
    expect(valuesOf("192.168.1.10abc", "pii.ip")).toEqual(["192.168.1.10"]);
  });
});

describe("the checksum stays the guard", () => {
  test("a glued card that fails Luhn is not reported", () => {
    expect(found("id4111111111111112", "pii.credit-card")).toHaveLength(0);
  });

  test("a glued IBAN that fails mod 97 is not reported", () => {
    expect(found("GB82WEST12345698765433dolor", "pii.iban")).toHaveLength(0);
  });

  test("an out-of-range glued address is not reported", () => {
    expect(found("999.168.1.10abc", "pii.ip")).toHaveLength(0);
  });

  test("a version string is not an address", () => {
    expect(found("v192.168.1.10", "pii.ip")).toHaveLength(0);
  });

  test("a hex hash with a Luhn-valid digit run is not a card", () => {
    expect(found("deadbeef4111111111111111cafe", "pii.credit-card")).toHaveLength(0);
  });
});
