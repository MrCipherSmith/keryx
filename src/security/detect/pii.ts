import type { DetectorMatch, SecuritySeverity } from "../types";

// PII detectors (policies.md pii.default). Emails/phones are near-exact; address
// and person-name are context heuristics with lower confidence. Each match uses a
// typed mask ("email"/"phone"/"address"/"name") so redaction is length-hiding and
// typed per §10a.

// A scan result: `index` is where the match starts, `[0]` is its text and `[1]` an optional captured group.
// A `RegExpExecArray` satisfies it, so rules backed by a plain regex and rules backed by a hand-written
// linear scanner share one loop.
type ScanMatch = { readonly index: number; readonly [group: number]: string | undefined };
// `reset` clears whatever a scanner carries from one scan to the next, so an aborted scan cannot leak into the
// following one.
type Scanner = { lastIndex: number; exec(content: string): ScanMatch | null; reset?(): void };

type Rule = {
  policyId: string;
  mask: string;
  regex: Scanner;
  severity: SecuritySeverity;
  confidence: number;
  valueGroup?: number;
  // Block E (E4): a checksum/range validator that GATES a candidate — a match is
  // only emitted when `validate(value)` is true, so invalid-checksum items (the
  // known regex false positives) are never flagged (AC4.1, AC4.2).
  validate?: (value: string) => boolean;
};

// ---------------------------------------------------------------------------
// Structured-PII checksum validators (E4). Pure, dependency-free, deterministic.
// ---------------------------------------------------------------------------

// IBAN: structural length by-country is not enforced; correctness is the ISO
// 7064 mod-97-10 check (rearrange, letters→digits, remainder must be 1).
export function isValidIban(value: string): boolean {
  const iban = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
    return false;
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of code) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// Credit card: 13–19 digits passing the Luhn checksum (separators stripped).
export function isValidCreditCard(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// US SSN: valid area (not 000/666/900-999), group (not 00), serial (not 0000).
export function isValidSsn(value: string): boolean {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!m) return false;
  const area = Number(m[1]);
  const group = Number(m[2]);
  const serial = Number(m[3]);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0) return false;
  if (serial === 0) return false;
  return true;
}

// IPv4 (octet range) or IPv6 (structural). Rejects malformed / out-of-range.
export function isValidIp(value: string): boolean {
  const v = value.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    return v4.slice(1, 5).every((oct) => {
      if (oct === undefined) return false;
      if (oct.length > 1 && oct.startsWith("0")) return false; // no leading zeros
      const n = Number(oct);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6: 2–8 hextet groups, optional single `::` compression.
  if (/^[0-9A-Fa-f:]+$/.test(v) && v.includes(":")) {
    const doubleColon = (v.match(/::/g) ?? []).length;
    if (doubleColon > 1) return false;
    const groups = v.split(":");
    if (doubleColon === 0 && groups.length !== 8) return false;
    if (doubleColon === 1 && groups.length > 8) return false;
    return groups.every((g) => g === "" || /^[0-9A-Fa-f]{1,4}$/.test(g));
  }
  return false;
}

// The plain email regex retries every word boundary of a long local-part run that never reaches a valid
// domain, which is quadratic. Every start in a run shares one `@` and one domain, so try the run once, from
// its first boundary. Letters, digits and marks are Unicode-aware (`user@bücher.example`, `jörg@example.de`);
// the word boundary is therefore the Unicode one, not `\b`.
// The ASCII flavour is the original rule. It still runs on text with non-ASCII characters, so an address that
// the Unicode flavour reads as longer (`user@example.com` followed by `é`) is reported as it always was.
type EmailFlavour = { from: RegExp; localChar: RegExp; wordChar: RegExp };

const UNICODE_EMAIL: EmailFlavour = {
  from: /(?:(?<=[\p{L}\p{N}\p{M}_])(?![\p{L}\p{N}\p{M}_])|(?<![\p{L}\p{N}\p{M}_])(?=[\p{L}\p{N}\p{M}_]))[\p{L}\p{N}\p{M}._%+-]+@[\p{L}\p{N}\p{M}.-]+\.[\p{L}\p{M}]{2,}(?![\p{L}\p{N}\p{M}_])/uy,
  localChar: /[\p{L}\p{N}\p{M}._%+-]/u,
  wordChar: /[\p{L}\p{N}\p{M}_]/u,
};
const ASCII_EMAIL: EmailFlavour = {
  from: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/y,
  localChar: /[A-Za-z0-9._%+-]/,
  wordChar: /\w/,
};

function isWordBoundary(flavour: EmailFlavour, content: string, index: number): boolean {
  return flavour.wordChar.test(wordCharBefore(content, index)) !== flavour.wordChar.test(wordCharAt(content, index));
}

// The code point that ends at `index`, or "" at the start. `\p{L}` and friends match whole code points.
function wordCharBefore(content: string, index: number): string {
  if (index <= 0) {
    return "";
  }
  const low = content.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = content.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return content.slice(index - 2, index);
    }
  }
  return content[index - 1] as string;
}

