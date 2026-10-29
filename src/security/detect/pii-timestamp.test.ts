import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPii } from "./pii";
import { validateOutputForTransport } from "../output-validation";

const stamp = () => "2026-10-25T" + ["08", "19", "00", "123"].join("-") + "Z";
const phone = ["415", "555", "2671"].join("-");
const phones = (text: string) => detectPii(text).filter((match) => match.policyId === "pii.phone");

test("WI-5: timestamp artifact paths survive phone detection and transport", () => {
  for (const prefix of ["gdctx/", "wiki/history/", "health/", "testing/"]) {
    const text = `${prefix}${stamp()}.json`;
    expect(phones(text)).toEqual([]);
    expect(validateOutputForTransport({ format: "text", value: text })).toMatchObject({ ok: true, text });
  }
  const name = `${stamp()}-abcdef_tool.txt`;
  expect(phones(name)).toEqual([]);
  expect(validateOutputForTransport({ format: "json", value: { [name]: "artifact" } }))
    .toMatchObject({ ok: true, value: { [name]: "artifact" } });
});

test("WI-5: malformed timestamps receive no phone exemption", () => {
  for (const text of [stamp().replace("10-25", "02-30"), stamp().replace("08-19", "24-19"),
    stamp().replace("Z", "+24:00"), stamp().replace("Z", "+05:"), stamp() + "9"]) {
    expect(phones(text).length).toBeGreaterThan(0);
  }
});

test("WI-5: neighboring real phones remain detected", () => {
  for (const text of [`${phone} / ${stamp()}`, `${stamp()} / ${phone}`, `${stamp()}_${phone}`]) {
    expect(phones(text).some((match) => match.value.includes(phone))).toBe(true);
  }
});

test("WI-5: normalization must not manufacture timestamp exemptions", () => {
  for (const text of [stamp().replace("T", "T\u200b"), stamp().replace("08", "０８")]) {
    const input = "😀" + text;
    const matches = phones(input);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) expect(input.slice(match.start, match.end)).toBe(match.value);
  }
});

// Execution and the required RED evidence are delegated to GitHub CI.


test("WI-5: supported timestamp formats preserve exact text", () => {
  const date = "2000-02-29T";
  const samples = [
    `${date}08:19:00Z`, `${date}08:19:00.123456789+05:30`,
    `${date}08:19:00,1-0330`, `${date}08:19:00+05`,
    `${date}08-19-00-123Z`, `${date}08-19-00.123+0530`,
    `${date}08-19-00,123-03:30`, `${date}08-19-00-123`,
    "20000229T081900Z", "20000229T081900.123456789Z",
    "20000229T081900,1", `${date}08-19-00-123Z-abcdef_tool.txt`,
  ];
  for (const sample of samples) {
    const text = `artifacts/${sample}`;
    expect(phones(text)).toEqual([]);
    expect(validateOutputForTransport({ format: "text", value: text })).toMatchObject({ ok: true, text });
  }
});

test("WI-5: invalid calendar, fraction and lexical suffixes fail closed", () => {
  const invalid = [
    stamp().replace("2026-10-25", "1900-02-29"),
    stamp().replace("2026-10-25", "0000-10-25"),
    stamp().replace("10-25", "13-25"), stamp().replace("19-00", "60-00"),
    stamp().replace("00-123", "60-123"), stamp().replace("123Z", "1234567890Z"),
    stamp().replace("Z", "+05:60"), stamp().replace("Z", "+"),
    stamp().replace("Z", "+050"), stamp() + ":", stamp() + "word",
  ];
  for (const text of invalid) expect(phones(text).length).toBeGreaterThan(0);
});

test("WI-5: offsets and redaction survive repeated normalized scans", () => {
  const text = `😀 ${stamp()} / ${phone} / ${stamp()} / ${phone}`;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const matches = phones(text);
    expect(matches.map((match) => match.start)).toEqual([text.indexOf(phone), text.lastIndexOf(phone)]);
    for (const match of matches) expect(text.slice(match.start, match.end)).toBe(match.value);
    const result = validateOutputForTransport({ format: "text", value: text });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain(stamp());
      expect(result.text).not.toContain(phone);
    }
  }
});

test("WI-5: timestamp exclusion survives a normalization chunk boundary", () => {
  const text = `${" ".repeat((1 << 21) - 16)}😀${stamp()} / ${phone}`;
  const matches = phones(text);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.start).toBe(text.indexOf(phone));
  expect(matches[0]?.value).toBe(phone);
}, 30000);

test("WI-5: sanitized listing resolves a real timestamp-named artifact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-wi5-artifact-"));
  try {
    const name = `${stamp()}-abcdef_tool.txt`;
    writeFileSync(path.join(dir, name), "artifact payload");
    const result = validateOutputForTransport({ format: "text", value: readdirSync(dir).join("\n") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(name);
      expect(readFileSync(path.join(dir, result.text), "utf8")).toBe("artifact payload");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WI-5: timestamp exclusion does not hide neighboring secrets or email", () => {
  const email = ["wi5", "example.test"].join("@");
  const secret = `ghp_${"A".repeat(36)}`;
  const text = `${stamp()} / ${email} / ${secret}`;
  expect(detectPii(text).some((match) => match.policyId === "pii.email")).toBe(true);
  const result = validateOutputForTransport({ format: "text", value: text });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.text).toContain(stamp());
    expect(result.text).not.toContain(email);
    expect(result.text).not.toContain(secret);
  }
});
