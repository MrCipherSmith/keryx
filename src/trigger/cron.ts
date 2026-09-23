// Flow 295 (AC6, AC8): cron parsing and translation for installed schedules.
//
// A trigger's cadence is written as a five-field cron expression, because that is
// what `triggers.json` has always accepted. Installing it needs three more forms:
//
//   - systemd `OnCalendar=`. Flow 286 printed only a commented placeholder, so
//     that timer never fired. Here each field is EXPANDED to an explicit value
//     list, which is always valid systemd calendar syntax. That sidesteps the
//     semantics cron and systemd disagree on (`*/n` anchors and range steps).
//   - launchd `StartCalendarInterval`, a list of dicts, again from the expansion.
//   - the next few run times, which the confirmation card shows so the operator
//     can catch a wrong translation before anything is installed.
//
// One cron meaning is not expressible: when BOTH day-of-month and day-of-week
// are restricted, cron fires on EITHER, while systemd and launchd need BOTH. Such
// an expression is refused for installation rather than silently changed.
//
// `parseCadence` also accepts the few phrases an operator or the agent says
// ("every 4 hours", "daily at 09:30", "weekdays at 8:00") and turns them into
// cron deterministically. The model never writes the cron itself.
//
// Pure: no I/O, no clock unless one is passed.

export interface CronFields {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: readonly number[];
  readonly months: readonly number[];
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekdays: readonly number[];
  readonly dayRestricted: boolean;
  readonly weekdayRestricted: boolean;
}

export type CronParse = { readonly ok: true; readonly fields: CronFields } | { readonly ok: false; readonly reason: string };

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SYSTEMD_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseValue(token: string, names: readonly string[] | undefined, offset: number): number {
  const lower = token.toLowerCase();
  if (names !== undefined) {
    const at = names.indexOf(lower);
    if (at >= 0) return at + offset;
  }
  if (!/^\d+$/.test(token)) return Number.NaN;
  return Number(token);
}

function expandField(field: string, min: number, max: number, names?: readonly string[], nameOffset = 0): number[] | string {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined || rangePart.length === 0) return `"${field}" has an empty element`;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) return `"${field}" has an invalid step`;
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = parseValue(a ?? "", names, nameOffset);
      end = parseValue(b ?? "", names, nameOffset);
    } else {
      start = parseValue(rangePart, names, nameOffset);
      end = stepPart === undefined ? start : max;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
      return `"${field}" is outside ${min}-${max}`;
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parse a five-field cron expression (minute hour day-of-month month day-of-week). */
export function parseCron(expression: string): CronParse {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, reason: `"${expression}" is not a five-field cron expression (minute hour day month weekday)` };
  }
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = expandField(m, 0, 59);
  const hours = expandField(h, 0, 23);
  const days = expandField(dom, 1, 31);
  const months = expandField(mon, 1, 12, MONTH_NAMES, 1);
  const weekdaysRaw = expandField(dow, 0, 7, DAY_NAMES, 0);
  for (const [label, value] of [
    ["minute", minutes],
    ["hour", hours],
    ["day-of-month", days],
    ["month", months],
    ["day-of-week", weekdaysRaw],
  ] as const) {
    if (typeof value === "string") return { ok: false, reason: `cron ${label} field ${value}` };
  }
  const weekdays = [...new Set((weekdaysRaw as number[]).map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    ok: true,
    fields: {
      minutes: minutes as number[],
      hours: hours as number[],
      days: days as number[],
      months: months as number[],
      weekdays,
      dayRestricted: dom !== "*",
      weekdayRestricted: dow !== "*",
    },
  };
}

