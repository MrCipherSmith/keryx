// The one duration formatter of the TUI (flow 468, AC21).
//
// Every duration the shell prints — the busy timer, "worked for" after a turn,
// a subagent's elapsed time, a background job's duration — goes through
// `formatDuration`, so the same span never reads two ways and no surface prints
// raw seconds such as "3600.0s".
//
//   under a minute  "58.3s"
//   under an hour   "12:04.5"
//   from an hour    "1:02:15.4"   (no leading zero on the largest unit)
//
// The value is rounded to tenths of a second FIRST and the format is picked
// from the rounded value, so 59_950 ms is "1:00.0" and never "60.0s".

/** Printed for a duration that cannot be shown (NaN, infinite, negative). */
const NO_DURATION = "—";

const TENTHS_PER_SECOND = 10;
const TENTHS_PER_MINUTE = 60 * TENTHS_PER_SECOND;
const TENTHS_PER_HOUR = 60 * TENTHS_PER_MINUTE;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a span in milliseconds as `58.3s`, `12:04.5` or `1:02:15.4`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return NO_DURATION;
  }
  const total = Math.round(ms / 100);
  const tenths = total % TENTHS_PER_SECOND;
  const seconds = Math.floor(total / TENTHS_PER_SECOND) % 60;
  if (total < TENTHS_PER_MINUTE) {
    return `${seconds}.${tenths}s`;
  }
  const minutes = Math.floor(total / TENTHS_PER_MINUTE) % 60;
  if (total < TENTHS_PER_HOUR) {
    return `${minutes}:${pad2(seconds)}.${tenths}`;
  }
  const hours = Math.floor(total / TENTHS_PER_HOUR);
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}
