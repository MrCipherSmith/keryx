import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1, L11: the AC6 property (a value found alone is still covered inside a larger text) holds
// when the joiner is a line break or a tab, with or without a dot or a dash before it. The cases are the ones the
// property found.

const phones = (content: string) =>
  detectPii(content)
    .filter((match) => match.policyId === "pii.phone")
    .map((match) => content.slice(match.start, match.end));

describe("a number list on separate lines or cells (L11)", () => {
  test("a spaced number with a country code, then another on the next line", () => {
    expect(phones("+1 633 923 3877\n955 961 3030")).toEqual(["+1 633 923 3877", "955 961 3030"]);
  });

  test("a number in parentheses, then another in the next cell", () => {
    expect(phones("(666) 163-5555\t516 689 6808")).toEqual(["666) 163-5555", "516 689 6808"]);
  });

  test("a row of cells", () => {
    const content = "926-42-3399\t1109-7699-9435-8594\t(666) 163-5555\t516 689 6808";
    expect(phones(content)).toEqual(["926-42-3399", "666) 163-5555", "516 689 6808"]);
  });

  test("numbers that end a line with a dot", () => {
    expect(phones("608-029-8443.\n687.145.7068")).toEqual(["608-029-8443", "687.145.7068"]);
    expect(phones("415-555-0199.\n415-555-0199.\n415-555-0199.\n415-555-0199")).toHaveLength(4);
  });

  test("a card between numbers that end a line with a dot", () => {
    const content = "+1 350 870 1219.\n4111 1111 1111 1111.\n608-029-8443.\n687.145.7068";
    expect(phones(content)).toEqual(["+1 350 870 1219", "608-029-8443", "687.145.7068"]);
    expect(detectPii(content).filter((match) => match.policyId === "pii.credit-card")).toHaveLength(1);
  });

  test("a card before numbers on the next lines", () => {
    expect(phones("4111 1111 1111 1111.\n608-029-8443.\n687.145.7068")).toEqual(["608-029-8443", "687.145.7068"]);
    expect(phones("1111 1111 1111 1111.\n608-029-8443.\n687.145.7068")).toEqual(["608-029-8443", "687.145.7068"]);
  });

  test("no phone span has more than fifteen digits or overlaps another", () => {
    for (const content of [
      "4111 1111 1111 1111. 608-029-8443.\n687.145.7068",
      "1111 1111 1111 1111.\n608-029-8443.\n687.145.7068",
      "608-029-8443.\n687.145.7068.\n608-029-8443",
    ]) {
      let end = 0;
      for (const match of detectPii(content).filter((m) => m.policyId === "pii.phone")) {
        expect(match.start, content).toBeGreaterThanOrEqual(end);
        expect(match.value.replace(/\D/g, "").length, content).toBeLessThanOrEqual(15);
        end = match.end;
      }
    }
  });
});
