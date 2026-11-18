import { describe, expect, test } from "bun:test";
import { relativeTime } from "./format";

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (s: number) => relativeTime(new Date(NOW - s * 1000).toISOString(), NOW);

describe("relativeTime", () => {
  test("rounds into the next unit at the boundary", () => {
    expect(ago(3590)).toBe(rtf.format(-1, "hour"));
    expect(ago(86_000)).toBe(rtf.format(-1, "day"));
  });

  test("inside a unit it is unchanged", () => {
    expect(ago(30)).toBe("just now");
    expect(ago(600)).toBe(rtf.format(-10, "minute"));
    expect(ago(3 * 3600)).toBe(rtf.format(-3, "hour"));
    expect(ago(3 * 86400)).toBe(rtf.format(-3, "day"));
  });

  test("days are local calendar days", () => {
    const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
    const rel = (then: number, now: number) => relativeTime(new Date(then).toISOString(), now);
    // 23:50 vs 00:10 the same day: today, not yesterday.
    expect(rel(at(2026, 10, 17, 0, 10), at(2026, 10, 17, 23, 50))).toBe(rtf.format(0, "day"));
    // 08:00 vs 21:00 two calendar days earlier (35 h): two days ago.
    expect(rel(at(2026, 10, 15, 21, 0), at(2026, 10, 17, 8, 0))).toBe(rtf.format(-2, "day"));
    // 23:00 vs 10:00 yesterday (37 h): yesterday.
    expect(rel(at(2026, 10, 16, 10, 0), at(2026, 10, 17, 23, 0))).toBe(rtf.format(-1, "day"));
  });

  test("no 60 minutes and no 24 hours", () => {
    for (let s = 3000; s < 90_000; s += 30) {
      const out = ago(s);
      expect(out).not.toBe(rtf.format(-60, "minute"));
      expect(out).not.toBe(rtf.format(-24, "hour"));
    }
  });
});
