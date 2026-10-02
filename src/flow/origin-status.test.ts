// Flow 390, AC3 — agent-finding and agent-proposal are accepted with a source and
// shown by `flow status`.
import { afterEach, expect, test } from "bun:test";
import { originRoot, plain, readRawFlow, runFlowCli, type OriginRoot } from "./origin.test-helpers";
import { flowCommand } from "../commands/flow";

let env: OriginRoot | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

test.each(["agent-finding", "agent-proposal"] as const)("%s is accepted with a source and written to flow.json", async (kind) => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: `A ${kind}`, origin: kind, originSource: "review-pr: finding 3" });
  expect(result.originNote).toBeUndefined();
  expect(result.flow.origin).toEqual({ kind, source: "review-pr: finding 3" });
  expect((await readRawFlow(env.root, result.dir)).origin).toEqual({ kind, source: "review-pr: finding 3" });
});

test("an agent kind keeps an optional quote", async () => {
  env = await originRoot();
  const result = await env.service.init({
    cwd: env.root,
    title: "With a quote",
    origin: "agent-proposal",
    originSource: "design discussion",
    originQuote: "what if init asked",
  });
  expect(result.flow.origin).toEqual({ kind: "agent-proposal", source: "design discussion", quote: "what if init asked" });
});

test.each(["agent-finding", "agent-proposal"] as const)("flow status shows %s with its source", async (kind) => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: `Status of ${kind}`, origin: kind, originSource: "ci run 42" });
  const run = await runFlowCli(flowCommand, env.root, ["status", result.flow.id]);
  expect(run.exitCode).toBe(0);
  const text = plain(run.out);
  expect(text).toContain(`origin: ${kind}`);
  expect(text).toContain("source: ci run 42");
});

test("flow status shows the verbatim quote of a human-request", async () => {
  env = await originRoot();
  const result = await env.service.init({
    cwd: env.root,
    title: "Quoted",
    origin: "human-request",
    originQuote: "сделай так, чтобы работало",
    originSource: "chat 7",
  });
  const text = plain((await runFlowCli(flowCommand, env.root, ["status", result.flow.id])).out);
  expect(text).toContain("origin: human-request");
  expect(text).toContain("«сделай так, чтобы работало»");
  expect(text).toContain("source: chat 7");
});
