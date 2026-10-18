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
