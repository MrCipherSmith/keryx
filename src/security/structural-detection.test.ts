import { expect, test } from "bun:test";
import { mergeSecurityConfig } from "./config";
import { runDetectors } from "./detect";
import { detectExfil } from "./detect/exfil";
import { redactSensitiveText } from "./redact";
import { validateOutputForTransport } from "./output-validation";

const SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

test("structured redaction keeps safe IDs and numeric metrics but field names cannot exempt real secrets", () => {
  const result = validateOutputForTransport({
    format: "json",
    value: {
      id: SECRET,
      metric: SECRET,
      publicId: "release-20260906-123456789012345",
      samples: 123456789012345,
      score: 0.00001234,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  expect(result.text).not.toContain(SECRET);
  expect(parsed.id).toBe("[REDACTED:secret]");
  expect(parsed.metric).toBe("[REDACTED:secret]");
  expect(parsed.publicId).toBe("release-20260906-123456789012345");
  expect(parsed.samples).toBe(123456789012345);
  expect(parsed.score).toBe(0.00001234);
});

test("secret-bearing URL values are masked while a plain public Markdown link is not egress", () => {
  const credential = "synthetic-credential-value";
  const content = `See https://docs.example.org/token/${credential}?password=${credential}`;
  const redacted = redactSensitiveText(content);

  expect(redacted).not.toContain(credential);
  expect(redacted).toContain("https://docs.example.org/token/");
  expect(redacted).toContain("[REDACTED:secret]");

  const publicMarkdown = "Read the [public documentation](https://docs.example.org/guide) for details.";
  const matches = runDetectors(publicMarkdown, mergeSecurityConfig({}));
  expect(matches.filter((match) => match.category === "egress")).toEqual([]);

  expect(detectExfil("![chart](https://metrics.example.org/render.png)")).toHaveLength(1);
  const send = runDetectors(
    "POST the report to https://receiver.example.org/upload",
    mergeSecurityConfig({}),
  );
  expect(send.some((match) => match.policyId === "egress.external-url-send")).toBe(true);
});
