// Flow 390, AC4 — the Outcome criteria section of the description template holds
// three lines: the verbatim request, the agent's formalization, and "how to
// observe" marked as the agent's proposal. For agent-finding and agent-proposal a
// "Источник" line replaces the request line. `init` writes the quote into the
// first line when it is given.
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { originRoot, type OriginRoot } from "./origin.test-helpers";
import { renderDescription } from "./templates";

let env: OriginRoot | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

/** The lines under `## Outcome criteria`, up to the next heading. */
function outcomeSection(description: string): string[] {
  const lines = description.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Outcome criteria");
  if (start < 0) throw new Error("no Outcome criteria section");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.trim().length > 0);
}

async function description(root: string, dir: string): Promise<string> {
  return readFile(path.join(root, dir, "description.md"), "utf8");
}

test("a human-request flow: the section holds the request, the formalization and the observation lines", async () => {
  env = await originRoot();
  const result = await env.service.init({
    cwd: env.root,
    title: "Three lines",
    origin: "human-request",
    originQuote: "сделай так, чтобы работало",
    originSource: "chat 7",
  });
  const section = outcomeSection(await description(env.root, result.dir));
  expect(section).toHaveLength(3);
  expect(section[0]).toBe("- Запрос (дословно): «сделай так, чтобы работало» (source: chat 7)");
  expect(section[1]).toStartWith("- Эффект (формализация агента): ");
  expect(section[2]).toStartWith("- Как наблюдать (предложение агента): ");
});

test.each(["agent-finding", "agent-proposal"] as const)("%s: a Source line replaces the request line", async (kind) => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: `Source for ${kind}`, origin: kind, originSource: "lint run 12" });
  const section = outcomeSection(await description(env.root, result.dir));
  expect(section).toHaveLength(3);
  expect(section[0]).toBe("- Источник: lint run 12");
  expect(section.join("\n")).not.toContain("Запрос (дословно)");
  expect(section[1]).toStartWith("- Эффект (формализация агента): ");
  expect(section[2]).toStartWith("- Как наблюдать (предложение агента): ");
});

test("a multi-line quote stays inside the first bullet, line breaks and all", async () => {
  env = await originRoot();
  const quote = "первая строка\nвторая строка";
  const result = await env.service.init({ cwd: env.root, title: "Multi", origin: "human-request", originQuote: quote, originSource: "chat 1" });
  const text = await description(env.root, result.dir);
  expect(text).toContain("- Запрос (дословно): «первая строка\n    вторая строка» (source: chat 1)");
});

test("without an origin the section keeps its hint and carries no request line", async () => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: "No origin" });
  const text = await description(env.root, result.dir);
  expect(text).toContain("## Outcome criteria");
  expect(text).not.toContain("Запрос (дословно)");
  expect(text).not.toContain("Эффект (формализация агента)");
});

test("the template renders the three lines straight from an origin", () => {
  const text = renderDescription("T", "user description", { kind: "human-request", quote: "q", source: "s" });
  expect(text).toContain("- Запрос (дословно): «q» (source: s)");
  expect(text).toContain("- Эффект (формализация агента):");
  expect(text).toContain("- Как наблюдать (предложение агента):");
});

test("insufficient evidence still keeps the human's words in the first line as a draft", async () => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: "Draft", origin: "human-request", originQuote: "сохрани мои слова" });
  expect(result.flow.origin).toBeUndefined();
  expect(await description(env.root, result.dir)).toContain("«сохрани мои слова»");
});
