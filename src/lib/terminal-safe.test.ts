// Tests for terminalSafe (R1-02, flow 319 review round 1).
import { describe, expect, test } from "bun:test";
import { TerminalSafeTracker, terminalSafe } from "./terminal-safe";

describe("terminalSafe", () => {
  test("passes plain ASCII through unchanged, unescaped", () => {
    const result = terminalSafe("touch scripts/h.sh");
    expect(result.text).toBe("touch scripts/h.sh");
    expect(result.escaped).toBe(false);
  });

  test("escapes the reviewer's CSI cursor-erase payload instead of letting it act", () => {
    // scratchpad/f319/adv r2: argv token trying to erase/overwrite the
    // UNSANDBOXED warning line.
    const payload = "touch${IFS}$A/M2\u001b[1A\u001b[2K\u001b[1G";
    const result = terminalSafe(payload);
    expect(result.escaped).toBe(true);
    expect(result.text).not.toContain("\u001b");
    expect(result.text).toContain("\\x1b[1A\\x1b[2K\\x1b[1G");
    // The escaped rendering must be visibly longer / different, never a
    // silent drop of the dangerous bytes.
    expect(result.text.length).toBeGreaterThan(payload.length);
  });

  test("escapes a bidi override (RLO) hiding text direction", () => {
    const result = terminalSafe("safe-‮evil-diguc.exe");
    expect(result.escaped).toBe(true);
    expect(result.text).toContain("\\u202e");
    expect(result.text).not.toContain("‮");
  });

  test("escapes zero-width characters", () => {
    const result = terminalSafe("a​b‌c‍d﻿e");
    expect(result.escaped).toBe(true);
    expect(result.text).toBe("a\\u200bb\\u200cc\\u200dd\\ufeffe");
  });

  test("renders \\n \\r \\t visibly rather than passing them through raw", () => {
    const result = terminalSafe("a\nb\rc\td");
    expect(result.escaped).toBe(true);
    expect(result.text).toBe("a\\x0ab\\x0dc\\x09d");
  });

  test("escapes DEL and C1 control bytes", () => {
    const del = terminalSafe("x\x7fy");
    expect(del.text).toBe("x\\x7fy");
    const c1 = terminalSafe("x\u0085y");
    expect(c1.text).toBe("x\\x85y");
  });

  test("leaves ordinary non-ASCII (e.g. accented letters, emoji) untouched", () => {
    const result = terminalSafe("café 🎉");
    expect(result.escaped).toBe(false);
    expect(result.text).toBe("café 🎉");
  });

  // R2-06 (flow 319 review round 2): the round-1 list missed several
  // invisible/format code points — a probe swept the wider category and
  // found these still passing through raw.
  test("escapes soft hyphen, Mongolian vowel separator, and combining grapheme joiner", () => {
    expect(terminalSafe("a­b").text).toBe("a\\xadb");
    expect(terminalSafe("a᠎b").text).toBe("a\\u180eb");
    expect(terminalSafe("a͏b").text).toBe("a\\u034fb");
  });

  test("escapes the invisible math operators U+2061-U+2064", () => {
    for (const code of [0x2061, 0x2062, 0x2063, 0x2064]) {
      const char = String.fromCodePoint(code);
      const result = terminalSafe(`a${char}b`);
      expect(result.escaped).toBe(true);
      expect(result.text).not.toContain(char);
    }
  });

  test("escapes the four Hangul filler code points (render as a blank glyph)", () => {
    for (const code of [0x115f, 0x1160, 0x3164, 0xffa0]) {
      const char = String.fromCodePoint(code);
      const result = terminalSafe(`a${char}b`);
      expect(result.escaped).toBe(true);
      expect(result.text).not.toContain(char);
    }
  });

  test("escapes tag characters (the ASCII-smuggling block)", () => {
    // U+E0061 = TAG LATIN SMALL LETTER A
    const result = terminalSafe("a\u{e0061}b");
    expect(result.escaped).toBe(true);
    expect(result.text).toContain("\\ue0061");
  });

  test("escapes line separator and paragraph separator", () => {
    expect(terminalSafe("a b").text).toBe("a\\u2028b");
    expect(terminalSafe("a b").text).toBe("a\\u2029b");
  });

  test("escapes variation selectors (a deliberate decision, not an oversight — see the doc comment)", () => {
    // U+2764 U+FE0F is normally a red heart emoji; escaping FE0F is a
    // cosmetic-only change, accepted because the block is also a
    // steganographic channel.
    const result = terminalSafe("❤️");
    expect(result.escaped).toBe(true);
    expect(result.text).toContain("\\ufe0f");
  });

  // R3-04 (flow 319 review round 3): the hand-picked list escaped VS1-16 but
  // missed VS17-256 (U+E0100-E01EF), the larger and more commonly abused
  // variation-selector block, plus several other invisible/format code
  // points. Switching to Unicode property escapes closes the whole class
  // rather than one probed code point at a time.
  test("escapes the VS17-256 variation-selector supplement (U+E0100-E01EF), not just VS1-16", () => {
    const result = terminalSafe(`a${String.fromCodePoint(0xe0100)}b`);
    expect(result.escaped).toBe(true);
    expect(result.text).toContain("\\ue0100");
  });

  test("escapes other default-ignorable/format code points not covered by the round-2 list", () => {
    // U+206A-206F (deprecated format chars), U+180B/180C (Mongolian free
    // variation selectors), U+17B4/17B5 (invisible Khmer vowel inherents),
    // U+1D173-1D17A (musical format controls).
    for (const code of [0x206a, 0x206f, 0x180b, 0x180c, 0x17b4, 0x17b5, 0x1d173, 0x1d17a]) {
      const char = String.fromCodePoint(code);
      const result = terminalSafe(`a${char}b`);
      expect(result.escaped).toBe(true);
      expect(result.text).not.toContain(char);
    }
  });

  test("escapes interlinear annotation characters (U+FFF9-FFFB) and the Braille blank (U+2800)", () => {
    for (const code of [0xfff9, 0xfffa, 0xfffb, 0x2800]) {
      const char = String.fromCodePoint(code);
      const result = terminalSafe(`a${char}b`);
      expect(result.escaped).toBe(true);
      expect(result.text).not.toContain(char);
    }
  });

  test("still leaves ordinary emoji and CJK text untouched", () => {
    const cjk = terminalSafe("中文测试 🎉👍");
    expect(cjk.escaped).toBe(false);
    expect(cjk.text).toBe("中文测试 🎉👍");
  });
});

describe("TerminalSafeTracker", () => {
  test("tracks whether ANY rendered string needed escaping", () => {
    const tracker = new TerminalSafeTracker();
    expect(tracker.escaped).toBe(false);
    tracker.render("clean");
    expect(tracker.escaped).toBe(false);
    tracker.render("dirty\u001b[2K");
    expect(tracker.escaped).toBe(true);
    // Stays true once tripped, even if later renders are clean.
    tracker.render("clean again");
    expect(tracker.escaped).toBe(true);
  });
});
