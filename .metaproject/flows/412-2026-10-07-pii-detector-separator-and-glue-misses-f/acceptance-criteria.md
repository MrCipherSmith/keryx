# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `detectPii` reports a phone joined by "-" or "." that is followed by more digits ("415-555-0199-123456", "415.555.0199.415.555.0199"), and a test fails when that change is reverted.
- AC2: `detectPii` reports a card, IBAN, IPv4 address and phone glued to letters ("id4111111111111111", "tel415-555-0199", "GB82WEST12345698765432dolor", "192.168.1.10abc"); the Luhn and mod-97 checks stay the guard against false positives.
- AC3: `detectPii` reports an SSN, card, phone and IPv4 address written with zero-width characters, soft hyphen, U+058A, U+30FC, U+2043, newline or tab inside the number, and a card written with ".", "/" or "_" separators.
- AC4: `detectPii` reports an IBAN written with fullwidth Latin letters, with the span offsets pointing into the original text.
- AC5: A UUID-shaped token is not reported as a credit card: 200,000 random UUIDs give no `pii.credit-card` match, and 200,000 random UUIDs, sha1, sha256, md5 and base64 samples give no new SSN match against baseline 6f6d8898.
- AC6: Every rule stays linear in input length: the existing scaling tests (pii-linear-time, pii-phone-linear-time) pass, and a differential on random phone, email, name, card and SSN inputs shows every span of baseline 6f6d8898 still covered.
