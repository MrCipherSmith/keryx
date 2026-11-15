/** Formats an integer amount of minor units (cents) as a localized currency string. */
export function formatCents(cents: number, currency: string, locale = "en-US"): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`cents must be a safe integer, got ${cents}`);
  }
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Adds up amounts in minor units, rejecting anything that is not a whole number of cents. */
export function sumCents(values: readonly number[]): number {
  return values.reduce((sum, cents) => {
    if (!Number.isSafeInteger(cents)) {
      throw new RangeError(`cents must be a safe integer, got ${cents}`);
    }
    return sum + cents;
  }, 0);
}
