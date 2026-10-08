import { expect, test } from "bun:test";
import { scrubGrantedOutput } from "../commands/trigger-agent-task";
import { scrubDigestReportLocator } from "./digest-run";

const basename = "dig-20261002T120000-3991d42d.md";
const locator = `.metaproject/data/trigger/reports/morning/${basename}`;

test("generated locator retains the CI phone-shaped run ID", () => {
  expect(scrubDigestReportLocator(locator, {})).toBe(locator);
});

test("phone and email directories remain redacted", () => {
  const unsafe = `reports/person@example.com/+1-202-555-0198/${basename}`;
  const safe = scrubDigestReportLocator(unsafe, {});
  expect(safe).not.toContain("person@example.com");
  expect(safe).not.toContain("202-555-0198");
});

test("env secrets in and spanning the basename are not restored", () => {
  for (const secret of [basename, "3991d42d", `morning/${basename}`]) {
    expect(scrubDigestReportLocator(locator, { API_TOKEN: secret })).not.toContain(secret);
  }
});

test("arbitrary filenames have no exception", () => {
  const unsafe = "reports/person@example.com-+1-202-555-0198.md";
  expect(scrubDigestReportLocator(unsafe, {})).toBe(scrubGrantedOutput(unsafe, {}));
});
