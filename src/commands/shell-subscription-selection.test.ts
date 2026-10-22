import { expect, test } from "bun:test";
import { FakeProvider } from "../harness/provider/fake-provider";
import { runShell } from "./shell";

async function* lines(...values: string[]) { yield* values; }

test("/connect goes through the connected-provider authorization/model selection", async () => {
  const selected: unknown[] = []; const built: string[] = [];
  await runShell({ lines: lines("/connect", "/exit"), write: () => {} }, {
    initial: { provider: "fake", model: "old-model" }, clock: () => "2026-09-26T00:00:00Z", idSeq: () => "id",
    makeProvider: (name, model) => { built.push(`${name}:${model}`); return new FakeProvider([]); },
    selectProviderModel: async (_io, options) => { selected.push(options); return { provider: "openai-codex", model: "authorized-model" }; },
  });
  expect(selected).toEqual([{ onlyConnected: true }]);
  expect(built).toEqual(["fake:old-model", "openai-codex:authorized-model"]);
});

test("cancelling subscription authorization preserves the active Shell session", async () => {
  const built: string[] = []; const output: string[] = [];
  await runShell({ lines: lines("/connect", "/exit"), write: (text) => { output.push(text); } }, {
    initial: { provider: "fake", model: "old-model" }, clock: () => "2026-09-26T00:00:00Z", idSeq: () => "id",
    makeProvider: (name) => { built.push(name); return new FakeProvider([]); },
    selectProviderModel: async () => { throw new Error("ChatGPT subscription login cancelled"); },
  });
  expect(built).toEqual(["fake"]);
  expect(output.join("")).toContain("cancelled");
});
