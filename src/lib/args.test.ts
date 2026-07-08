import { expect, test } from "bun:test";
import { parseBooleanFlags } from "./args";

test("parseBooleanFlags keeps positionals and maps help short flag", () => {
  const parsed = parseBooleanFlags(["build", "-h"], ["help"] as const);

  expect(parsed.positionals).toEqual(["build"]);
  expect(parsed.values.help).toBe(true);
});

test("parseBooleanFlags leaves unknown flags as positionals-compatible parse input", () => {
  const parsed = parseBooleanFlags(["open", "--unknown"], ["help"] as const);

  expect(parsed.positionals).toEqual(["open"]);
  expect(parsed.values.help).toBe(false);
});
