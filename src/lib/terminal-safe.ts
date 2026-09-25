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

/** True for a code point that must never reach the terminal unescaped. */
function isUnsafeCodePoint(code: number): boolean {
  if (code <= 0x1f) return true; // C0 controls, incl. ESC (0x1b), \n \r \t
  if (code === 0x7f) return true; // DEL
  if (code >= 0x80 && code <= 0x9f) return true; // C1 controls
  if (code === 0x061c) return true; // Arabic Letter Mark
  if (code === 0x200e || code === 0x200f) return true; // LRM / RLM
  if (code >= 0x200b && code <= 0x200d) return true; // ZW space / ZWNJ / ZWJ
  if (code === 0x2060) return true; // word joiner
  if (code >= 0x202a && code <= 0x202e) return true; // LRE/RLE/PDF/LRO/RLO
  if (code >= 0x2066 && code <= 0x2069) return true; // LRI/RLI/FSI/PDI
  if (code === 0xfeff) return true; // BOM / zero-width no-break space
  return false;
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
