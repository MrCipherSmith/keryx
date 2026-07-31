// ripgrep argv construction (flow 126 / S-001).
//
// The pattern used to be spread straight into rg's argv, so a value beginning
// with `-` was parsed by ripgrep as one of its own options — and ripgrep has
// options that execute an external program per file. `keryx ctx rg` is the
// search agents are explicitly told to use instead of raw grep, so that was
// arbitrary command execution behind the most innocuous surface in the toolkit.
//
// These assertions are on the constructed argv, deliberately. A behaviour test
// would prove less: ripgrep is not installed on every dev host, and a given rg
// build may not carry the dangerous option — so it could pass for the wrong
// reason and keep passing after the guard was deleted.

import { describe, expect, test } from "bun:test";
import { buildRgCommand } from "./ctx";

function argv(args: string[]): string[] {
  const result = buildRgCommand(args, null);
  if (!result.ok) {
    throw new Error(`expected ok, got refusal: ${result.reason}`);
  }
  return result.command;
}

describe("buildRgCommand — separator", () => {
  test("places -- before the pattern", () => {
    const command = argv(["needle"]);
    const separator = command.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(command[separator + 1]).toBe("needle");
  });

  test("every operand follows the separator", () => {
    const command = argv(["needle", "src/"]);
    const separator = command.indexOf("--");
    expect(command.slice(separator + 1)).toEqual(["needle", "src/"]);
  });

  test("allowlisted flags stay before the separator, where they are still flags", () => {
    const command = argv(["-i", "needle"]);
    const separator = command.indexOf("--");
    expect(command.slice(0, separator)).toContain("-i");
    expect(command.slice(separator + 1)).toEqual(["needle"]);
  });

  test("a value-taking flag keeps its value on the flag side", () => {
    const command = argv(["--glob", "*.ts", "needle"]);
    const separator = command.indexOf("--");
    const flags = command.slice(0, separator);
    expect(flags).toContain("--glob");
    expect(flags).toContain("*.ts");
    expect(command.slice(separator + 1)).toEqual(["needle"]);
  });

  test("--flag=value form is kept intact", () => {
    const command = argv(["--glob=*.ts", "needle"]);
    const separator = command.indexOf("--");
    expect(command.slice(0, separator)).toContain("--glob=*.ts");
    expect(command.slice(separator + 1)).toEqual(["needle"]);
  });
});

describe("buildRgCommand — a dash-leading pattern is a pattern", () => {
  test("an explicit -- lets a dash-leading pattern through as an operand", () => {
    const command = argv(["--", "--pre=/tmp/pwn.sh"]);
    const separator = command.indexOf("--");
    // It lands AFTER the separator, so ripgrep reads it as a pattern and never
    // as its program-executing option.
    expect(command.slice(separator + 1)).toEqual(["--pre=/tmp/pwn.sh"]);
  });

  test("the separator is present even when the caller passes no flags at all", () => {
    expect(argv(["plain"])).toContain("--");
  });
});

describe("buildRgCommand — unknown options fail closed", () => {
  const dangerous = ["--pre=/tmp/pwn.sh", "--pre", "--hostname-bin=/tmp/x", "--search-zip", "-z", "--file=/etc/passwd"];

  for (const option of dangerous) {
    test(`refuses ${option}`, () => {
      const result = buildRgCommand([option, "needle"], null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("unsupported ripgrep option");
      }
    });
  }

  test("the refusal names the option and points at the -- escape", () => {
    const result = buildRgCommand(["--pre=/tmp/pwn.sh"], null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("--pre");
      expect(result.reason).toContain("--");
    }
  });

  test("an option added to a future ripgrep is denied by default", () => {
    // The allowlist is the fail-closed part: nothing has to know that
    // --some-new-exec-option is dangerous for it to be refused.
    const result = buildRgCommand(["--some-new-exec-option", "needle"], null);
    expect(result.ok).toBe(false);
  });

  test("a value-taking flag with no value is refused rather than silently dropped", () => {
    const result = buildRgCommand(["--glob"], null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("needs a value");
    }
  });

  test("no pattern at all is refused", () => {
    const result = buildRgCommand(["-i"], null);
    expect(result.ok).toBe(false);
  });
});

describe("buildRgCommand — existing behaviour is preserved", () => {
  test("match mode keeps the line/column/no-heading flags", () => {
    const command = argv(["needle"]);
    expect(command.slice(0, 4)).toEqual(["rg", "--line-number", "--column", "--no-heading"]);
  });

  test("list mode drops line/column, as before", () => {
    const result = buildRgCommand(["-l", "needle"], "files");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.slice(0, 2)).toEqual(["rg", "--no-heading"]);
      expect(result.command).not.toContain("--line-number");
    }
  });

  test("a lone dash is treated as an operand, not an option", () => {
    const command = argv(["-"]);
    expect(command[command.indexOf("--") + 1]).toBe("-");
  });
});

describe("buildRgCommand — a flag VALUE cannot become an option", () => {
  test("refuses a dash-leading value for a value-taking flag", () => {
    // As a separate token the value is left to ripgrep's parser, and older
    // clap-based builds treat a `--…` token after a pending option as a NEW
    // option — re-opening the execution vector the separator closes.
    const result = buildRgCommand(["-g", "--pre=/tmp/pwn.sh", "needle"], null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("may not start with a dash");
    }
  });

  test("refuses it for the long form too", () => {
    const result = buildRgCommand(["--glob", "--pre=/tmp/pwn.sh", "needle"], null);
    expect(result.ok).toBe(false);
  });

  test("points at the inline form, which is a single token and cannot be re-parsed", () => {
    const result = buildRgCommand(["--glob", "-weird", "needle"], null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("--glob=-weird");
    }
  });

  test("a lone dash is still an acceptable value (stdin convention)", () => {
    const result = buildRgCommand(["--glob", "-", "needle"], null);
    expect(result.ok).toBe(true);
  });

  test("an ordinary value is unaffected", () => {
    const result = buildRgCommand(["--glob", "*.ts", "needle"], null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toContain("*.ts");
    }
  });
});