function wordCharAt(content: string, index: number): string {
  const code = content.codePointAt(index);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function execEmail(flavour: EmailFlavour, content: string, from: number): RegExpExecArray | null {
  let at = content.indexOf("@", from);
  while (at !== -1) {
    let start = at;
    while (start > from && flavour.localChar.test(wordCharBefore(content, start))) {
      start -= wordCharBefore(content, start).length;
    }
    while (start < at && !isWordBoundary(flavour, content, start)) {
      start += wordCharAt(content, start).length;
    }
    if (start < at) {
      flavour.from.lastIndex = start;
      const m = flavour.from.exec(content);
      if (m !== null) {
        return m;
      }
    }
    at = content.indexOf("@", at + 1);
  }
  return null;
}

function emailScannerFor(flavour: EmailFlavour): Scanner {
  return {
    lastIndex: 0,
    exec(content) {
      const m = execEmail(flavour, content, this.lastIndex);
      this.lastIndex = m === null ? 0 : m.index + m[0].length;
      return m;
    },
  };
}

const emailScanner = emailScannerFor(UNICODE_EMAIL);
const asciiEmailScanner = emailScannerFor(ASCII_EMAIL);

// The plain phone regex restarts from every separator inside one long `[\d\s().-]` run and rescans
// to its end each time, which is quadratic. Whether a start matches depends only on its run, so the
// first valid start in a run that fails rules out the whole run, and one that matches leaves nothing
// after its end.
//
// A sentence-final period does not make a number part of a longer token (`Phone: 415-555-0199.`), so the
// match may be followed by `.` but not by `.` and a word character (`1.2.3.4`, `10.5.x`) or by a word character.
const PHONE_FROM = /(?<![\w.])(\+?\d[\d\s().-]{7,}\d)(?!\w|\.\w)/y;
const PHONE_RUN_CHAR = /[\d\s().-]/;
const PHONE_START_BLOCKER = /[\w.]/;
const DIGIT = /\d/;

export function execPhone(content: string, from: number): RegExpExecArray | null {
  let pos = from;
  while (pos < content.length) {
    const digitAt = content[pos] === "+" ? pos + 1 : pos;
    if (
      !DIGIT.test(content[digitAt] ?? "") ||
      (pos > 0 && PHONE_START_BLOCKER.test(content[pos - 1] as string))
    ) {
      pos += 1;
      continue;
    }
    PHONE_FROM.lastIndex = pos;
    const m = PHONE_FROM.exec(content);
    if (m !== null) {
      return m;
    }
    pos = digitAt + 1;
    while (pos < content.length && PHONE_RUN_CHAR.test(content[pos] as string)) {
      pos += 1;
    }
  }
  return null;
}

// Rejected-run rescan. A run such as `12345678 415-555-0199` or `415-555-0199 1.` is one regex match whose
// digits or shape fail the verdict as a whole, so it was dropped and the number inside leaked. The rescan looks for
// shorter spans INSIDE one rejected match and nowhere else, so the invariant above is untouched: a failed start
// still skips its whole run, and a match still leaves nothing before its end. The rescan is linear because:
//   - matches are disjoint, so each character is rescanned once per match;
//   - a candidate is a window of whitespace-separated tokens that starts at one token and ends at another. Only
//     the first token may be a country code or longer than a dialling group; every token after it must be a
//     2-4 digit dialling group, and the window holds at most 15 digits, so it spans at most 15 tokens;
//   - so each token is looked at by a bounded number of windows, and the window chosen at a start is final (the
//     rescan resumes after it, which is also what reports two numbers written one after the other).
// A rescan is only allowed to be as bold as the evidence in the window:
//   - a window must show a phone separator (`+`, `-`, a parenthesis, or a dot inside one token) or be the spaced
//     NANP shape `415 555 0199`; groups of digits separated by blanks alone (`4111 1111 1111 1111`, a row of
//     numbers, an identifier) are not a phone number;
//   - a window of several tokens must start where a run of grouped numbers starts (after a token that is not a
//     dialling group, a calendar date or a line break) or right after the previous window, never in the middle of a
//     longer run of groups;
//   - a window that overlaps a Luhn-valid card is dropped by `detectPii`.
// Column alignment (2 or more blanks, as in `hasPhoneSeparatorShape`) and a line break between two numbers are not
// part of a number, so a window never crosses one: a table or a column of 2-digit numbers is not a phone number,
// and a number beside the next column is still a number.
const PHONE_DIAL_GROUP = /^\(?\d{2,4}\)?(?:[-.]\d{2,4})*$/;
const PHONE_FIRST_GROUP = /^\+?\d{1,4}$/;
const PHONE_SEPARATOR = /[+()-]/;
const PHONE_NANP_SPACED = /^(?:\d{1,3} )?\d{3} \d{3} \d{4}$/;
const WHITESPACE = /\s/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 9;

function phoneVerdict(content: string, start: number, end: number): boolean {
  // Count up to one digit past the limit, so a long run that fails on digits is not sliced and read in full.
  let digits = 0;
  for (let i = start; i < end && digits <= PHONE_MAX_DIGITS; i += 1) {
    if (DIGIT.test(content[i] as string)) {
      digits += 1;
    }
  }
  if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) {
    return false;
  }
  const value = content.slice(start, end);
  return (
    hasPhoneSeparatorShape(value) &&
    !containsCalendarDate(value) &&
    !isIdentifierFragment(content, start, end)
  );
}

// Blank-separated digit groups are not evidence of a phone number on their own.
function hasPhoneEvidence(value: string, singleToken: boolean): boolean {
  return PHONE_SEPARATOR.test(value) || (singleToken && value.includes(".")) || PHONE_NANP_SPACED.test(value);
}

type PhoneToken = {
  start: number;
  end: number;
  coreStart: number; // first valid start (`+?\d` after a non-blocker), or -1
  coreEnd: number; // just after the last digit, or 0
  leadDigits: number; // digits before coreStart, which a window starting here does not count
  digits: number;
  breakBefore: boolean; // a window never crosses a line break or a column gap: neither is part of a number
  groupable: boolean; // a country code or dialling group that is not a calendar date: it can sit inside a phone number
};

