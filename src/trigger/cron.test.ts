// Flow 295 (AC6, AC8): cron parsing, the OnCalendar/launchd translation, and
// the cadence phrases. The systemd translation is checked against the REAL
// `systemd-analyze calendar` where one exists: the timer must fire exactly
// when cron would.

import { describe, expect, test } from "bun:test";
import { cronToLaunchdIntervals, cronToOnCalendar, nextCronRuns, parseCadence, parseCron } from "./cron";

function local(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

describe("parseCron", () => {
  test("expands steps, ranges, lists and names; 7 is Sunday", () => {
    const parsed = parseCron("*/15 9-17/4 1,15 jan-mar sun,7");
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.fields.minutes).toEqual([0, 15, 30, 45]);
    expect(parsed.fields.hours).toEqual([9, 13, 17]);
    expect(parsed.fields.days).toEqual([1, 15]);
    expect(parsed.fields.months).toEqual([1, 2, 3]);
    expect(parsed.fields.weekdays).toEqual([0]);
  });

  test("refuses out-of-range values and non-five-field input", () => {
    expect(parseCron("61 * * * *").ok).toBe(false);
    expect(parseCron("0 2 * *").ok).toBe(false);
    expect(parseCron("0 0 2 * * *").ok).toBe(false);
  });
});

describe("cronToOnCalendar", () => {
  test("every 4 hours becomes an explicit hour list", () => {
    expect(cronToOnCalendar("0 */4 * * *")).toEqual({ ok: true, value: "*-*-* 00,04,08,12,16,20:00:00" });
  });
  test("weekdays at 09:30 carries the weekday names", () => {
    expect(cronToOnCalendar("30 9 * * 1-5")).toEqual({ ok: true, value: "Mon,Tue,Wed,Thu,Fri *-*-* 09:30:00" });
  });
  test("restricting both day-of-month and day-of-week is refused (cron ORs them; systemd ANDs them)", () => {
    const t = cronToOnCalendar("0 9 1 * 1");
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toContain("restricts BOTH day-of-month and day-of-week");
  });

  const analyze = Bun.which("systemd-analyze");
  test.skipIf(!analyze)("systemd-analyze calendar fires the translation exactly when cron would", async () => {
    const base = new Date(2026, 8, 23, 5, 7, 0);
    for (const cron of ["0 */4 * * *", "30 9 * * 1-5", "*/15 * * * *", "0 2 1,15 * *", "5 8 * * sun"]) {
      const translated = cronToOnCalendar(cron);
      if (!translated.ok) throw new Error(translated.reason);
      const proc = Bun.spawn([analyze!, "calendar", "--iterations=3", `--base-time=${local(base)}`, translated.value], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const fired = [...out.matchAll(/(?:Next elapse|Iteration #\d+): \w{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g)].map((m) => m[1]);
      expect(fired).toEqual(nextCronRuns(cron, base, 3).map(local));
    }
  });
});

describe("cronToLaunchdIntervals", () => {
  test("one dict per combination of restricted fields", () => {
    expect(cronToLaunchdIntervals("30 9 * * 1-2")).toEqual({
      ok: true,
      value: [
        { Minute: 30, Hour: 9, Weekday: 1 },
        { Minute: 30, Hour: 9, Weekday: 2 },
      ],
    });
  });
});

describe("nextCronRuns", () => {
  test("the next three runs of every 4 hours", () => {
    const base = new Date(2026, 8, 23, 5, 7, 0);
    expect(nextCronRuns("0 */4 * * *", base, 3).map(local)).toEqual(["2026-09-23 08:00:00", "2026-09-23 12:00:00", "2026-09-23 16:00:00"]);
  });
});

describe("parseCadence", () => {
  test.each([
    ["every 4 hours", "0 */4 * * *"],
    ["every 4h", "0 */4 * * *"],
    ["every 30 minutes", "*/30 * * * *"],
    ["hourly", "0 * * * *"],
    ["daily at 09:30", "30 9 * * *"],
    ["weekdays at 8:00", "0 8 * * 1-5"],
    ["every monday at 10:15", "15 10 * * 1"],
    ["0 2 * * *", "0 2 * * *"],
  ])("%s → %s", (phrase, cron) => {
    expect(parseCadence(phrase)).toEqual({ ok: true, cron, phrase });
  });

  test("uneven intervals and nonsense are refused with the accepted forms", () => {
    const five = parseCadence("every 5 hours");
    expect(five.ok).toBe(false);
    const nonsense = parseCadence("whenever you like");
    expect(nonsense.ok).toBe(false);
    if (!nonsense.ok) expect(nonsense.reason).toContain("every N hours");
  });
});
