// The model config option's shape and lookup (flow 288, AC5/AC7).

import { describe, expect, test } from "bun:test";
import { acpModelChoice, acpModelConfigOption, findAcpModelChoice } from "./models";

const choices = [
  acpModelChoice("anthropic", "claude-sonnet-5"),
  acpModelChoice("openrouter", "anthropic/claude-sonnet-5"),
  acpModelChoice("ollama", "llama3:8b", "http://localhost:11434"),
];

describe("the model option", () => {
  test("is one select of category model, in the published shape, with the running model current", () => {
    const option = acpModelConfigOption(choices, choices[1]!);
    expect(option).toEqual({
      id: "model",
      name: "Model",
      description: expect.any(String),
      category: "model",
      type: "select",
      currentValue: "openrouter/anthropic/claude-sonnet-5",
      options: [
        { value: "anthropic/claude-sonnet-5", name: "claude-sonnet-5", description: "anthropic" },
        { value: "openrouter/anthropic/claude-sonnet-5", name: "anthropic/claude-sonnet-5", description: "openrouter" },
        { value: "ollama/llama3:8b", name: "llama3:8b", description: "ollama" },
      ],
    });
  });

  test("the running model is listed even when the source did not list it", () => {
    const running = acpModelChoice("zai", "glm-5");
    const option = acpModelConfigOption(choices, running);
    expect(option.currentValue).toBe("zai/glm-5");
    expect(option.options.map((entry) => ("value" in entry ? entry.value : ""))).toContain("zai/glm-5");
  });
});

describe("finding a choice", () => {
  test("by exact wire value — a model id containing `/` is never parsed apart", () => {
    expect(findAcpModelChoice(choices, "openrouter/anthropic/claude-sonnet-5", false)?.providerId).toBe("openrouter");
  });

  test("a bare model id only for /model, and only when exactly one provider has it", () => {
    expect(findAcpModelChoice(choices, "llama3:8b", false)).toBeUndefined();
    expect(findAcpModelChoice(choices, "llama3:8b", true)?.value).toBe("ollama/llama3:8b");
    const ambiguous = [...choices, acpModelChoice("other", "llama3:8b")];
    expect(findAcpModelChoice(ambiguous, "llama3:8b", true)).toBeUndefined();
  });
});