// Splits [from, to) into whitespace-separated tokens.
function phoneTokens(content: string, from: number, to: number): PhoneToken[] {
  const tokens: PhoneToken[] = [];
  let i = from;
  while (i < to) {
    const gapStart = i;
    while (i < to && WHITESPACE.test(content[i] as string)) {
      i += 1;
    }
    if (i >= to) {
      break;
    }
    const breakBefore = tokens.length > 0 && (i - gapStart >= 2 || LINE_BREAK.test(content.slice(gapStart, i)));
    const start = i;
    let digits = 0;
    let lastDigit = -1;
    let coreStart = -1;
    let leadDigits = 0;
    while (i < to && !WHITESPACE.test(content[i] as string)) {
      const isDigit = DIGIT.test(content[i] as string);
      if (coreStart < 0) {
        const startsHere =
          (isDigit || (content[i] === "+" && i + 1 < to && DIGIT.test(content[i + 1] as string))) &&
          (i === 0 || !PHONE_START_BLOCKER.test(content[i - 1] as string));
        if (startsHere) {
          coreStart = i;
        } else if (isDigit) {
          leadDigits += 1;
        }
      }
      if (isDigit) {
        digits += 1;
        lastDigit = i;
      }
      i += 1;
    }
    const text = content.slice(start, i);
    const groupable = (PHONE_DIAL_GROUP.test(text) || PHONE_FIRST_GROUP.test(text)) && !containsCalendarDate(text);
    tokens.push({ start, end: i, coreStart, coreEnd: lastDigit + 1, leadDigits, digits, breakBefore, groupable });
  }
  return tokens;
}

function rescanPhoneRun(content: string, from: number, to: number): ScanMatch[] {
  const tokens = phoneTokens(content, from, to);
  const found: ScanMatch[] = [];
  // Digits of the grouped tokens that follow a token without a break, so a window is not left with the start of a
  // second number it could not report: `415 555 0199 415 555 0199` is two numbers, not one number and a tail.
  const chainAfter = new Array<number>(tokens.length).fill(0);
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    const next = tokens[i + 1] as PhoneToken;
    chainAfter[i] = next.groupable && !next.breakBefore ? (chainAfter[i + 1] as number) + next.digits : 0;
  }
  let first = 0;
  let resume = -1; // the token right after the last window
  while (first < tokens.length) {
    const head = tokens[first] as PhoneToken;
    if (head.coreStart < 0 || head.coreEnd <= head.coreStart) {
      first += 1;
      continue;
    }
    const startsRun = first === 0 || first === resume || head.breakBefore || !(tokens[first - 1] as PhoneToken).groupable;
    let longest = -1;
    let clean = -1;
    const consider = (last: number): void => {
      const end = (tokens[last] as PhoneToken).coreEnd;
      if (hasPhoneEvidence(content.slice(head.coreStart, end), last === first) && phoneVerdict(content, head.coreStart, end)) {
        longest = last;
        const rest = chainAfter[last] as number;
        if (rest === 0 || rest >= PHONE_MIN_DIGITS) {
          clean = last;
        }
      }
    };
    let digits = head.digits - head.leadDigits;
    if (digits >= PHONE_MIN_DIGITS) {
      consider(first);
    }
    // The first group of a longer window is a country code or a dialling group; the others are dialling groups.
    const headGroup = content.slice(head.coreStart, head.end);
    let extendable = startsRun && (PHONE_FIRST_GROUP.test(headGroup) || PHONE_DIAL_GROUP.test(headGroup));
    for (let last = first + 1; last < tokens.length && extendable; last += 1) {
      const tail = tokens[last] as PhoneToken;
      digits += tail.digits;
      if (digits > PHONE_MAX_DIGITS || tail.digits === 0 || tail.breakBefore) {
        break;
      }
      if (digits >= PHONE_MIN_DIGITS && PHONE_DIAL_GROUP.test(content.slice(tail.start, tail.coreEnd))) {
        consider(last);
      }
      extendable = PHONE_DIAL_GROUP.test(content.slice(tail.start, tail.end));
    }
    const best = clean >= 0 ? clean : longest;
    if (best >= 0) {
      const value = content.slice(head.coreStart, (tokens[best] as PhoneToken).coreEnd);
      found.push({ index: head.coreStart, 0: value, 1: value });
      first = best + 1;
      resume = first;
    } else {
      first += 1;
    }
  }
  return found;
}

// The matches `exec` returned from a retry or a rescan rather than from the regex itself; `detectPii` drops those
// that overlap a card.
const rescanned = new WeakSet<ScanMatch>();

// A number followed by other digits, or by a list marker (`415-555-0199 1.`, `415-555-0199 2)`), is one regex match
// whose digits or shape fail the verdict as a whole. Before the plain regex `execPhone` took over, the match ended
// at the longest end that is not followed by a word character or a dot, and the first end the sentence-final period
// rule now skips was the one that held the number. So a failed match retries shorter ends, longest first:
//   - `baselineEnd`, the end the earlier regex would have used (longest end followed by neither `\w` nor `.`), is
//     tried on the verdict alone, which is what that regex reported, so nothing it reported is lost;
//   - a shorter end after a blank is tried when the prefix carries phone evidence (`hasPhoneEvidence`), so
//     `415-555-0199 1` yields `415-555-0199` but `4111 1111 1111 1111` is never cut into a phone number.
// Only ends inside the first 15 digits can pass the verdict, so the work per match is at most 15 ends over the
// span up to the 16th digit. The longest end of a run is the same from every start in it, so it is found once per
// run (`runEnd`), and a match that takes a prefix resumes at the prefix end.
type PhonePrefix = { end: number; baseline: boolean };

