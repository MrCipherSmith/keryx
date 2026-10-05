// A granted `gh` tool answers with JSON that keryx itself parses (intake, digest). The PII detector reads an 11-digit
// GitHub run or comment id as a phone number and writes `[REDACTED:phone]` where the number was, which is no longer JSON.
// This hides the ids behind letter-only placeholders for the detector's pass and puts them back after it. Only two
// kinds of text are hidden: a bare JSON number, and the digits of the path of a github.com URL string. Every string
// value is still scanned, so a phone number or a token inside a title or a comment body is masked as before.

const PLACEHOLDER = "kxjsonid";
const GITHUB_URL_PREFIX = /^https:\/\/(?:api\.)?github\.com\/(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//;
const GITHUB_URL_REST = /^(?:actions\/runs|pull|issues)\/\d+(?:\/[A-Za-z0-9_-]+)*(?:#[A-Za-z_-]+-?\d+)?$/;
// A number under a key like this may be the secret itself, so the detector keeps seeing it.
const SENSITIVE_KEY = /token|secret|pass|key|auth|credential|private|ssn|phone|card|account|iban|pin|otp/i;
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export interface ProtectedJson {
  readonly text: string;
  restore(scrubbed: string): string;
}

/** The decimal digits of `index`, each written as the letter a-j, so no digit survives for a phone pattern to find. */
function letters(index: number): string {
  return String(index).replace(/\d/g, (d) => String.fromCharCode(97 + Number(d)));
}

/** `undefined` when `text` is not one whole JSON document, or already holds the placeholder word. */
export function protectJsonIds(text: string): ProtectedJson | undefined {
  const head = text.trim();
  if (head.length === 0 || (head[0] !== "[" && head[0] !== "{")) return undefined;
  if (text.includes(PLACEHOLDER)) return undefined;
  try {
    JSON.parse(head);
  } catch {
    return undefined;
  }

  const hidden: string[] = [];
  const hide = (value: string): string => {
    hidden.push(value);
    return `${PLACEHOLDER}${letters(hidden.length - 1)}x`;
  };

  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const literal = text.slice(i, j + 1);
      const inner = literal.slice(1, -1);
      const prefix = GITHUB_URL_PREFIX.exec(inner);
      const rest = prefix === null ? "" : inner.slice(prefix[0].length);
      out += prefix !== null && GITHUB_URL_REST.test(rest) ? `"${prefix[0]}${rest.replace(/\d+/g, hide)}"` : literal;
      i = j + 1;
      continue;
    }
    const number = ch === "-" || (ch >= "0" && ch <= "9") ? NUMBER.exec(text.slice(i, i + 40)) : null;
    if (number !== null) {
      const key = /"((?:[^"\\]|\\.)*)"\s*:\s*$/.exec(out.slice(-120))?.[1] ?? "";
      out += SENSITIVE_KEY.test(key) ? number[0] : hide(number[0]);
      i += number[0].length;
      continue;
    }
    out += ch;
    i += 1;
  }

  return {
    text: out,
    restore: (scrubbed) =>
      scrubbed.replace(new RegExp(`${PLACEHOLDER}([a-j]+)x`, "g"), (whole, index: string) => {
        const at = Number(index.replace(/[a-j]/g, (c) => String(c.charCodeAt(0) - 97)));
        return hidden[at] ?? whole;
      }),
  };
}
