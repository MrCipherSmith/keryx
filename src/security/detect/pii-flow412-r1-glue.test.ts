import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1: the glue scanners (a number written against letters) were too eager (L2 phones cut out
// of hex identifiers and dotted dates, L3 IBANs cut out of uppercase digests, L6 versions read as addresses), and the
// card guards were too strict (L4/S2 a UUID-shaped neighbour hid a card, L5/S3 a card glued to hex letters was
// dropped). S8 widens the IBAN reading (lower case, more countries, glue, homoglyphs).

const found = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId);
const has = (content: string, policyId: string) => found(content, policyId).length > 0;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const HEX_LOWER = "0123456789abcdef";
const HEX_UPPER = "0123456789ABCDEF";
function hex(random: () => number, length: number, alphabet = HEX_LOWER): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(random() * 16)];
  }
  return out;
}

function rate(count: number, make: (random: () => number) => string, policyId: string, seed: number): number {
  const random = seeded(seed);
  let hits = 0;
  for (let i = 0; i < count; i += 1) {
    if (has(make(random), policyId)) {
      hits += 1;
    }
  }
  return hits;
}

const SAMPLES = 20000;

describe("hex-group identifiers and dotted dates are not phones (L2)", () => {
  // Measured on 50,000 samples against the code before the glue scanner: 0.6% (4-4-4-4), 0.3% (8-4-4-4), 0.35%
  // (4-4-4). The glue scanner at the review head gave 5.2%, 5.1% and 3.2%.
  test("4-4-4-4", () => {
    const hits = rate(SAMPLES, (r) => [4, 4, 4, 4].map((n) => hex(r, n)).join("-"), "pii.phone", 0x412a1);
    expect(hits).toBeLessThan(SAMPLES * 0.009);
  });

  test("8-4-4-4", () => {
    const hits = rate(SAMPLES, (r) => [8, 4, 4, 4].map((n) => hex(r, n)).join("-"), "pii.phone", 0x412a2);
    expect(hits).toBeLessThan(SAMPLES * 0.006);
  });

  test("4-4-4", () => {
    const hits = rate(SAMPLES, (r) => [4, 4, 4].map((n) => hex(r, n)).join("-"), "pii.phone", 0x412a3);
    expect(hits).toBeLessThan(SAMPLES * 0.007);
  });

  test("the review's examples", () => {
    expect(has("be44-3100-2465-b583", "pii.phone")).toBe(false);
    expect(has("1a228375-472c-016c-13b3", "pii.phone")).toBe(false);
  });

  test("underscore and dotted dates", () => {
    expect(has("report_2026.10.07.123456.pdf", "pii.phone")).toBe(false);
    expect(has("metrics_20261007.1234", "pii.phone")).toBe(false);
    const hits = rate(
      SAMPLES,
      (r) => {
        const year = 2000 + Math.floor(r() * 30);
        const month = String(1 + Math.floor(r() * 12)).padStart(2, "0");
        const day = String(1 + Math.floor(r() * 28)).padStart(2, "0");
        return r() < 0.5
          ? `report_${year}.${month}.${day}.${Math.floor(r() * 1e6)}.pdf`
          : `metrics_${year}${month}${day}.${Math.floor(r() * 1e4)}`;
      },
      "pii.phone",
      0x412a4,
    );
    expect(hits).toBe(0);
  });

  test("a phone glued to a label, or to hex letters that are not a hex group, is still a phone", () => {
    expect(found("tel415-555-0199", "pii.phone")[0]?.start).toBe(3);
    expect(found("415-555-0199abc", "pii.phone")).toHaveLength(1);
    expect(found("id_415-555-0199", "pii.phone")).toHaveLength(1);
    expect(found("dead415-555-0199", "pii.phone")).toHaveLength(1);
    expect(found("+14155550199abc", "pii.phone")).toHaveLength(1);
  });
});

describe("hex digests are not IBANs (L3)", () => {
  test("uppercase SHA-256 digests", () => {
    const hits = rate(SAMPLES, (r) => hex(r, 64, HEX_UPPER), "pii.iban", 0x412b1);
    expect(hits).toBe(0);
  });

  test("uppercase 32-character ids stay at the baseline rate", () => {
    // 0.06% before the glue scanner, 0.2% at the review head.
    const hits = rate(SAMPLES, (r) => hex(r, 32, HEX_UPPER), "pii.iban", 0x412b2);
    expect(hits).toBeLessThan(SAMPLES * 0.0012);
  });

  test("the review's examples", () => {
    expect(has("BBAA0FF9AD2858D971DBE85FC67EBFCA8E88D751DCA2DF9E1E585CD9C5A1DE57", "pii.iban")).toBe(false);
    expect(has("FC18E18ABE40CCB470C16F82972972BD", "pii.iban")).toBe(false);
  });

  test("an IBAN glued to a word is still one", () => {
    expect(found("GB82WEST12345698765432dolor", "pii.iban")).toHaveLength(1);
    expect(found("idGB82WEST12345698765432", "pii.iban")).toHaveLength(1);
  });
});