function phoneBaselineEnd(content: string, runEnd: number): number {
  // The longest end after a digit that is followed by neither a word character nor a dot, or -1.
  for (let e = runEnd; e > 0; e -= 1) {
    if (DIGIT.test(content[e - 1] as string) && (e >= content.length || !PHONE_START_BLOCKER.test(content[e] as string))) {
      return e;
    }
  }
  return -1;
}

const phoneScanner: Scanner & {
  pending: ScanMatch[];
  cursor: number;
  runEnd: number;
  runBaseline: number;
  tailEnd: number;
  tail(content: string): ScanMatch | null;
  prefix(content: string, start: number, end: number): PhonePrefix | null;
} = {
  lastIndex: 0,
  pending: [],
  cursor: 0,
  runEnd: -1,
  runBaseline: -1,
  tailEnd: 0,
  reset() {
    this.lastIndex = 0;
    this.pending = [];
    this.cursor = 0;
    this.runEnd = -1;
    this.runBaseline = -1;
    this.tailEnd = 0;
  },
  // What is left of a run after a prefix was taken. The match that starts at the next valid start still ends at the
  // end of the run, which is the longest valid end from every start in it, so there is no need to run the regex over
  // the rest of the run again, which would make a long run of numbers quadratic.
  tail(content: string): ScanMatch | null {
    for (let pos = this.lastIndex; pos < this.tailEnd; pos += 1) {
      if (!DIGIT.test(content[pos] as string) || PHONE_START_BLOCKER.test(content[pos - 1] as string)) {
        continue;
      }
      if (this.tailEnd - pos < 9) {
        break;
      }
      const value = content.slice(pos, this.tailEnd);
      return { index: pos, 0: value, 1: value };
    }
    this.lastIndex = this.tailEnd;
    this.tailEnd = 0;
    return null;
  },
  prefix(content: string, start: number, end: number): PhonePrefix | null {
    if (this.runEnd !== end) {
      this.runEnd = end;
      this.runBaseline = phoneBaselineEnd(content, end);
    }
    let digits = 0;
    let limit = end;
    const ends: number[] = [];
    for (let i = start; i < end; i += 1) {
      const ch = content[i] as string;
      if (DIGIT.test(ch)) {
        digits += 1;
        if (digits > PHONE_MAX_DIGITS) {
          limit = i;
          break;
        }
      } else if (WHITESPACE.test(ch) && DIGIT.test(content[i - 1] as string) && digits >= PHONE_MIN_DIGITS) {
        ends.push(i);
      }
    }
    const baseline = this.runBaseline;
    if (baseline < end && baseline >= start + 9 && baseline <= limit && phoneVerdict(content, start, baseline)) {
      return { end: baseline, baseline: true };
    }
    for (let k = ends.length - 1; k >= 0; k -= 1) {
      const e = ends[k] as number;
      const value = content.slice(start, e);
      if (e !== baseline && hasPhoneEvidence(value, !WHITESPACE.test(value)) && phoneVerdict(content, start, e)) {
        return { end: e, baseline: false };
      }
    }
    return null;
  },
  exec(content) {
    for (;;) {
      if (this.cursor < this.pending.length) {
        return this.pending[this.cursor++] as ScanMatch;
      }
      this.pending = [];
      this.cursor = 0;
      let m: ScanMatch | null;
      if (this.tailEnd > this.lastIndex) {
        m = this.tail(content);
        if (m === null) {
          continue; // the rest of the run is done; the scan goes on after it
        }
      } else {
        m = execPhone(content, this.lastIndex);
        if (m === null) {
          this.lastIndex = 0;
          return null;
        }
      }
      const end = m.index + m[0].length;
      this.lastIndex = end;
      this.tailEnd = 0;
      if (phoneVerdict(content, m.index, end)) {
        return m;
      }
      const prefix = this.prefix(content, m.index, end);
      if (prefix !== null) {
        const value = content.slice(m.index, prefix.end);
        const found: ScanMatch = { index: m.index, 0: value, 1: value };
        if (!prefix.baseline) {
          rescanned.add(found);
        }
        this.lastIndex = prefix.end;
        this.tailEnd = end;
        return found;
      }
      this.pending = rescanPhoneRun(content, m.index, end);
      for (const found of this.pending) {
        rescanned.add(found);
      }
    }
  },
};

// `\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{1,4}){2,8}\b` backtracks over every way of cutting a long alphanumeric run into
// groups of 1-4, so `XX00` + 40 letters + `-` repeated costs ~1 ms per 100 characters, and above ~250k characters
// the engine gives up and returns null, which silently drops a valid IBAN that follows. This scanner returns
// exactly what the regex would (the first match in backtracking priority: a space is taken whenever present,
// groups are greedy, the last group is the longest that still ends on a word boundary) from a depth-first
// search that remembers the failed (position, groups) states, so a start costs at most 45 x 9 states and the
// whole scan is linear.
const IBAN_START = /(?<!\w)[A-Z]{2}\d{2}/g;
const IBAN_MAX_GROUPS = 8;
const IBAN_STATES = (4 + IBAN_MAX_GROUPS * 5 + 1) * (IBAN_MAX_GROUPS + 1);
const ibanFailed = new Uint32Array(IBAN_STATES);
let ibanStamp = 0;

function isIbanChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 48 && code <= 57);
}

function isAsciiWordChar(code: number): boolean {
  return isIbanChar(code) || (code >= 97 && code <= 122) || code === 95;
}

