import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1: L9 and S1 (the invisible-character set was a short list, and U+FEFF was folded to a
// space) and S5 (the hyphen look-alike list missed dash punctuation). A character the reader cannot see, or a dash
// the reader reads as `-`, must not hide a number.

const found = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId);

const INVISIBLES: ReadonlyArray<readonly [string, number]> = [
  ["byte-order mark", 0xfeff],
  ["left-to-right embedding", 0x202a],
  ["right-to-left embedding", 0x202b],
  ["pop directional formatting", 0x202c],
  ["left-to-right override", 0x202d],
  ["right-to-left override", 0x202e],
  ["unassigned default ignorable", 0x2065],
  ["left-to-right isolate", 0x2066],
  ["pop directional isolate", 0x2069],
  ["activate symmetric swapping", 0x206f],
  ["arabic letter mark", 0x61c],
  ["mongolian free variation selector 1", 0x180b],
  ["mongolian free variation selector 2", 0x180c],
  ["mongolian free variation selector 3", 0x180d],
  ["mongolian free variation selector 4", 0x180f],
  ["variation selector 1", 0xfe00],
  ["variation selector 16", 0xfe0f],
  ["khmer inherent vowel aq", 0x17b4],
  ["khmer inherent vowel aa", 0x17b5],
  ["hangul choseong filler", 0x115f],
  ["hangul jungseong filler", 0x1160],
  ["hangul filler", 0x3164],
  ["halfwidth hangul filler", 0xffa0],
  ["language tag", 0xe0001],
  ["tag space", 0xe0020],
  ["last tag-block code point", 0xe0fff],
  ["arabic number sign", 0x600],
  ["arabic number mark above", 0x605],
  ["arabic end of ayah", 0x6dd],
  ["syriac abbreviation mark", 0x70f],
  ["arabic pound mark above", 0x890],
  ["arabic piastre mark above", 0x891],
  ["arabic disputed end of ayah", 0x8e2],
  ["reserved default ignorable", 0xfff0],
  ["interlinear annotation anchor", 0xfff9],
  ["interlinear annotation terminator", 0xfffb],
  ["combining grave accent", 0x300],
  ["combining acute accent", 0x301],
  ["last combining diacritical mark", 0x36f],
];

describe("an invisible character does not hide an SSN (L9, S1)", () => {
  for (const [name, code] of INVISIBLES) {
    test(`${name} (U+${code.toString(16).toUpperCase()}) after the area number`, () => {
      const content = `ssn 078${String.fromCodePoint(code)}-05-1120 end`;
      const [match] = found(content, "pii.ssn");
      expect(match?.start).toBe(4);
      expect(match?.end).toBe(content.length - 4);
    });
  }

  test("an invisible character in every gap of a card, a phone and an IBAN", () => {
    const bom = "﻿";
    const rlo = "‮";
    expect(found(`4111${bom}1111${rlo}1111${bom}1111`, "pii.credit-card")).toHaveLength(1);
    expect(found(`415${bom}-555${rlo}-0199`, "pii.phone")).toHaveLength(1);
    expect(found(`GB82${rlo}WEST${bom}1234${rlo}5698${bom}7654${rlo}32`, "pii.iban")).toHaveLength(1);
  });

  test("a byte-order mark is deleted, not read as a blank", () => {
    // A blank in the middle would split `078 -05-1120`; the mark is not there for the reader.
    expect(found("078﻿-05-1120", "pii.ssn")).toHaveLength(1);
    expect(found("078-﻿05-1120", "pii.ssn")).toHaveLength(1);
  });

  test("the reported span is the original text, mark included", () => {
    const content = "x 078‪-05️-1120 y";
    const [match] = found(content, "pii.ssn");
    expect(match?.value).toBe("078‪-05️-1120");
  });
});

const DASHES: ReadonlyArray<readonly [string, number]> = [
  ["modifier letter minus sign", 0x2d7],
  ["presentation form for vertical em dash", 0xfe31],
  ["presentation form for vertical en dash", 0xfe32],
  ["canadian syllabics hyphen", 0x1427],
  ["heavy minus sign", 0x2796],
  ["arabic full stop", 0x6d4],
  ["double oblique hyphen", 0x2e17],
  ["oblique hyphen", 0x2e40],
  ["wave dash", 0x301c],
  ["wavy dash", 0x3030],
  ["old hungarian hyphen", 0x10ead],
  ["minus sign", 0x2212],
  ["non-breaking hyphen", 0x2011],
];

describe("a dash look-alike is a hyphen (S5)", () => {
  for (const [name, code] of DASHES) {
    test(`${name} (U+${code.toString(16).toUpperCase()}) between the groups of an SSN`, () => {
      const dash = String.fromCodePoint(code);
      const content = `ssn 078${dash}05${dash}1120 end`;
      expect(found(content, "pii.ssn")).toHaveLength(1);
    });
  }

  test("and between the groups of a phone number", () => {
    expect(found("call 415〜555〰0199", "pii.phone")).toHaveLength(1);
  });
});
