import { describe, expect, test } from "bun:test";
import { validateOptionalWizardNumber } from "./tui-shell";

// The "add custom provider" wizard's optional numeric fields (flow 268): an
// EMPTY field must leave the key out of `llm-providers.json` entirely, and a
// garbage entry must be INVALID (the step re-asks) rather than a silent skip.
describe("custom-provider wizard optional numbers", () => {
  test("empty input is skipped — the parameter is never written", () => {
    expect(validateOptionalWizardNumber("", false)).toEqual({ kind: "skip" });
    expect(validateOptionalWizardNumber("   ", true)).toEqual({ kind: "skip" });
  });

  test("a non-numeric entry is invalid (the step re-asks), never a silent skip", () => {
    expect(validateOptionalWizardNumber("abc", false).kind).toBe("invalid");
    expect(validateOptionalWizardNumber("4096x", true).kind).toBe("invalid");
    expect(validateOptionalWizardNumber("1e999", true).kind).toBe("invalid"); // Infinity
  });

  test("temperature takes any finite number, 0 included", () => {
    expect(validateOptionalWizardNumber("0", false)).toEqual({ kind: "value", value: 0 });
    expect(validateOptionalWizardNumber("-0.5", false)).toEqual({ kind: "value", value: -0.5 });
    expect(validateOptionalWizardNumber("0.2", false)).toEqual({ kind: "value", value: 0.2 });
  });

  test("max output tokens / timeout must be a positive whole number", () => {
    expect(validateOptionalWizardNumber("8192", true)).toEqual({ kind: "value", value: 8192 });
    expect(validateOptionalWizardNumber("0", true).kind).toBe("invalid"); // a zero budget is not a setting
    expect(validateOptionalWizardNumber("-5", true).kind).toBe("invalid");
    // fractional would be saved and then drop the WHOLE llm-providers entry at
    // load time (isCustomCompatProvider's positive-integer guard).
    expect(validateOptionalWizardNumber("0.5", true).kind).toBe("invalid");
  });
});