// End of the first match whose `groups` groups end at `pos`, or -1.
function ibanEnd(content: string, base: number, pos: number, groups: number): number {
  const key = (pos - base) * (IBAN_MAX_GROUPS + 1) + groups;
  if (ibanFailed[key] === ibanStamp) {
    return -1;
  }
  if (groups < IBAN_MAX_GROUPS) {
    const from = content.charCodeAt(pos) === 32 ? pos + 1 : pos;
    let run = 0;
    while (run < 4 && isIbanChar(content.charCodeAt(from + run))) {
      run += 1;
    }
    for (let length = run; length >= 1; length -= 1) {
      const end = ibanEnd(content, base, from + length, groups + 1);
      if (end >= 0) {
        return end;
      }
    }
  }
  if (groups >= 2 && !isAsciiWordChar(content.charCodeAt(pos))) {
    return pos;
  }
  ibanFailed[key] = ibanStamp;
  return -1;
}

const ibanScanner: Scanner = {
  lastIndex: 0,
  exec(content) {
    IBAN_START.lastIndex = this.lastIndex;
    let m: RegExpExecArray | null;
    while ((m = IBAN_START.exec(content)) !== null) {
      ibanStamp += 1;
      if (ibanStamp === 0xffffffff) {
        ibanFailed.fill(0);
        ibanStamp = 1;
      }
      const end = ibanEnd(content, m.index, m.index + 4, 0);
      if (end >= 0) {
        this.lastIndex = end;
        return { index: m.index, 0: content.slice(m.index, end) };
      }
      IBAN_START.lastIndex = m.index + 1;
    }
    this.lastIndex = 0;
    return null;
  },
};

const RULES: Rule[] = [
  {
    policyId: "pii.email",
    mask: "email",
    regex: emailScanner,
    severity: "medium",
    confidence: 0.85,
  },
  {
    policyId: "pii.phone",
    mask: "phone",
    // International or grouped phone numbers with at least 9 digits of signal.
    regex: phoneScanner,
    severity: "medium",
    confidence: 0.7,
    valueGroup: 1,
  },
  {
    policyId: "pii.address",
    mask: "address",
    regex:
      /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b\.?/g,
    severity: "low",
    confidence: 0.55,
  },
  {
    policyId: "pii.person-name",
    mask: "name",
    // Only when context suggests user/customer identity.
    regex:
      /\b(?:name\s+is|customer|client|user|patient|employee)(?:\s*:)?\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g,
    severity: "low",
    confidence: 0.45,
    valueGroup: 1,
  },
  // E4 structured PII — each gated by a checksum/range validator so an
  // invalid-checksum candidate is NOT flagged (eliminates known false positives).
  {
    policyId: "pii.iban",
    mask: "iban",
    regex: ibanScanner,
    severity: "high",
    confidence: 0.9,
    validate: isValidIban,
  },
  {
    policyId: "pii.credit-card",
    mask: "cc",
    regex: /\b\d(?:[ -]?\d){12,18}\b/g,
    severity: "high",
    confidence: 0.9,
    validate: isValidCreditCard,
  },
  {
    policyId: "pii.ssn",
    mask: "ssn",
    // Digit boundaries, not `\b`: `user_078-05-1120` and `x078-05-1120` are still an SSN, and nothing suppresses it.
    regex: /(?<![0-9])\d{3}-\d{2}-\d{4}(?![0-9])/g,
    severity: "high",
    confidence: 0.85,
    validate: isValidSsn,
  },
  {
    policyId: "pii.ip",
    mask: "ip",
    regex: /\b(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}|::1)\b/g,
    severity: "low",
    confidence: 0.6,
    validate: isValidIp,
  },
];

