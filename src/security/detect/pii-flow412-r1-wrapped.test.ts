import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1, S6: a number wrapped over lines, with non-ASCII digits, invisible characters, a soft hyphen
// or several breaks between its groups.

const spans = (content: string, policyId: string) =>
  detectPii(content)
    .filter((match) => match.policyId === policyId)
    .map((match) => [match.start, match.end]);

describe("a wrapped SSN is found whole (S6)", () => {
  const cases: Array<[string, string, Array<[number, number]>]> = [
    ["non-ASCII digits around a break", "٠٧٨-\n٠٥-١١٢٠", [[0, 12]]],
    ["non-ASCII digits in the second group", "078-\n٠٥-1120", [[0, 12]]],
    ["a break before a dash and non-ASCII digits", "078\n-٠٥-1120", [[0, 12]]],
    ["an invisible character beside the break", "078-​\n05-1120", [[0, 13]]],
    ["three breaks per gap", "078\n\n\n05\n\n\n1120", [[0, 15]]],
    ["a break and a tab per gap", "078\n\t05\n\t1120", [[0, 13]]],
    ["a soft hyphen as a separator and as filler", "078­05-­1120", [[0, 12]]],
    ["a dash with blanks around a break", "078 -\n05 - 1120", [[0, 15]]],
  ];
  for (const [name, content, expected] of cases) {
    test(name, () => {
      expect(spans(content, "pii.ssn")).toEqual(expected);
    });
  }
});

describe("a wrapped phone is found whole (S6)", () => {
  const cases: Array<[string, string, Array<[number, number]>]> = [
    ["an invisible character beside the break", "415-555-​\n0199", [[0, 14]]],
    ["a break around every dash", "415\n-\n555\n-\n0199", [[0, 16]]],
    ["two breaks per gap", "415-\n\n555-\n\n0199", [[0, 16]]],
    ["a carriage return and a line feed per gap", "415-\r\n555-\r\n0199", [[0, 16]]],
  ];
  for (const [name, content, expected] of cases) {
    test(name, () => {
      expect(spans(content, "pii.phone")).toEqual(expected);
    });
  }
});

describe("a wrapped number does not swallow the text beside it", () => {
  test("words after the last group are left alone", () => {
    const content = "tel 415-555-​\n0199 and more words 123 Main Street";
    const [phone] = spans(content, "pii.phone");
    expect(phone).toEqual([4, 18]);
  });
});
