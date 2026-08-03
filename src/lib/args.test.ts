import { describe, expect, test } from "bun:test";
import { parseBooleanFlags, optionValue } from "./args";

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

describe("optionValue accepts both flag spellings", () => {
  // `--runtime=cursor` read `undefined`, so `keryx security check-input`
  // silently fell back to its no-runtime path — the human report to stdout and
  // no decision document at all. Not cosmetic: a refusal that does not refuse,
  // reached through an argument spelling.
  test("space and equals forms agree", () => {
    expect(optionValue(["--source", "x", "--runtime", "cursor"], "--runtime")).toBe("cursor");
    expect(optionValue(["--source", "x", "--runtime=cursor"], "--runtime")).toBe("cursor");
  });

  test("a trailing flag does not swallow the next one", () => {
    // `--runtime --json` means the runtime was omitted. Returning "--json" would
    // be worse than returning nothing, because it would name a runtime nobody
    // asked for.
    expect(optionValue(["--runtime"], "--runtime")).toBeUndefined();
    expect(optionValue(["--runtime", "--json"], "--runtime")).toBeUndefined();
  });

  test("an explicit empty value is distinguishable from absence", () => {
    expect(optionValue(["--runtime="], "--runtime")).toBe("");
    expect(optionValue(["--json"], "--runtime")).toBeUndefined();
  });

  test("a longer flag sharing the prefix is not mistaken for this one", () => {
    expect(optionValue(["--runtime-id=x"], "--runtime")).toBeUndefined();
  });
});
