import { afterEach, expect, test } from "bun:test";
import { colorEnabled, style, symbols } from "./ui";

const savedNoColor = process.env.NO_COLOR;
const savedForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  restore("NO_COLOR", savedNoColor);
  restore("FORCE_COLOR", savedForceColor);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("NO_COLOR disables color even when FORCE_COLOR is set", () => {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "1";
  expect(colorEnabled()).toBe(false);
  expect(style.green("ok")).toBe("ok");
});

test("FORCE_COLOR emits ANSI escape codes wrapping the text", () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  expect(colorEnabled()).toBe(true);
  const painted = style.cyan("hi");
  expect(painted).toContain("hi");
  expect(painted).toContain("[36m");
  expect(painted).toContain("[39m");
});

test("symbols are stable plain-text glyphs", () => {
  expect(symbols.ok).toBe("✓");
  expect(symbols.arrow).toBe("→");
});
