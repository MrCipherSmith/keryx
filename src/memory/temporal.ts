import type { MemoryEntry } from "./types";

/** The canonical event-time interval contract: [Valid-From, Valid-To). */
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

export function validateCalendarDate(value: string, field = "date"): string {
  if (!isValidCalendarDate(value)) {
    throw new TemporalValidationError(field, `must be a real calendar date in YYYY-MM-DD form (received ${JSON.stringify(value)})`);
  }
  return value;
}

export class TemporalValidationError extends Error {
  readonly code = "invalid-temporal-date";
  readonly action = "Provide a real calendar date in YYYY-MM-DD form.";

  constructor(readonly field: string, detail: string) {
    super(`${field} ${detail}`);
    this.name = "TemporalValidationError";
  }
}

export function currentDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** True when an entry's optional validity interval contains the supplied day. */
export function isValidAt(entry: Pick<MemoryEntry, "validFrom" | "validTo">, day: string): boolean {
  if (!isValidCalendarDate(day)) return false;
  if (entry.validFrom && !isValidCalendarDate(entry.validFrom)) return false;
  if (entry.validTo && !isValidCalendarDate(entry.validTo)) return false;
  if (entry.validFrom && entry.validFrom > day) return false;
  if (entry.validTo && entry.validTo <= day) return false;
  return true;
}

export function isCurrentAt(entry: Pick<MemoryEntry, "validFrom" | "validTo" | "supersededBy">, now: Date): boolean {
  return !entry.supersededBy && isValidAt(entry, currentDay(now));
}

export function validateAsOf(value: string, now: Date): string {
  validateCalendarDate(value, "as-of");
  // As-of is historical/event-time inspection and may intentionally target a
  // planned future date. Future *entries* remain excluded from current recall
  // through isCurrentAt; the query itself only needs a real calendar date.
  return value;
}
