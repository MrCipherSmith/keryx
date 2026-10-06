// Does any OTHER PII pattern match a fragment of an identifier?
//
// `pii.phone` did (flow 260): a hyphen satisfied both its boundary lookarounds
// AND its internal separator class, so a digit run inside a UUID looked like a
// dialling sequence. The guard that fixed it is specific to that rule, which
// makes "are the others affected?" a question that must be answered rather than
// assumed — a layer absent from a report reads as checked and clean.
//
// This file is that answer, kept executable so it stays true. Each rule is put
// against the shapes that broke `pii.phone`: a v4 UUID, a hex digest, a
// hyphenated slug, and an over-long all-digit identifier.
//
// Result at the time of writing — every other rule is unaffected, for a reason
// per rule:
//
//   pii.email        `@` and a dotted TLD are not identifier characters; a UUID
//                    has neither.
//   pii.address      requires capitalised street words (`Street`, `Ave`, …).
//   pii.person-name  requires a context word (`customer:`, `name is`) and two
//                    Capitalised words.
//   pii.iban         `\b[A-Z]{2}\d{2}…` — needs two uppercase letters at a word
//                    boundary, and `isValidIban` checks mod-97.
//   pii.credit-card  can span a hyphenated digit run, but `isValidCreditCard`
//                    (Luhn) rejects what is not a card number.
//   pii.ssn          `\b\d{3}-\d{2}-\d{4}\b` can sit inside a hyphenated token.
//                    It is the one rule where the same weakness was reachable and
//                    flow 261 gave it the phone rule's guard; see the block below.
//   pii.ip           dotted quads / colon groups; `isValidIp` range-checks.

import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["a v4 UUID", "730344f3-3668-4760-9056-bf7292686b67"],
  ["a prefixed UUID", "urn:uuid:730344f3-3668-4760-9056-bf7292686b67"],
  ["a sha256 digest", "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a"],
  ["a hyphenated event id", "event-f53fd8cbab7a47fd-3668-4760-9056"],
  ["an over-long all-digit id", "20260912-3668-4760-9056-00112233445566"],
  ["a flow directory name", "001-2026-07-09-managed-review-feedback-loop"],
];

describe("no PII rule fires on an identifier", () => {
  for (const [label, input] of SHAPES) {
    test(`${label} produces no finding of any kind`, () => {
      expect(detectPii(input)).toEqual([]);
    });
  }

  test("nor inside the JSON an MCP tool returns", () => {
    const body = JSON.stringify({
      correlationId: "730344f3-3668-4760-9056-bf7292686b67",
      eventId: "event-f53fd8cbab7a47fd",
      priorEventHash: "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a",
      workspaceId: "workspace-a",
      proposalId: "proposal-a",
    });
    expect(detectPii(body)).toEqual([]);
  });
});