describe("a card next to a UUID-shaped token is still a card (L4, S2)", () => {
  test("a card that only touches a UUID shape is reported", () => {
    expect(found("card 4111111111111111-aaaa-bbbb-cccc-dddddddddddd", "pii.credit-card")[0]?.start).toBe(5);
    expect(found("card 4111111111111111-1111-1111-1111-111111111111", "pii.credit-card")).toHaveLength(1);
    expect(found("4111111111111111-e29b-41d4-a716-446655440000", "pii.credit-card")).toHaveLength(1);
    expect(found("ab12cd34-ef56-ab78-cd90-4111111111111111", "pii.credit-card")[0]?.start).toBe(24);
  });

  test("200,000 random UUIDs give no card (AC5)", () => {
    const random = seeded(0x412c1);
    let hits = 0;
    for (let i = 0; i < 200000; i += 1) {
      const uuid = [8, 4, 4, 4, 12].map((n) => hex(random, n)).join("-");
      if (has(uuid, "pii.credit-card")) {
        hits += 1;
      }
    }
    expect(hits).toBe(0);
  });

  test("random digest-like text gives no card", () => {
    expect(rate(SAMPLES, (r) => hex(r, 64), "pii.credit-card", 0x412c2)).toBe(0);
    expect(rate(SAMPLES, (r) => hex(r, 32), "pii.credit-card", 0x412c3)).toBe(0);
  });
});

describe("a card glued to hex letters is a card, a card inside a hash is not (L5, S3)", () => {
  for (const content of ["cc4111111111111111", "a4111111111111111", "dead4111111111111111", "4111111111111111beef", "cc378282246310005"]) {
    test(content, () => {
      expect(found(content, "pii.credit-card")).toHaveLength(1);
    });
  }

  test("a run of hex digits around the digits is a digest", () => {
    expect(has("deadbeef4111111111111111cafe", "pii.credit-card")).toBe(false);
    expect(has("DEADBEEF4111111111111111DEADBEEF", "pii.credit-card")).toBe(false);
  });
});

describe("a version number glued to a name is not an address (L6)", () => {
  for (const content of ["python3.11.2.1", "release-1.2.3.4rc1", "libssl1.1.1.2", "go1.21.0.1", "app-v1.2.3.4"]) {
    test(content, () => {
      expect(has(content, "pii.ip")).toBe(false);
    });
  }

  test("random name + version", () => {
    const random = seeded(0x412d1);
    const names = ["python", "go", "libssl", "ruby", "node", "php", "java"];
    let hits = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const name = names[Math.floor(random() * names.length)] as string;
      const part = () => Math.floor(random() * 30);
      const content = `${name}${1 + Math.floor(random() * 9)}.${part()}.${part()}.${part()}`;
      if (has(content, "pii.ip")) {
        hits += 1;
      }
    }
    expect(hits).toBe(0);
  });

  test("an address glued to letters, or after a v, keeps its verdict", () => {
    expect(has("192.168.1.10abc", "pii.ip")).toBe(true);
    expect(has("host192.168.1.10", "pii.ip")).toBe(true);
    expect(has("v192.168.1.10", "pii.ip")).toBe(false);
    expect(has("999.168.1.10abc", "pii.ip")).toBe(false);
  });
});

describe("the IBAN reading is wider (S8)", () => {
  test("lower case and fullwidth", () => {
    expect(found("gb82west12345698765432", "pii.iban")).toHaveLength(1);
    expect(found("gb82 west 1234 5698 7654 32", "pii.iban")).toHaveLength(1);
    expect(found("ｇｂ82ｗｅｓｔ12345698765432", "pii.iban")).toHaveLength(1);
    expect(found("ＧＢ82ＷＥＳＴ12345698765432", "pii.iban")).toHaveLength(1);
  });

  test("the countries the table missed", () => {
    // Numbers built with the mod-97 rule for each country.
    for (const iban of [
      "RU0204452560040702810412345678901",
      "LY83002048000020100120361",
      "SD2129010501234001",
      "BI4210000100010000332045181",
      "DJ2100010000000154000100186",
    ]) {
      expect(found(`pay ${iban} now`, "pii.iban"), iban).toHaveLength(1);
      expect(found(`ref${iban}x`, "pii.iban"), `glued ${iban}`).toHaveLength(1);
    }
  });

  test("glued to a letter on one side", () => {
    expect(found("xDE89370400440532013000y", "pii.iban")).toHaveLength(1);
    expect(found("xde89370400440532013000y", "pii.iban")).toHaveLength(1);
  });

  test("a Cyrillic or Greek letter standing for a Latin one", () => {
    expect(found("GБ82WEST12345698765432", "pii.iban")).toHaveLength(1);
    expect(found("GВ82WEST12345698765432", "pii.iban")).toHaveLength(1);
    expect(found("GB82WEST12345698765432".replace("E", "Е"), "pii.iban")).toHaveLength(1);
  });

  test("a failing check digit is still not an IBAN", () => {
    expect(has("gb82west12345698765433", "pii.iban")).toBe(false);
    expect(has("GБ83WEST12345698765432", "pii.iban")).toBe(false);
  });
});
