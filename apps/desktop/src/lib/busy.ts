// The host refuses work it cannot take right now with a message that starts with `busy:`.
// Tauri rejects a command with its plain `Err(String)` value, the browser dev bridge with an `Error`,
// so both shapes are read here and nothing else (an unrelated error that mentions "busy" is not retried).

export const BUSY_DELAYS = [300, 900, 2000, 4000] as const;

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

/** The delay before retry `n` of a busy refusal, spread by about 20% so views that started together do not retry in lockstep. */
export function busyDelay(n: number, random: () => number = Math.random): number | undefined {
  const base = BUSY_DELAYS[n];
  return base === undefined ? undefined : Math.round(base * (0.8 + random() * 0.4));
}

/** The text after `busy:` when `error` is a host admission refusal, otherwise null. */
export function busyMessage(error: unknown): string | null {
  const message = messageOf(error);
  return /^busy:/i.test(message) ? message.replace(/^busy:\s*/i, "") : null;
}

export const isBusy = (error: unknown): boolean => busyMessage(error) !== null;