describe("pii.ssn follows the phone rule (flow 261)", () => {
  // `pii.ssn` is bounded by digit boundaries, so an SSN-shaped run can sit inside a longer hyphenated
  // token. Flow 261 gave it the phone rule's guard: redact unless there is positive evidence that the
  // digits belong to an identifier. The operator reversed poll 93 on 2026-10-06 (SEC-F-005): a hash
  // NEXT to an SSN is not such evidence (anyone can put one there), so only a fragment strictly inside
  // one well-formed UUID token is left alone, and an SSN label within 64 characters still overrides that.
  const ssnValues = (input: string) => detectPii(input).filter((m) => m.policyId === "pii.ssn").map((m) => m.value);
  const SSN = "123-45-6789";
  const md5 = "d41d8cd98f00b204e9800998ecf8427e";
  const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
  const sha256 = "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a";

  test("an SSN-shaped run in an ambiguous hyphenated identifier is still redacted", () => {
    expect(ssnValues("release-123-45-6789-hotfix")).toEqual([SSN]);
    expect(ssnValues("contact-123-45-6789-primary")).toEqual([SSN]);
    expect(ssnValues("a-123-45-6789")).toEqual([SSN]);
  });

  test("an SSN-shaped run directly beside an exact-length hash is reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    expect(ssnValues(`build-${md5}-123-45-6789`)).toEqual([SSN]);
    expect(ssnValues(`123-45-6789-${sha1}`)).toEqual([SSN]);
    expect(ssnValues(`event-${sha256}-123-45-6789-open`)).toEqual([SSN]);
  });

  test("a 16-hex neighbour no longer suppresses", () => {
    expect(ssnValues("build-f53fd8cbab7a47fd-123-45-6789")).toEqual([SSN]);
    expect(ssnValues("123-45-6789-f53fd8cbab7a47fd")).toEqual([SSN]);
    expect(ssnValues("event-901131d838b17aac-123-45-6789-open")).toEqual([SSN]);
  });

  test("crafted 16-hex prefixes cannot launder a real SSN", () => {
    expect(ssnValues("cafebabecafebabe-078-05-1120")).toEqual(["078-05-1120"]);
    expect(ssnValues('{"id":"cafebabecafebabe-078-05-1120"}')).toEqual(["078-05-1120"]);
    expect(ssnValues("1234567890123456e-078-05-1120")).toEqual(["078-05-1120"]);
  });

  test("hex runs of any length beside the SSN, 32 included, are reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const hex = (n: number) => "a1b2c3d4".repeat(20).slice(0, n);
    for (const n of [16, 24, 31, 33, 41, 63, 65, 128]) {
      expect(ssnValues(`${hex(n)}-${SSN}`)).toEqual([SSN]);
      expect(ssnValues(`${SSN}-${hex(n)}`)).toEqual([SSN]);
    }
    expect(ssnValues(`${hex(31)}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${hex(33)}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${hex(32)}-${SSN}`)).toEqual([SSN]);
  });

  test("a 32-char all-digit run is not a hash", () => {
    expect(ssnValues(`${"1".repeat(32)}-${SSN}`)).toEqual([SSN]);
  });

  test("md5 (32), sha1 (40) and sha256 (64) neighbours are all reported, on either side", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const digest of [md5, sha1, sha256]) {
      expect(ssnValues(`${digest}-${SSN}`)).toEqual([SSN]);
      expect(ssnValues(`${SSN}-${digest}`)).toEqual([SSN]);
      expect(ssnValues(`file-${digest}-${SSN}-v2`)).toEqual([SSN]);
    }
  });

  test("a short or hex-looking neighbour is not evidence", () => {
    for (const input of [
      "build-a1b2c3d4-123-45-6789",
      "deadbeef-123-45-6789",
      "1234567e-123-45-6789",
      "ssn-12345678a-123-45-6789",
      "E1234567-123-45-6789",
      "20260912a-123-45-6789",
      "case-1234567e-123-45-6789",
      "20260912-123-45-6789",
    ]) {
      expect(ssnValues(input)).toEqual([SSN]);
    }
  });

  test("the three hash-adjacent shapes are reported, with and without a label", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005.
    for (const digest of [md5, sha1, sha256]) {
      for (const shape of [`${digest}-${SSN}`, `${SSN}-${digest}`, `${digest}_${SSN}`, `${SSN}_${digest}`]) {
        expect(ssnValues(shape)).toEqual([SSN]);
        expect(ssnValues(`ssn ${shape}`)).toEqual([SSN]);
        expect(ssnValues(`${shape} tax id`)).toEqual([SSN]);
        expect(ssnValues(`file-${shape}-v2`)).toEqual([SSN]);
      }
    }
  });

  test("a UUID, which holds no SSN-shaped fragment, still produces no finding", () => {
    expect(ssnValues("730344f3-3668-4760-9056-bf7292686b67")).toEqual([]);
    expect(ssnValues("urn:uuid:730344f3-3668-4760-9056-bf7292686b67")).toEqual([]);
  });

  test("a hash that is not adjacent to the SSN does not suppress it", () => {
    expect(ssnValues(`${md5}-foo-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-foo-${md5}`)).toEqual([SSN]);
  });

  test("a label in or just before the token overrides a hash neighbour", () => {
    for (const input of [
      "john-smith-ssn-123-45-6789-deadbeef",
      "Employee-ID-deadbeef-SSN-123-45-6789",
      "abcdef12-ssn-123-45-6789",
      "SSN:123-45-6789-abcdef0123",
      `ssn-${md5}-${SSN}`,
      `${SSN}-${sha256}-social`,
      `ssn: ${sha1}-${SSN}`,
    ]) {
      expect(ssnValues(input)).toEqual([SSN]);
    }
  });

  test("a label right after the token, or a distant one, does not change the finding", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    expect(ssnValues(`${md5}-${SSN} is the SSN`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-${md5} (social)`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN} ${"unrelated ".repeat(8)}the ssn`)).toEqual([SSN]);
  });

  test("a label after a sentence break or newline does not change the finding", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    expect(ssnValues(`${md5}-078-05-1120. SSN of the above`)).toEqual(["078-05-1120"]);
    expect(ssnValues(`${md5}-078-05-1120 (this is the employee's social security number)`)).toEqual(["078-05-1120"]);
    expect(ssnValues(`${md5}-${SSN}.\nthe ssn is elsewhere`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN}\nssn`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN}. ssn`)).toEqual([SSN]);
    expect(ssnValues(`Ref. no. 5. ${sha1}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`SSN. ${sha1}-${SSN}`)).toEqual([SSN]);
  });

  test("every label form vetoes an exact-length hash neighbour, before or after", () => {
    const labels = [
      "SS#",
      "ss#:",
      "NSS",
      "nss:",
      "СНИЛС",
      "снилс",
      "Sozialversicherungsnummer",
      "sozialversicherungsnummer:",
      "S.S.N.",
      "s.s.n",
      "Soc. Sec. No.",
      "Soc Sec No",
      "soc sec no.",
      "social security number",
      "Social Security Number:",
      "ssn",
      "social",
    ];
    for (const digest of [md5, sha1, sha256]) {
      for (const label of labels) {
        expect(ssnValues(`${label} ${digest}-${SSN}`)).toEqual([SSN]);
        expect(ssnValues(`${digest}-${SSN} ${label}`)).toEqual([SSN]);
        expect(ssnValues(`${SSN}-${digest} ${label}`)).toEqual([SSN]);
        expect(ssnValues(`${label} ${SSN}-${digest}`)).toEqual([SSN]);
      }
    }
  });

  test("label forms beyond the basic list also veto, incl. separators, accents and invisible characters", () => {
    const labels = [
      "SS #",
      "SS#",
      "S S N",
      "S-S-N",
      "S. S. N.",
      "S .S .N",
      "SS number",
      "SS no",
      "SS-Nr",
      "Sozialversicherung",
      "Sozialversicherungsnr.",
      "SV-Nummer",
      "Versicherungsnummer",
      "N.S.S.",
      "N S S",
      "Soc.Sec.#",
      "Soc. Sec. #",
      "Soc. Sec. No.",
      "numéro de sécu",
      "numero de securite sociale",
      "Numéro de Sécurité Sociale",
      "ＳＳＮ",
      "S­SN",
      "s​sn:",
      "s‌s‍n",
      "﻿SSN",
      "so­cial security number",
      "SŚN",
    ];
    for (const label of labels) {
      expect(ssnValues(`${label} ${md5}-${SSN}`)).toEqual([SSN]);
      expect(ssnValues(`${md5}-${SSN} ${label}`)).toEqual([SSN]);
      expect(ssnValues(`${SSN}-${md5} ${label}`)).toEqual([SSN]);
      expect(ssnValues(`${label}: ${SSN}-${md5}`)).toEqual([SSN]);
    }
  });

  const vetoesEverywhere = (label: string) => {
    expect(ssnValues(`${label} ${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN} ${label}`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-${md5} ${label}`)).toEqual([SSN]);
    expect(ssnValues(`${label}: ${SSN}-${md5}`)).toEqual([SSN]);
  };

  test("astral styled labels (math bold, monospace, sans) veto: the fold runs per code point", () => {
    for (const label of ["𝐒𝐒𝐍", "𝚂𝚂𝙽", "𝗦𝗦𝗡", "𝐬𝐬𝐧", "𝐬𝐨𝐜𝐢𝐚𝐥", "𝚜𝚘𝚌𝚒𝚊𝚕", "𝗦𝗢𝗖𝗜𝗔𝗟", "𝐒𝐨𝐜. 𝐒𝐞𝐜. 𝐍𝐨."]) {
      vetoesEverywhere(label);
    }
  });

  test("invisible and bidi characters inside a label do not defeat it", () => {
    const invisibles = ["‎", "‏", "‪", "‮", "⁠", "⁢", "⁤", "᠎", "ㅤ", "\u{E0001}", "\u{E0041}", "­", "​", "﻿"];
    for (const mark of invisibles) {
      vetoesEverywhere(`S${mark}S${mark}N`);
      vetoesEverywhere(`so${mark}cial`);
    }
  });

  test("S/S/N, S:S:N and up to 12 separators between the letters of a short label veto", () => {
    for (const label of [
      "S/S/N",
      "S:S:N",
      "s|s|n",
      "S\\S\\N",
      `S${"/".repeat(9)}S N`,
      `S${"/".repeat(12)}S${"/".repeat(12)}N`,
      `S${" ".repeat(12)}S${":".repeat(12)}#`,
      `Soc${"/".repeat(12)}Sec`,
      `N${".".repeat(9)}S${".".repeat(9)}S`,
      `SV${"/".repeat(10)}N`,
    ]) {
      vetoesEverywhere(label);
    }
  });

  test("a gap wider than 12 separators, or letters between them, is not a label and the SSN is still reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const text of [`S${"/".repeat(13)}S${"/".repeat(13)}N`, "S-x-S-x-N", "S1S1N"]) {
      expect(ssnValues(`${md5}-${SSN} ${text}`)).toEqual([SSN]);
    }
  });

  test("Cyrillic and Greek lookalike labels veto", () => {
    for (const label of ["ЅЅN", "ѕѕn", "ΣΣN", "ΣΣΝ", "σσν", "ѕосіаӏ", "ѕοciαl", "ѕοϲιαl", "Ѕоc. Ѕеc. Nо."]) {
      vetoesEverywhere(label);
    }
  });

  test("a label 64 or 65 characters out, with non-ASCII text in the window, does not change the finding", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const label of ["ssn", "𝐬𝐬𝐧", "Sozialversicherungsnummer", "numero  de  secu"]) {
      for (const [start] of [
        [64, true],
        [65, false],
      ] as const) {
        const expected = [SSN];
        expect(ssnValues(`${md5}-${SSN} é${" ".repeat(start - 2)}${label}`)).toEqual(expected);
        expect(ssnValues(`${SSN}-${md5} é${" ".repeat(start - 2)}${label}`)).toEqual(expected);
      }
    }
  });

  test("window offsets count UTF-16 units, and the SSN is reported either way", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const wide = "𝐱".repeat(31);
    expect(ssnValues(`${md5}-${SSN}${wide}  ssn`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN}${wide}   ssn`)).toEqual([SSN]);
  });

  test("ordinary words, accented or styled, near a hash leave the SSN reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const text of ["résumé", "naïve café", "日本語の文章", "𝐡𝐞𝐥𝐥𝐨 𝐰𝐨𝐫𝐥𝐝", "Привет мир", "Όμηρος", "a/b/c", "s/n"]) {
      expect(ssnValues(`${md5}-${SSN} ${text}`)).toEqual([SSN]);
      expect(ssnValues(`${text} ${SSN}-${sha1}`)).toEqual([SSN]);
    }
  });

  test("ordinary words and spaced letters that are not labels leave the SSN reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const text of ["class number", "the bus snores", "this snow", "ref sn"]) {
      expect(ssnValues(`${md5}-${SSN} ${text}`)).toEqual([SSN]);
    }
  });

  test("a label starting inside the 64-character window vetoes even when it ends beyond it", () => {
    const labels = ["social security number", "Sozialversicherungsnummer", "Soc. Sec. No."];
    for (const label of labels) {
      for (const start of [1, 50, 63]) {
        const gap = " ".repeat(start);
        expect(ssnValues(`${md5}-${SSN}${gap}${label}`)).toEqual([SSN]);
        expect(ssnValues(`${SSN}-${md5}${gap}${label}`)).toEqual([SSN]);
      }
    }
    expect(ssnValues(`${md5}-${SSN}${" ".repeat(60)}social security number`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN}${" ".repeat(50)}Sozialversicherungsnummer`)).toEqual([SSN]);
  });

  test("lookahead window: the SSN is reported with a label 63, 64 or 65 characters after the token", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const label of ["ssn", "social", "social security number", "Sozialversicherungsnummer"]) {
      for (const [start] of [
        [63, true],
        [64, true],
        [65, false],
      ] as const) {
        const tail = `${" ".repeat(start)}${label}`;
        const expected = [SSN];
        expect(ssnValues(`${md5}-${SSN}${tail}`)).toEqual(expected);
        expect(ssnValues(`${SSN}-${md5}${tail}`)).toEqual(expected);
      }
    }
  });

  test("lookbehind window: the SSN is reported with a label 63, 64 or 65 characters before the token", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    for (const label of ["ssn", "social", "social security number"]) {
      for (const [distance] of [
        [63, true],
        [64, true],
        [65, false],
      ] as const) {
        const head = `${label}${" ".repeat(distance - label.length)}`;
        expect(head).toHaveLength(distance);
        const expected = [SSN];
        expect(ssnValues(`${head}${md5}-${SSN}`)).toEqual(expected);
        expect(ssnValues(`${head}${SSN}-${md5}`)).toEqual(expected);
      }
    }
    const german = `Sozialversicherungsnummer${" ".repeat(63 - 25)}`;
    expect(german).toHaveLength(63);
    expect(ssnValues(`${german}${md5}-${SSN}`)).toEqual([SSN]);
  });

  test("a repeated SSN is reported at each of its own offsets", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    expect(ssnValues(`${SSN}-${SSN}`)).toEqual([SSN, SSN]);
    expect(ssnValues(`${SSN}-${md5}-${SSN}`)).toEqual([SSN, SSN]);
    expect(ssnValues(`${SSN}-foo-${SSN}-${md5}`)).toEqual([SSN, SSN]);
  });

  test("a truncated token does not hide the SSN", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const long = `${"a1b2c3d4-".repeat(30)}${md5}-${SSN}`;
    expect(ssnValues(`${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(long)).toEqual([SSN]);
  });

  test("two long sides around a hash do not hide the SSN", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const x = "x".repeat(150);
    expect(ssnValues(`${x}-${md5}-${SSN}-${x}`)).toEqual([SSN]);
    expect(ssnValues(`${x}-${SSN}-${md5}-${x}`)).toEqual([SSN]);
    expect(ssnValues(`${"x".repeat(60)}-${md5}-${SSN}-${"x".repeat(60)}`)).toEqual([SSN]);
  });

  test("scan limit boundary: 192 and 193 characters beside the SSN are both reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const side = (length: number) => length - 34;
    const cases: [number, string[]][] = [
      [192, [SSN]],
      [193, [SSN]],
    ];
    for (const [length, expected] of cases) {
      expect(ssnValues(`${"x".repeat(side(length))}-${md5}-${SSN}`)).toEqual(expected);
      expect(ssnValues(`${SSN}-${md5}-${"x".repeat(side(length))}`)).toEqual(expected);
    }
  });

  test("a label at the window edge does not change the finding", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const gap = " ".repeat(59);
    expect(ssnValues(`xs s n${gap}${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`és s n${gap}${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(` s s n${gap}${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`é s s n${gap}${md5}-${SSN}`)).toEqual([SSN]);
  });

  test("control characters, lookalikes and separators inside a literal label do not defeat it", () => {
    for (const label of [
      "so\x00cial",
      "soc\x01ial",
      "s\x7Fsn",
      "so\u0080cial",
      "socıal",
      "SOCIAL",
      "soc.ial",
      "soc ial",
      "sozial.versicherung",
      "sozial versicherungsnummer",
      "numero_de_secu",
      "numero-de-secu",
    ]) {
      vetoesEverywhere(label);
    }
  });

  test("whitespace controls stay separators and the SSN is reported", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    expect(ssnValues(`${md5}-${SSN} class\nnumber`)).toEqual([SSN]);
    expect(ssnValues(`${md5}-${SSN} class\tnumber`)).toEqual([SSN]);
  });

  test("a hash and a long token before the SSN do not hide it", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const filler = "x".repeat(200);
    expect(ssnValues(`${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${filler}-${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${filler}-${sha256}-${SSN}`)).toEqual([SSN]);
  });

  test("a token between 100 and 192 characters beside a hash does not hide the SSN", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const filler = "x".repeat(120);
    expect(ssnValues(`${filler}-${md5}-${SSN}`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-${md5}-${filler}`)).toEqual([SSN]);
    expect(ssnValues(`${filler}-${sha256}-${SSN}`)).toEqual([SSN]);
  });

  test("a hash and a long token after the SSN do not hide it", () => {
    // The operator reversed poll 93 on 2026-10-06 for SEC-F-005: a hash neighbour no longer suppresses an SSN.
    const filler = "x".repeat(200);
    expect(ssnValues(`${SSN}-${md5}`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-${md5}-${filler}`)).toEqual([SSN]);
    expect(ssnValues(`${SSN}-${sha256}-${filler}`)).toEqual([SSN]);
  });

  test("BOUNDARY — a bare SSN, a labelled SSN and one in a hyphenated sentence are still detected", () => {
    expect(ssnValues("ssn 123-45-6789")).toEqual([SSN]);
    expect(ssnValues("ssn: 123-45-6789")).toEqual([SSN]);
    expect(ssnValues("my number - 123-45-6789 - is private")).toEqual([SSN]);
    expect(ssnValues("SSN=123-45-6789.")).toEqual([SSN]);
  });
});
