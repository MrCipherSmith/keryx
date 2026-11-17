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

  test("no 60 minutes and no 24 hours", () => {
    for (let s = 3000; s < 90_000; s += 30) {
      const out = ago(s);
      expect(out).not.toBe(rtf.format(-60, "minute"));
      expect(out).not.toBe(rtf.format(-24, "hour"));
    }
  });
});
