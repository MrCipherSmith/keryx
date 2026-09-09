import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "./redact";

// F3: tool output is scrubbed before it enters provider-bound agent history, so a
// command that reads a credential does not leak the raw value into the model
// context. These lock the redactor's behaviour on representative secrets.

test("F3: an AWS access key in tool output is redacted", () => {
  const out = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n";
  const scrubbed = redactSensitiveText(out);
  expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(scrubbed).toContain("[REDACTED:");
});

test("F3: a GitHub token in tool output is redacted", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const scrubbed = redactSensitiveText(`token=${token}`);
  expect(scrubbed).not.toContain(token);
  expect(scrubbed).toContain("[REDACTED:");
});

// keryx session 4a24a760: a `cat`-style read of the provider credential store
// reached the transcript with one key masked and the other printed in full. The
// masked one merely happened to carry an `sk-` prefix; the JSON assignment form
// itself was never recognised, so ANY key without a known prefix was published.
test("F3: every key in a JSON credential store is redacted, not just prefixed ones", () => {
  const zai = "7ab31d0c62f94e8ab5c1739de28f406b.Kq3nZt7vXb1mR9wa";
  // Deliberately not key-shaped beyond the prefix: the point is only that a
  // recognised prefix is what the provider-shaped rules key on. A hex body here
  // trips push protection on a fixture that is not a credential at all.
  const deepseek = "sk-fixture-value-not-a-real-credential";
  const authJson = [
    "{",
    '  "provider": "deepseek",',
    `  "apiKeys": {`,
    `    "DEEPSEEK_API_KEY": "${deepseek}",`,
    `    "ZAI_API_KEY": "${zai}"`,
    "  }",
    "}",
  ].join("\n");

  const scrubbed = redactSensitiveText(authJson);

  expect(scrubbed).not.toContain(zai);
  expect(scrubbed).not.toContain(deepseek);
  // The key NAMES stay readable — the operator must still see which credential
  // was involved; only the values are masked.
  expect(scrubbed).toContain("ZAI_API_KEY");
  expect(scrubbed).toContain("DEEPSEEK_API_KEY");
});

test("F3: a quoted YAML-style credential assignment is redacted", () => {
  const value = "7ab31d0c62f94e8ab5c1739de28f406b";
  const scrubbed = redactSensitiveText(`AUTH_TOKEN: "${value}"`);
  expect(scrubbed).not.toContain(value);
});

test("F3: benign output is returned unchanged (no false positives on plain text)", () => {
  const out = "total 4\ndrwxr-xr-x  2 user group 4096 Jan  1 00:00 src\n";
  expect(redactSensitiveText(out)).toBe(out);
});

test("F3: empty output is a no-op", () => {
  expect(redactSensitiveText("")).toBe("");
});

describe("the case redactSensitiveText's own contract names", () => {
  // Its doc comment says it exists so that "a contained shell command that
  // reads a credential (`cat ~/.aws/credentials`, `env`) must not leak the raw
  // value into the model context and onward to the provider". Both forms of
  // that exact file went through untouched until 2026-09-09: the uppercase
  // env-assignment rule only matched names ENDING in SECRET/API_KEY/TOKEN, and
  // `AWS_SECRET_ACCESS_KEY` ends in ACCESS_KEY — while the file itself writes
  // the name in lower case, which that rule could not match in any form.
  const value = "Kq3nZ8vTt1cLpR7yWx0bA5dGf2HjMn6QsUv9Ye4Z";

  test("the credentials file, as the file actually writes it", () => {
    const text = `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${value}\n`;
    expect(redactSensitiveText(text)).not.toContain(value);
  });

  test("the environment variable, as `env` prints it", () => {
    expect(redactSensitiveText(`AWS_SECRET_ACCESS_KEY=${value}`)).not.toContain(value);
  });

  test("an OAuth client secret", () => {
    expect(redactSensitiveText("client_secret: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  test("prose and identifiers are left alone", () => {
    // A redactor that mangles legitimate text gets turned off, so the lowercase
    // rule is a short list of names that mean one thing rather than a
    // case-insensitive sweep for the word "secret".
    const prose = "the secret access key is stored elsewhere";
    expect(redactSensitiveText(prose)).toBe(prose);
    const code = 'const secretAccessKeyName = "aws";';
    expect(redactSensitiveText(code)).toBe(code);
  });
});
