import { expect, test } from "bun:test";
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

test("F3: benign output is returned unchanged (no false positives on plain text)", () => {
  const out = "total 4\ndrwxr-xr-x  2 user group 4096 Jan  1 00:00 src\n";
  expect(redactSensitiveText(out)).toBe(out);
});

test("F3: empty output is a no-op", () => {
  expect(redactSensitiveText("")).toBe("");
});
