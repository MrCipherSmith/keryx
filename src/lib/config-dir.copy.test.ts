import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyConfigFileExclusive } from "./config-dir";

test("exclusive config copy preserves the private source and never replaces a destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "config-copy-"));
  try {
    const source = path.join(root, "source.jsonl");
    const target = path.join(root, "target.jsonl");
    const body = "x".repeat(2 * 1024 * 1024);
    writeFileSync(source, body, { mode: 0o600 });
    chmodSync(source, 0o600);
    expect(copyConfigFileExclusive(source, target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(body);
    expect(readFileSync(source, "utf8")).toBe(body);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    writeFileSync(target, "current journal");
    expect(copyConfigFileExclusive(source, target)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("current journal");
    if (process.platform !== "win32") {
      const link = path.join(root, "target-link");
      symlinkSync(target, link);
      expect(copyConfigFileExclusive(source, link)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("current journal");
    }
    expect(() => copyConfigFileExclusive(path.join(root, "missing"), path.join(root, "new"))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive config copy surfaces destination failures", () => {
  expect(() => copyConfigFileExclusive(
    import.meta.filename,
    path.join(import.meta.filename, "not-a-directory", "target"),
  )).toThrow();
});
