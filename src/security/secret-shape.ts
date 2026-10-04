// Secret shapes the shared redactor does not catch (flow 399, reused by flow 401).
//
// `redactSensitiveText` knows the credential patterns it was given, and it mangles a Telegram
// bot token's number as a phone. A pasted token can therefore come through whole or half. These
// two helpers are the guard written against that blind spot: `looksLikeSecret` answers yes/no for a
// whole text, `maskSecretRuns` replaces only the offending runs so the rest of a sentence survives.
// Pure.

const BOT_TOKEN_SHAPE = /\d{6,}:[A-Za-z0-9_-]{30,}/;
const BOT_TOKEN_SHAPE_GLOBAL = /\d{6,}:[A-Za-z0-9_-]{30,}/g;
// base64url runs from 32; a standard-base64 run (`+`, `/`) only from 40, because a URL path or a
// file path is a long run of letters, digits and slashes too and a 32-byte token is 43 characters.
const TOKEN_RUN = /[A-Za-z0-9_-]{32,}|[A-Za-z0-9+/]{40,}={0,2}/g;

// The words of a run: `Capitalised`, `lower`, `UPPER` (up to a following capitalised word), digits, a separator.
const RUN_PARTS = /[A-Z][a-z]+|[a-z]+|[A-Z]+(?![a-z])|\d+|[-_]/g;

/**
 * Whether a mixed-case run with a digit in it is a camelCase or snake_case identifier
 * (`createManagedReviewPackageForVersion2Handler`) and not a random token. Every word of an
 * identifier is a word: three letters or more (one or two only as the `v` of `v2` or the `V` of
 * `V2`, straight before its number), and at most three digits in a row. A base64 or hex token breaks
 * into one- and two-letter pieces and single digits within a few characters, so a 32-character
 * secret passing this is not a practical case. Pure.
 */
function isIdentifier(run: string): boolean {
  const parts = run.match(RUN_PARTS) ?? [];
  if (parts.join("") !== run) return false;
  // An identifier carries a version or two; a token scatters digits through the whole run.
  if (parts.filter((part) => /\d/.test(part)).length > 2) return false;
  return parts.every((part, index) => {
    if (/\d/.test(part)) return part.length <= 3;
    if (/[-_]/.test(part)) return true;
    return part.length >= 3 || /\d/.test(parts[index + 1] ?? "");
  });
}

function isSecretRun(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !isIdentifier(run);
}

/**
 * Whether `text` carries something that looks like a credential. The shared redactor catches the
 * shapes it knows (and mangles a Telegram bot token's number as a phone), so a pasted token can
 * come through whole or half. A restored turn is old text nobody is looking at: when in doubt it
 * is hidden, not posted. Two shapes: a Telegram bot token (`123456789:AAH…`), and any bare run of
 * 32 or more token characters (40 for the `+` and `/` alphabet) that mixes upper case, lower case and digits (a base64url or base64
 * secret; a hex hash is lower case only, a word has no digits, so neither matches), unless the run is
 * made only of words (a long camelCase identifier with a version number in it). Pure.
 */
export function looksLikeSecret(text: string): boolean {
  if (BOT_TOKEN_SHAPE.test(text)) return true;
  for (const run of text.match(TOKEN_RUN) ?? []) {
    if (isSecretRun(run)) return true;
  }
  return false;
}

/** `text` with every run that `looksLikeSecret` would flag replaced by `mask`. Pure. */
export function maskSecretRuns(text: string, mask: string): string {
  return text
    .replace(BOT_TOKEN_SHAPE_GLOBAL, mask)
    .replace(TOKEN_RUN, (run) => (isSecretRun(run) ? mask : run));
}