// A whitespace-separated run of numbers is a TABLE, not a phone number. The
// loose phone pattern treats spaces as grouping separators, so every row of an
// aligned numeric report (`keryx security eval`'s own output: `12  12  0  0
// 0.0000`) was masked as `[REDACTED:phone]`, making the report unreadable
// through `keryx ctx`.
//
// A phone number is therefore required to carry non-whitespace separator
// context. A candidate qualifies when either:
//   - it has no internal whitespace at all (`+14155550199`, `415-555-0199`), or
//   - every whitespace-separated group is a real dialling group of 2-4 digits,
//     apart from an optional leading country code (`+1 415 555 0199`).
// Column alignment (a run of 2+ spaces) is always rejected — no phone format
// pads its groups — and so is any group that is not a bare 2-4 digit run, which
// is what disqualifies `12  12  0  0  0.0000`.
// A dated identifier is not a dialling sequence. Flow packages are named
// `NNN-YYYY-MM-DD-<slug>`, so the prefix `001-2026-07-09` satisfies every phone
// heuristic above it: 11 digits, no whitespace, hyphen-separated 2-4 digit
// groups. Every `ls .metaproject/flows` therefore reached agents as
// `[REDACTED:phone]-managed-review-feedback-loop`, and the directory could not
// be opened — the listing is how an agent discovers a flow in the first place.
//
// The guard keys on the calendar date itself (a real month and day, 19xx/20xx),
// not on the surrounding shape, so it cannot be widened by an arbitrary digit
// run: `415-555-0199` has no valid month/day pair and stays a phone number.
const CALENDAR_DATE = /(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/;

function containsCalendarDate(value: string): boolean {
  return CALENDAR_DATE.test(value);
}

// A UUID is not a telephone number.
//
// The phone pattern bounds itself with `(?<![\w.])` / `(?![\w.])`, and a hyphen
// satisfies both — while a hyphen is also a legal separator INSIDE the pattern.
// So a digit run in the middle of a longer hyphenated identifier passed every
// test above it: in `730344f3-3668-4760-9056-bf7292686b67`, the middle
// `3668-4760-9056` is 12 digits in 2-4 digit groups, has no whitespace and
// carries no calendar date. `keryx security check-output` duly returned
// `730344f3-[REDACTED:phone]-bf7292686b67`, and the MCP surface handed that
// corrupted id to its caller.
//
// About 0.9 % of v4 UUIDs have a phone-shaped middle (46 of 5 000 measured), so
// this silently mangled roughly one identifier in a hundred, and made
// `proposal-lifecycle-parity.test.ts` — which compares the CLI's JSON against
// the MCP surface's — fail on a dice roll.
//
// The fix is a boundary, not a weaker pattern: the characters a match is
// EMBEDDED in decide it.
//
// WHICH DIRECTION THE BOUNDARY FAILS IN IS THE WHOLE DESIGN, and the first
// version got it backwards. It suppressed the match whenever the enclosing
// token carried ANY letter, on the reasoning that a dialling sequence never
// contains one. True of the sequence; false of the token around it. So
// `contact-415-555-0199-primary`, `TCK-415-555-0199-open`,
// `415-555-0199-ext205` and even `a-415-555-0199` stopped being redacted at
// all — a real number, passed through verbatim, in the detector whose entire
// job is to not do that. Two reviewers found it independently; the measurement
// is `MISSED` on all four inputs against `caught` before the guard existed.
//
// A false positive corrupts an identifier. A false negative leaks a person's
// phone number. Those are not symmetric, so the rule is now positive evidence:
// suppress ONLY where the surroundings actually look like a hex identifier —
// a UUID, a digest, a hash-prefixed id. Everything else is redacted, including
// the genuinely ambiguous `word-NNNN-NNNN-NNNN-word`, which no local signal can
// separate from a phone number in a slug.
const IDENTIFIER_CHAR = /[0-9A-Za-z_-]/;

/**
 * How far the scan walks out of the match, each way.
 *
 * `enclosingToken` runs once per surviving candidate, so an unbounded walk adds
 * a second quadratic term on adversarial input — a long identifier-shaped run
 * holding many phone-shaped candidates, each re-scanning to the same distant
 * ends. Measured at ~1.6x the unguarded cost on a 272 KB blob. The evidence
 * this function looks for is local (a UUID is 36 characters, a sha256 64), so a
 * bound costs nothing real.
 *
 * A token that exceeds the window on either side is reported TRUNCATED, and a
 * truncated token is never treated as an identifier: partial evidence must not
 * buy suppression in a detector that fails toward redaction.
 */
const TOKEN_SCAN_LIMIT = 64;

type EnclosingToken = { readonly text: string; readonly truncated: boolean };

/** The `[0-9A-Za-z_-]` run the match at `[start, end)` sits inside, bounded. */
function enclosingToken(content: string, start: number, end: number): EnclosingToken {
  let from = start;
  const floor = Math.max(0, start - TOKEN_SCAN_LIMIT);
  while (from > floor && IDENTIFIER_CHAR.test(content[from - 1] as string)) {
    from -= 1;
  }
  let to = end;
  const ceiling = Math.min(content.length, end + TOKEN_SCAN_LIMIT);
  while (to < ceiling && IDENTIFIER_CHAR.test(content[to] as string)) {
    to += 1;
  }
  const truncated =
    (from === floor && from > 0 && IDENTIFIER_CHAR.test(content[from - 1] as string)) ||
    (to === ceiling && to < content.length && IDENTIFIER_CHAR.test(content[to] as string));
  return { text: content.slice(from, to), truncated };
}

/** `8-4-4-4-12` hex — the one identifier shape that needs no heuristic at all. */
const UUID_TOKEN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * A hex run long enough, and letter-bearing enough, to be an identifier.
 *
 * The `[a-f]` requirement is what separates `f53fd8cbab7a47fd` from `20260912`:
 * a run of eight digits is a date, an amount or a number, and treating it as
 * evidence of a hash would suppress by coincidence. The length floor keeps a
 * single stray letter — the `a` in `a-415-555-0199` — from qualifying.
 */
function isHexIdentifierRun(segment: string): boolean {
  return segment.length >= 8 && /^[0-9A-Fa-f]+$/.test(segment) && /[A-Fa-f]/.test(segment);
}

/**
 * True when the candidate is a fragment of something that really is an identifier.
 *
 * Positive evidence only, in two shapes:
 *   - the whole enclosing token is a UUID, or
 *   - some part of it OUTSIDE the match is a hex run of 8+ characters carrying
 *     at least one `a`-`f` — a digest, a short hash, a hash-prefixed id.
 *
 * Anything else keeps the finding. `contact-415-555-0199-primary` and
 * `proposal-3668-4760-9056-b` are the same shape as each other and this
 * function cannot tell them apart; the first is a phone number and redacting
 * the second is the cost of saying so.
 */
function isIdentifierFragment(content: string, matchStart: number, matchEnd: number): boolean {
  const { text: token, truncated } = enclosingToken(content, matchStart, matchEnd);
  if (truncated) {
    return false; // Evidence incomplete → redact.
  }
  if (token.length === matchEnd - matchStart) {
    return false; // Nothing around it — the match IS the token.
  }
  if (UUID_TOKEN.test(token)) {
    return true;
  }
  const match = content.slice(matchStart, matchEnd);
  const before = token.slice(0, token.indexOf(match));
  const after = token.slice(token.indexOf(match) + match.length);
  return [...before.split(/[-_]/), ...after.split(/[-_]/)].some(isHexIdentifierRun);
}

// There is deliberately no identifier guard on the SSN rule. A false negative leaks a person's SSN and a
// false positive only corrupts an identifier, so an SSN-shaped value is always reported, including next to a
// hash or a label (the operator reversed the earlier "hash neighbour suppresses" rule on 2026-10-06). The one
// shape the guard could ever have suppressed, a fragment strictly inside a UUID, holds no `ddd-dd-dddd`: a UUID
// has no two-character group.

function hasPhoneSeparatorShape(value: string): boolean {
  if (/\s{2,}/.test(value)) {
    return false;
  }
  if (!/\s/.test(value)) {
    return true;
  }
  const groups = value.trim().split(/\s+/);
  return groups.every((group, index) => {
    // Leading country code: `+1`, `44`, `+380`.
    if (index === 0 && /^\+?\d{1,4}$/.test(group)) {
      return true;
    }
    // A dialling group: 2-4 digits, optionally parenthesised, optionally joined
    // to further 2-4 digit runs by `-`/`.` (`555-0199`). A lone digit or a
    // decimal (`0`, `0.0000`) is a report column, not a dialling group.
    return /^\(?\d{2,4}\)?(?:[-.]\d{2,4})*$/.test(group);
  });
}

// The detector matches that came from a phone rescan.
const rescanTag = new WeakSet<DetectorMatch>();

function scanRule(content: string, rule: Rule): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  rule.regex.reset?.();
  rule.regex.lastIndex = 0;
  let m: ScanMatch | null;
  while ((m = rule.regex.exec(content)) !== null) {
    const group = rule.valueGroup ?? 0;
    const value = m[group];
    if (value === undefined || value.length === 0) {
      continue;
    }
    // Phone candidates are judged (digit count, separator shape, dates, identifiers) inside `phoneScanner`.
    // E4: gate structured-PII candidates by their checksum/range validator.
    if (rule.validate && !rule.validate(value)) {
      continue;
    }
    const start = group === 0 ? m.index : m.index + (m[0] as string).indexOf(value);
    const match: DetectorMatch = {
      category: "pii",
      policyId: rule.policyId,
      severity: rule.severity,
      confidence: rule.confidence,
      start,
      end: start + value.length,
      value,
      mask: rule.mask,
      remediation: "Redact personal data before persisting or publishing.",
    };
    if (rescanned.has(m)) {
      rescanTag.add(match);
    }
    matches.push(match);
    if (m.index === rule.regex.lastIndex) {
      rule.regex.lastIndex += 1;
    }
  }
  return matches;
}

