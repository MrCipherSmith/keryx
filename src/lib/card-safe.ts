/**
 * Flow 295 (F7): the card shows text the MODEL supplied (prompt, name, repos, provider,
 * model). A line of it must never be able to draw a fake line of the card. So ANSI escape
 * sequences, C0/C1 controls and bidi overrides are removed, and a newline is shown as a
 * visible ⏎ instead of starting a new line.
 */
export function cardSafe(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- matching control characters is the point (flow 295 F7/installer)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex -- matching control characters is the point (flow 295 F7/installer)
    .replace(/\u001b[\]P^_][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\r\n|\r|\n/g, " ⏎ ")
    // eslint-disable-next-line no-control-regex -- matching control characters is the point (flow 295 F7/installer)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, " ");
}

/**
 * Flow 464: the one predicate for "the card would show this differently from how it is stored". True when `cardSafe`
 * rewrites the text, or when it holds a format, line-separator or paragraph-separator character (zero-width space and
 * joiner, word joiner, BOM, soft hyphen, tag characters, U+2028/2029) that `cardSafe` leaves in but no card draws.
 * Every field a yes stores or posts is tested with this, so a card cannot show less than what it records.
 */
export function hiddenInCard(text: string): boolean {
  return cardSafe(text) !== text || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(text);
}

export const HIDDEN_IN_CARD = "holds control, escape, newline, bidi or zero-width characters the card would hide or rewrite; send plain single-line text";