function isFull(values: readonly number[], min: number, max: number): boolean {
  return values.length === max - min + 1;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export type Translation = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/** Refuse what systemd/launchd cannot express the same way. */
function installableProblem(fields: CronFields): string | undefined {
  if (fields.dayRestricted && fields.weekdayRestricted) {
    return (
      "restricts BOTH day-of-month and day-of-week — cron fires on either, a systemd/launchd calendar only on both. " +
      "Split it into two schedules, or restrict only one of the two."
    );
  }
  return undefined;
}

/** Translate cron to a systemd `OnCalendar=` value with the same firing times. */
export function cronToOnCalendar(expression: string): Translation {
  const parsed = parseCron(expression);
  if (!parsed.ok) return parsed;
  const f = parsed.fields;
  const problem = installableProblem(f);
  if (problem !== undefined) return { ok: false, reason: `"${expression}" ${problem}` };
  const list = (values: readonly number[], min: number, max: number, fmt: (n: number) => string): string =>
    isFull(values, min, max) ? "*" : values.map(fmt).join(",");
  const weekday = f.weekdayRestricted && !isFull(f.weekdays, 0, 6) ? `${f.weekdays.map((d) => SYSTEMD_DAYS[d]).join(",")} ` : "";
  const date = `*-${list(f.months, 1, 12, pad)}-${list(f.days, 1, 31, pad)}`;
  const time = `${list(f.hours, 0, 23, pad)}:${list(f.minutes, 0, 59, pad)}:00`;
  return { ok: true, value: `${weekday}${date} ${time}` };
}

/** launchd `StartCalendarInterval` dicts. At most 256 entries; beyond that the cadence is refused for launchd. */
export function cronToLaunchdIntervals(expression: string): { ok: true; value: Record<string, number>[] } | { ok: false; reason: string } {
  const parsed = parseCron(expression);
  if (!parsed.ok) return parsed;
  const f = parsed.fields;
  const problem = installableProblem(f);
  if (problem !== undefined) return { ok: false, reason: `"${expression}" ${problem}` };
  const axes: [string, readonly number[] | undefined][] = [
    ["Minute", isFull(f.minutes, 0, 59) ? undefined : f.minutes],
    ["Hour", isFull(f.hours, 0, 23) ? undefined : f.hours],
    ["Day", isFull(f.days, 1, 31) ? undefined : f.days],
    ["Month", isFull(f.months, 1, 12) ? undefined : f.months],
    ["Weekday", f.weekdayRestricted && !isFull(f.weekdays, 0, 6) ? f.weekdays : undefined],
  ];
  let combos: Record<string, number>[] = [{}];
  for (const [key, values] of axes) {
    if (values === undefined) continue;
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
    if (combos.length > 256) return { ok: false, reason: `"${expression}" expands to more than 256 launchd calendar intervals` };
  }
  return { ok: true, value: combos };
}

/** The next `count` run times (UTC-agnostic: evaluated in the given `from`'s local time), up to one year ahead. */
export function nextCronRuns(expression: string, from: Date, count: number): Date[] {
  const parsed = parseCron(expression);
  if (!parsed.ok) return [];
  const f = parsed.fields;
  const minutes = new Set(f.minutes);
  const hours = new Set(f.hours);
  const days = new Set(f.days);
  const months = new Set(f.months);
  const weekdays = new Set(f.weekdays);
  const out: Date[] = [];
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (out.length < count && t.getTime() <= limit) {
    if (!months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    const dayOk =
      f.dayRestricted && f.weekdayRestricted
        ? days.has(t.getDate()) || weekdays.has(t.getDay())
        : days.has(t.getDate()) && weekdays.has(t.getDay());
    if (!dayOk) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (minutes.has(t.getMinutes())) out.push(new Date(t.getTime()));
    t.setMinutes(t.getMinutes() + 1);
  }
  return out;
}

export type CadenceParse = { readonly ok: true; readonly cron: string; readonly phrase: string } | { readonly ok: false; readonly reason: string };

/**
 * Turn what an operator says into cron, deterministically: a five-field cron
 * expression as is, `@hourly`/`@daily`/`@weekly`, "every N minutes|hours",
 * "hourly", "daily [at HH:MM]", "every day at HH:MM", "weekdays at HH:MM",
 * "every monday at HH:MM".
 */
export function parseCadence(text: string): CadenceParse {
  const raw = text.trim();
  const lower = raw.toLowerCase().replace(/\s+/g, " ");
  const done = (cron: string): CadenceParse => {
    const parsed = parseCron(cron);
    return parsed.ok ? { ok: true, cron, phrase: raw } : { ok: false, reason: parsed.reason };
  };
  if (/^\S+ \S+ \S+ \S+ \S+$/.test(raw) && /^[0-9*/,a-zA-Z -]+$/.test(raw) && !/[a-z]{4,}/i.test(raw)) return done(raw);
  if (lower === "@hourly" || lower === "hourly" || lower === "every hour") return done("0 * * * *");
  if (lower === "@daily" || lower === "daily" || lower === "every day") return done("0 9 * * *");
  if (lower === "@weekly" || lower === "weekly") return done("0 9 * * 1");
  const every = /^every (\d{1,3}) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(lower);
  if (every !== null) {
    const n = Number(every[1]);
    const unit = every[2]!.startsWith("m") ? "minute" : "hour";
    if (unit === "minute") {
      if (n < 5 || n > 59 || 60 % n !== 0) {
        return { ok: false, reason: `every ${n} minutes: use a divisor of 60 from 5 to 30 (5, 10, 15, 20, 30) so runs are evenly spaced` };
      }
      return done(`*/${n} * * * *`);
    }
    if (n < 1 || n > 23 || 24 % n !== 0) {
      return { ok: false, reason: `every ${n} hours: use a divisor of 24 (1, 2, 3, 4, 6, 8, 12) so runs are evenly spaced` };
    }
    return done(n === 1 ? "0 * * * *" : `0 */${n} * * *`);
  }
  const at = /(?:^| )at (\d{1,2})(?::(\d{2}))?$/.exec(lower);
  const hour = at !== null ? Number(at[1]) : 9;
  const minute = at !== null && at[2] !== undefined ? Number(at[2]) : 0;
  if (hour > 23 || minute > 59) return { ok: false, reason: `"${raw}": the time must be HH:MM, 00:00-23:59` };
  const head = at !== null ? lower.slice(0, at.index).trim() : lower;
  if (head === "daily" || head === "every day") return done(`${minute} ${hour} * * *`);
  if (head === "weekdays" || head === "every weekday" || head === "on weekdays") return done(`${minute} ${hour} * * 1-5`);
  const day = /^(?:every |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?$/.exec(head);
  if (day !== null) return done(`${minute} ${hour} * * ${DAY_NAMES.indexOf(day[1]!.slice(0, 3))}`);
  return {
    ok: false,
    reason:
      `"${raw}" is not a cadence keryx understands — use a cron expression, "every N hours", "every N minutes", ` +
      '"hourly", "daily at HH:MM", "weekdays at HH:MM" or "every monday at HH:MM"',
  };
}
