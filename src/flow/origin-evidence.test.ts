// Flow 390, AC2 — evidence, not assertion. `human-request` without a quote or
// without a source is not recorded: the origin stays unknown, the command still
// succeeds and says why.
import { afterEach, expect, test } from "bun:test";
import { flowDirNames, originRoot, plain, readRawFlow, runFlowCli, type OriginRoot } from "./origin.test-helpers";
import { flowCommand } from "../commands/flow";

let env: OriginRoot | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

test.each([
  ["no quote", { originSource: "chat 1" }, /--quote/],
  ["no source", { originQuote: "сделай X" }, /--source/],
  ["neither", {}, /--quote.*--source/],
  ["a blank quote", { originQuote: "   ", originSource: "chat 1" }, /--quote/],
  ["a blank source", { originQuote: "сделай X", originSource: " " }, /--source/],
])("service: human-request with %s leaves origin unknown and explains why", async (_label, extra, reason) => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: "Missing evidence", origin: "human-request", ...extra });
  expect(result.flow.origin).toBeUndefined();
  expect(result.originNote).toMatch(reason);
  expect(result.originNote).toContain("origin stays unknown");
  expect((await readRawFlow(env.root, result.dir)).origin).toBeUndefined();
});

test("the CLI exits 0 and prints why when the quote is missing", async () => {
  env = await originRoot();
  const run = await runFlowCli(flowCommand, env.root, ["init", "--title", "No quote", "--origin", "human-request", "--source", "chat 1"]);
  expect(run.exitCode).toBe(0);
  const text = plain(run.out);
  expect(text).toContain("origin: unknown");
  expect(text).toContain("needs a verbatim --quote");
  expect(await flowDirNames(env.root)).toHaveLength(1);
});

test("the CLI exits 0 and prints why when the source is missing", async () => {
  env = await originRoot();
  const run = await runFlowCli(flowCommand, env.root, ["init", "--title", "No source", "--origin", "human-request", "--quote", "сделай X"]);
  expect(run.exitCode).toBe(0);
  const text = plain(run.out);
  expect(text).toContain("origin: unknown");
  expect(text).toContain("needs a --source");
  const dirs = await flowDirNames(env.root);
  expect((await readRawFlow(env.root, `.metaproject/flows/${dirs[0]}`)).origin).toBeUndefined();
});

test("agent kinds need a source too; a quote alone is not enough", async () => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: "Finding without source", origin: "agent-finding", originQuote: "found it" });
  expect(result.flow.origin).toBeUndefined();
  expect(result.originNote).toContain("needs a --source");
});