function scanRules(content: string): DetectorMatch[][] {
  return RULES.map((rule) => scanRule(content, rule));
}

// ---------------------------------------------------------------------------
// Normalised pass (SEC-F-004). The SSN, phone, card, IBAN and IP rules are ASCII, so `０７８-０５-１１２０`
// (fullwidth), `٠٧٨-٠٥-١١٢٠` (Arabic-Indic), `078‑05‑1120` (U+2011), and a card or IBAN grouped with a no-break
// space were all invisible to them. The content is scanned twice: as written (so everything found before is
// still found, by construction) and as a normalised copy in which each such character is replaced by the ASCII
// one it stands for. The copy has one unit per original code point at most, and a map from every unit back to
// the original offset, so spans, redaction offsets and returned values always refer to the ORIGINAL text.
// Only digits, dashes, spaces, dots, `@`, `+` and parentheses are folded: letters are left alone, so the
// name and address rules see exactly what they saw before.
// ---------------------------------------------------------------------------

const NORMALIZE_CHUNK = 1 << 21;
const NORMALIZE_OVERLAP = 512;
const NORMALIZE_SKIP = 256; // a match starting this close to a chunk's start is the previous chunk's
const NON_ASCII = /[\u0080-\uffff]/;
const DECIMAL_DIGIT = /\p{Nd}/u;
const digitValues = new Map<number, number>();

// 0-9 for a non-ASCII decimal digit, else -1. Decimal digits come in aligned runs of ten, so the value is the
// offset from the start of the contiguous run of `Nd` characters, modulo ten.
function decimalDigitValue(codePoint: number): number {
  if (codePoint < 0x660) {
    return -1; // the first non-ASCII `Nd` is U+0660
  }
  const cached = digitValues.get(codePoint);
  if (cached !== undefined) {
    return cached;
  }
  let value = -1;
  if (DECIMAL_DIGIT.test(String.fromCodePoint(codePoint))) {
    let runStart = codePoint;
    while (runStart > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(runStart - 1))) {
      runStart -= 1;
    }
    value = (codePoint - runStart) % 10;
  }
  digitValues.set(codePoint, value);
  return value;
}

// The one ASCII character a non-ASCII code point stands for in a number, or null to leave it alone.
function foldNumberChar(code: number): string | null {
  if (
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
  ) {
    return " ";
  }
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212 || code === 0x207b || code === 0x208b || code === 0xfe58 || code === 0xfe63 || code === 0xff0d) {
    return "-";
  }
  if (code === 0x2024 || code === 0xfe52 || code === 0xff0e || code === 0x3002 || code === 0xff61) {
    return ".";
  }
  if (code === 0xff20 || code === 0xfe6b) {
    return "@";
  }
  if (code === 0xff0b || code === 0x207a || code === 0x208a || code === 0xfe62) {
    return "+";
  }
  if (code === 0xff08 || code === 0x207d || code === 0x208d || code === 0xfe59) {
    return "(";
  }
  if (code === 0xff09 || code === 0x207e || code === 0x208e || code === 0xfe5a) {
    return ")";
  }
  const digit = decimalDigitValue(code);
  return digit < 0 ? null : String(digit);
}

type NormalizedWindow = { text: string; origin: Int32Array };

