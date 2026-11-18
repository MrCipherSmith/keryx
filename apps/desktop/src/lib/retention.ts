// How long a session may sit untouched before the app archives it. Per-viewer, in localStorage;
// the default applies when storage is unavailable.

export const RETENTION_CHOICES = [0, 2, 4, 7, 14, 30] as const;
export const DEFAULT_RETENTION_DAYS = 4;
const KEY = "keryx.retentionDays.v1";

/** Days of inactivity before a session is archived; 0 means never. */
export function retentionDays(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    const raw = localStorage.getItem(KEY);
    return raw !== null && (RETENTION_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

export function setRetentionDays(days: number): void {
  try {
    localStorage.setItem(KEY, String(days));
  } catch {
    /* storage unavailable: the default stays */
  }
}
