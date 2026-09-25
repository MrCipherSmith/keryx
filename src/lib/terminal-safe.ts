// Renders an attacker-controlled string safely for a terminal (R1-02, flow
// 319 review round 1).
//
// `keryx hooks trust`'s approval display and `keryx hooks list` print
// strings straight out of `.metaproject/hooks.json` — a committed file an
// attacker fully controls: hook ids, argv tokens, cwd, env keys/values,
// matcher, description, and file paths. None of those come from a fixed
// vocabulary. A whitespace-only quoting rule (or no quoting at all) lets a
// token carry cursor-movement/line-erase escape sequences that repaint the
// operator's terminal at the exact moment they are deciding whether to trust
// the file — hiding the real (possibly unsandboxed) command behind a
// forged, benign-looking one.
//
// `terminalSafe` replaces every control, ESC-based, bidi-override, and
// zero-width code point with a visible `\xHH`/`\uHHHH` escape instead of
// passing it through (which would let it act) or silently dropping it
// (which would hide that anything odd was there at all). The escaped form
// is the ONLY thing this module ever prints.
//
// `src/lib/project-registry.ts`'s `sanitizeForDisplay` was considered and
// rejected as a base: it DROPS C0/C1 control bytes rather than rendering
// them, and does not cover bidi overrides or zero-width characters at all —
// both of which this class of attack needs (evidence: review round 1,
// finding R1-02).

/**
 * Matches a code point that must never reach the terminal unescaped.
 *
 * R3-04 (flow 319 review round 3): R2-06 extended a hand-picked list of code
 * points one probe result at a time, which only ever covers what was
 * probed — VS1-16 (U+FE00-FE0F) were escaped but VS17-256
 * (U+E0100-E01EF, the larger and more commonly abused variation-selector
 * block) were not, along with several other invisible/format code points
 * nobody had swept for yet. This uses Unicode property escapes instead, so
 * the set is defined by what the code points ARE, not by which ones were
 * tested:
 *
 * - `\p{Cc}` — C0/C1 controls, including ESC (0x1b) and DEL (0x7f). Also
 *   \n \r \t: rendered visibly rather than passed through raw, unchanged
 *   from R1-02/R2-06.
 * - `\p{Cf}` — format characters: soft hyphen, the Arabic Letter Mark, the
 *   Mongolian vowel separator, ZW space/ZWNJ/ZWJ, word joiner, the
 *   invisible math operators, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, BOM,
 *   and the W3C/Unicode tag block (the 2023 "ASCII smuggling" vehicle).
 * - `\p{Zl}` / `\p{Zp}` — line separator / paragraph separator
 *   (U+2028/U+2029): invisible in a terminal but a real line break to
 *   anything that parses the output.
 * - `\p{Default_Ignorable_Code_Point}` — the Unicode property for "has no
 *   visible glyph of its own by design". Covers the combining grapheme
 *   joiner and the four Hangul filler code points from R2-06 (none of which
 *   are Cf: they are Lo, "letter, other"), plus code points nobody had
 *   probed yet (U+180B/U+180C, U+206A-206F, U+17B4/17B5,
 *   U+1D173-U+1D17A). Bun/V8 supports this property (probed:
 *   `bun -e 'console.log(/\p{Default_Ignorable_Code_Point}/u.test("ᅟ"))'`
 *   → true).
 * - `\p{Variation_Selector}` — the whole variation-selector block, VS1-16
 *   AND VS17-256 (U+E0100-E01EF). Escaping these is a deliberate decision
 *   carried over from R2-06, not an oversight: they are legitimately used
 *   to select an emoji presentation (U+2764 U+FE0F is a red heart emoji,
 *   not just the plain heart glyph), so escaping them means such a pair
 *   prints as its base character plus a visible `️` instead of rendering as
 *   the emoji — a cosmetic-only change. It is accepted because these code
 *   points are also a documented steganographic channel (hiding arbitrary
 *   text inside what looks like ordinary content) and this module's whole
 *   job is "nothing invisible or format-only reaches the terminal", not
 *   "nothing invisible except the popular case".
 * - Two explicit extras the properties above do not cover, because they are
 *   visible-by-design code points that are nonetheless format/invisible in
 *   practice: U+FFF9-FFFB (interlinear annotation anchor/separator/
 *   terminator — invisible bracketing around real text) and U+2800 (Braille
 *   pattern blank — a real, printable Braille cell that renders as
 *   whitespace in every non-Braille font).
 *
 * Ordinary text — accented letters, emoji (without a hidden variation
 * selector), CJK — is untouched: none of it is Cc/Cf/Zl/Zp/default-ignorable
 * or a variation selector.
 */
const UNSAFE_CODE_POINT_RE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}￹-￻⠀]/u;

function isUnsafeCodePoint(code: number): boolean {
  return UNSAFE_CODE_POINT_RE.test(String.fromCodePoint(code));
}

function escapeCodePoint(code: number): string {
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

export interface TerminalSafeResult {
  /** `value` with every unsafe code point replaced by a visible escape. Safe to print as-is. */
  text: string;
  /** True when at least one code point was escaped — the caller should warn the reader. */
  escaped: boolean;
}

/**
 * Escape every control, ESC-based, bidi-override, and zero-width code point
 * in `value` so it can be printed to a terminal without acting on it or
 * disappearing from it. Never drops a character: an escaped code point is
 * replaced, not removed, so the rendered length still reflects the input.
 */
export function terminalSafe(value: string): TerminalSafeResult {
  let out = "";
  let escaped = false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isUnsafeCodePoint(code)) {
      out += escapeCodePoint(code);
      escaped = true;
    } else {
      out += char;
    }
  }
  return { text: out, escaped };
}

/** `terminalSafe`, tracking whether ANY call in a batch escaped something via a shared mutable flag. */
export class TerminalSafeTracker {
  private anyEscaped = false;

  /** Sanitise one string, recording whether it needed escaping into this tracker's overall flag. */
  render(value: string): string {
    const { text, escaped } = terminalSafe(value);
    if (escaped) this.anyEscaped = true;
    return text;
  }

  get escaped(): boolean {
    return this.anyEscaped;
  }
}