// `origin[i]` is the original index of the code point that produced unit `i`; `origin[text.length]` is `to`.
function normalizeWindow(content: string, from: number, to: number): NormalizedWindow | null {
  const origin = new Int32Array(to - from + 1);
  const parts: string[] = [];
  let length = 0;
  let flushed = from;
  let changed = false;
  for (let i = from; i < to; ) {
    const code = content.charCodeAt(i);
    if (code < 128) {
      origin[length++] = i;
      i += 1;
      continue;
    }
    const codePoint = content.codePointAt(i) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    const folded = foldNumberChar(codePoint);
    if (folded === null) {
      for (let k = 0; k < width; k += 1) {
        origin[length++] = i;
      }
    } else {
      changed = true;
      parts.push(content.slice(flushed, i), folded);
      flushed = i + width;
      origin[length++] = i;
    }
    i += width;
  }
  if (!changed) {
    return null;
  }
  parts.push(content.slice(flushed, to));
  origin[length] = to;
  return { text: parts.join(""), origin: origin.subarray(0, length + 1) };
}

function toOriginal(window: NormalizedWindow, start: number, end: number): [number, number] {
  let last = end;
  while (last < window.origin.length - 1 && window.origin[last] === window.origin[last - 1]) {
    last += 1; // never end between the halves of a surrogate pair
  }
  return [window.origin[start] as number, window.origin[last] as number];
}

function containedIn(spans: readonly DetectorMatch[], start: number, end: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((spans[mid] as DetectorMatch).start <= start) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const candidate = spans[high];
  return candidate !== undefined && candidate.start <= start && candidate.end >= end;
}

// Spans of one rule that overlap become one span, so the plain and the normalised pass never report the same text
// twice under two shifted spans. A merged span is a rescan span only if every part of it was.
function coalesce(content: string, spans: readonly DetectorMatch[]): DetectorMatch[] {
  const merged: DetectorMatch[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last === undefined || span.start >= last.end) {
      merged.push(span);
      continue;
    }
    const end = Math.max(last.end, span.end);
    const union: DetectorMatch = { ...last, end, value: content.slice(last.start, end) };
    if (rescanTag.has(last) && rescanTag.has(span)) {
      rescanTag.add(union);
    }
    merged[merged.length - 1] = union;
  }
  return merged;
}

// A card is written with one separator throughout (`4111 1111 1111 1111`, `4111-1111-1111-1111`, or none). A
// Luhn-valid run that mixes separators (`2026-07-09 415-555-0199`) is a coincidence of checksum, not a card.
function isUniformCard(card: DetectorMatch): boolean {
  const separators = new Set(card.value.replace(/\d/g, ""));
  return separators.size <= 1;
}

// A rescan window that overlaps a Luhn-valid card is a piece of that card, not a phone number.
function dropRescansInsideCards(spans: readonly DetectorMatch[], cards: readonly DetectorMatch[]): DetectorMatch[] {
  if (cards.length === 0 || !spans.some((span) => rescanTag.has(span))) {
    return spans as DetectorMatch[];
  }
  const sorted = cards.filter(isUniformCard).sort((a, b) => a.start - b.start);
  const reach: number[] = [];
  let farthest = 0;
  for (const card of sorted) {
    farthest = Math.max(farthest, card.end);
    reach.push(farthest);
  }
  return spans.filter((span) => {
    if (!rescanTag.has(span)) {
      return true;
    }
    let low = 0;
    let high = sorted.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((sorted[mid] as DetectorMatch).start < span.end) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return high < 0 || (reach[high] as number) <= span.start;
  });
}

const PHONE_RULE = RULES.findIndex((rule) => rule.policyId === "pii.phone");
const CARD_RULE = RULES.findIndex((rule) => rule.policyId === "pii.credit-card");

export function detectPii(content: string): DetectorMatch[] {
  const perRule = scanRules(content);
  if (NON_ASCII.test(content)) {
    // An address the Unicode flavour reads differently (it ends at a letter or digit the ASCII rule stopped at)
    // is still reported as the ASCII rule reported it.
    const emailRule = RULES[0] as Rule;
    const ascii = scanRule(content, { ...emailRule, regex: asciiEmailScanner });
    const unicode = perRule[0] as DetectorMatch[];
    const extraEmails = ascii.filter((match) => !containedIn(unicode, match.start, match.end));
    if (extraEmails.length > 0) {
      perRule[0] = [...unicode, ...extraEmails].sort((x, y) => x.start - y.start || y.end - x.end);
    }
    for (let from = 0; from < content.length; ) {
      let start = from;
      let to = Math.min(content.length, from + NORMALIZE_CHUNK);
      if (start > 0 && (content.charCodeAt(start) & 0xfc00) === 0xdc00) {
        start -= 1;
      }
      if (to < content.length && (content.charCodeAt(to - 1) & 0xfc00) === 0xd800) {
        to += 1;
      }
      const window = normalizeWindow(content, start, to);
      if (window !== null) {
        const extra = scanRules(window.text);
        extra.forEach((found, index) => {
          const base = perRule[index] as DetectorMatch[];
          const added: DetectorMatch[] = [];
          for (const match of found) {
            const [a, b] = toOriginal(window, match.start, match.end);
            if (start > 0 && a < start + NORMALIZE_SKIP) {
              continue;
            }
            if (!containedIn(base, a, b) && !containedIn(added, a, b)) {
              const copy = { ...match, start: a, end: b, value: content.slice(a, b) };
              if (rescanTag.has(match)) {
                rescanTag.add(copy);
              }
              added.push(copy);
            }
          }
          if (added.length > 0) {
            perRule[index] = coalesce(content, [...base, ...added].sort((x, y) => x.start - y.start || y.end - x.end));
          }
        });
      }
      if (to >= content.length) {
        break;
      }
      from = to - NORMALIZE_OVERLAP;
    }
  }
  perRule[PHONE_RULE] = dropRescansInsideCards(perRule[PHONE_RULE] as DetectorMatch[], perRule[CARD_RULE] as DetectorMatch[]);
  return perRule.flat();
}
