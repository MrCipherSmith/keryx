// T42 — testing the disclosed judgement call: the named-character-reference table
// carries a stated MEMBERSHIP RULE ("a named reference belongs here when the URL
// parser either treats its character as URL syntax or removes it; over the ASCII
// punctuation that HTML5 names, that is exactly this set") instead of the full
// HTML5 table of 2231 entries.
//
// The argument is tested two ways:
//   1. completeness — every HTML5 named reference that denotes an ASCII character,
//      plus the non-ASCII ones a renderer might put in a URL, is placed in a
//      scheme/authority position and adjudicated by a WHATWG URL oracle.
//   2. exactness of the stated claim — which ASCII-denoting HTML5 names are
//      absent from the detector's table, and whether any of them is URL syntax.
//
// Read-only. Synthetic hosts only. Usage: bun T42-charrefs.ts
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const BASE = "https://client.example.org/session/page";

// Every HTML5 named character reference whose character is ASCII (or a space-like
// non-ASCII a renderer could be fed), name -> character. Taken from the HTML
// standard's named-character-reference table, ASCII section, ALL alias spellings.
const HTML5_ASCII_NAMES: Record<string, string> = {
  Tab: String.fromCharCode(9),
  NewLine: String.fromCharCode(10),
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
  tilde: "~",
  nbsp: String.fromCharCode(160),
  NonBreakingSpace: String.fromCharCode(160),
};

// Positions in which a decoded character could rebuild an authority.
function positions(char: string): Array<{ shape: string; raw: (ref: string) => string }> {
  void char;
  return [
    { shape: "inside-scheme", raw: (r) => `ht${r}tps://${ATT}/p` },
    { shape: "as-scheme-colon", raw: (r) => `https${r}//${ATT}/p` },
    { shape: "as-authority-slashes", raw: (r) => `https:${r}${r}${ATT}/p` },
    { shape: "leading", raw: (r) => `${r}https://${ATT}/p` },
    { shape: "protocol-relative", raw: (r) => `${r}${r}${ATT}/p` },
  ];
}

function rendererHost(decoded: string): string | null {
  try {
    const u = new URL(decoded, BASE);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.length > 0 ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const bypasses: string[] = [];
const rows: Array<Record<string, unknown>> = [];

for (const [name, char] of Object.entries(HTML5_ASCII_NAMES)) {
  for (const pos of positions(char)) {
    const ref = `&${name};`;
    const written = pos.raw(ref);
    const decoded = pos.raw(char);
    // What a conformant renderer requests: decode the named reference, then let
    // the URL parser do its own removals.
    const host = rendererHost(decoded);
    const remote = host !== null && host !== "client.example.org";
    const flagged = detectExfil(`<img src="${written}">`, []).length > 0;
    const bypass = remote && !flagged;
    if (bypass) bypasses.push(`${name}:${pos.shape}`);
    rows.push({ name, char: char.codePointAt(0), shape: pos.shape, rendererHost: host, remote, flagged, bypass });
  }
  // A named reference is only ever an ALTERNATIVE spelling: the same character
  // written numerically must behave identically, and numeric runs are unbounded
  // and generic, so this measures whether the table's membership matters at all.
}

// Which ASCII-denoting HTML5 names are absent from the detector's table?
const DETECTOR_TABLE = new Set([
  "amp", "apos", "ast", "bsol", "colon", "commat", "dollar", "equals", "excl",
  "grave", "gt", "lbrack", "lowbar", "lpar", "lsqb", "lt", "newline", "num",
  "percnt", "period", "plus", "quest", "quot", "rbrack", "rpar", "rsqb", "semi",
  "sol", "tab", "tilde",
]);
const absent = Object.keys(HTML5_ASCII_NAMES).filter(
  (n) => !DETECTOR_TABLE.has(n.toLowerCase()),
);

// Of the absent ones, which denote a character the URL parser treats as syntax or
// removes? (scheme/authority delimiters, or tab/LF/CR)
const URL_SYNTAX = new Set([":", "/", String.fromCharCode(92), "?", "#", "@", "%", ".", String.fromCharCode(9), String.fromCharCode(10)]);
const absentButUrlSyntax = absent.filter((n) => URL_SYNTAX.has(HTML5_ASCII_NAMES[n]!));

// Numeric spelling of every character, as the control: it must close everything
// regardless of the named table.
const numericBypasses: string[] = [];
for (const [name, char] of Object.entries(HTML5_ASCII_NAMES)) {
  const code = char.codePointAt(0)!;
  for (const pos of positions(char)) {
    const written = pos.raw(`&#${code};`);
    const decoded = pos.raw(char);
    const host = rendererHost(decoded);
    const remote = host !== null && host !== "client.example.org";
    const flagged = detectExfil(`<img src="${written}">`, []).length > 0;
    if (remote && !flagged) numericBypasses.push(`${name}(&#${code};):${pos.shape}`);
  }
}

console.log(
  JSON.stringify(
    {
      namesTested: Object.keys(HTML5_ASCII_NAMES).length,
      shapesPerName: 5,
      casesTested: rows.length,
      namedSpellingBypasses: bypasses,
      numericSpellingBypasses: numericBypasses,
      absentFromDetectorTable: absent,
      absentButUrlSyntax,
    },
    null,
    2,
  ),
);
