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

describe("nextCronRuns: the expression is read in the machine's local time", () => {
  function runsIn(zone: string, expression: string, from: string, count: number): string[] {
    const before = process.env["TZ"];
    process.env["TZ"] = zone;
    try {
      return nextCronRuns(expression, new Date(from), count).map((d) => d.toISOString());
    } finally {
      if (before === undefined) delete process.env["TZ"];
      else process.env["TZ"] = before;
    }
  }

  test("L-4: the same 09:00 cron is a different instant in each zone (09:00 where serve runs, not 09:00 UTC)", () => {
    expect(runsIn("UTC", "0 9 * * *", "2026-10-02T00:00:00Z", 1)).toEqual(["2026-10-02T09:00:00.000Z"]);
    expect(runsIn("America/New_York", "0 9 * * *", "2026-10-02T00:00:00Z", 1)).toEqual(["2026-10-02T13:00:00.000Z"]);
    expect(runsIn("Asia/Tokyo", "0 9 * * *", "2026-10-01T12:00:00Z", 1)).toEqual(["2026-10-02T00:00:00.000Z"]);
  });

  test("L-4: across a daylight-saving change the local hour holds and the UTC instant moves; the skipped hour has no run", () => {
    // New York leaves daylight saving on 2026-11-01: 09:00 is 13:00Z before it and 14:00Z after it
    expect(runsIn("America/New_York", "0 9 * * *", "2026-10-31T00:00:00Z", 3)).toEqual([
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
    // and on 2026-03-08 it springs forward at 02:00, so 02:30 does not exist that day
    const spring = runsIn("America/New_York", "30 2 * * *", "2026-03-07T00:00:00Z", 3);
    expect(spring.some((iso) => iso.startsWith("2026-03-08"))).toBe(false);
  });
});
