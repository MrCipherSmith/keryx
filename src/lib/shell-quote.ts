/** One POSIX shell word: single-quoted, so a file name cannot add a second command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A shell word that stays readable when it needs no quoting (`/tmp/pkg`) and is single-quoted otherwise. */
export function shellWord(value: string): string {
  return SAFE_WORD.test(value) && !value.startsWith("-") ? value : shellQuote(value);
}
