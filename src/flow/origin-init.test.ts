// Flow 390, AC1 — `flow init --origin human-request --quote ... --source ...`
// writes `origin {kind, quote, source}` into flow.json, the quote byte for byte.
import { afterEach, expect, test } from "bun:test";
import { flowDirNames, originRoot, plain, readRawFlow, runFlowCli, type OriginRoot } from "./origin.test-helpers";
import { flowCommand } from "../commands/flow";

let env: OriginRoot | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const QUOTE = 'каждый раз, когда создаётся flow, агент должен сам определять "откуда он пришёл"\nвторая строка — с «кавычками» и \'апострофами\'';
const SOURCE = "telegram, message 177555, 2026-10-02 09:41";

test("the service writes origin {kind, quote, source} into flow.json, quote byte for byte", async () => {
  env = await originRoot();
  const result = await env.service.init({
    cwd: env.root,
    title: "From a request",
    origin: "human-request",
    originQuote: QUOTE,
    originSource: SOURCE,
  });
  expect(result.originNote).toBeUndefined();
  expect(result.flow.origin).toEqual({ kind: "human-request", quote: QUOTE, source: SOURCE });

  const onDisk = await readRawFlow(env.root, result.dir);
  expect(onDisk.origin).toEqual({ kind: "human-request", quote: QUOTE, source: SOURCE });
  expect(onDisk.origin?.quote).toBe(QUOTE);
});

test("the quote keeps surrounding whitespace and a trailing newline exactly", async () => {
  env = await originRoot();
  const quote = "  отступ и хвост\n";
  const result = await env.service.init({
    cwd: env.root,
    title: "Whitespace",
    origin: "human-request",
    originQuote: quote,
    originSource: SOURCE,
  });
  expect((await readRawFlow(env.root, result.dir)).origin?.quote).toBe(quote);
});

test("the CLI records the origin from --origin, --quote and --source", async () => {
  env = await originRoot();
  const run = await runFlowCli(flowCommand, env.root, ["init", "--title", "Via the CLI", "--origin", "human-request", "--quote", QUOTE, "--source", SOURCE]);
  expect(run.exitCode).toBe(0);
  const text = plain(run.out);
  expect(text).toContain("origin: human-request");
  expect(text).toContain(SOURCE);

  const dirs = await flowDirNames(env.root);
  expect(dirs).toHaveLength(1);
  const flow = await readRawFlow(env.root, `.metaproject/flows/${dirs[0]}`);
  expect(flow.origin).toEqual({ kind: "human-request", quote: QUOTE, source: SOURCE });
});

test("a quote that begins with a dash is taken as the value, not as a flag", async () => {
  env = await originRoot();
  const run = await runFlowCli(flowCommand, env.root, ["init", "--title", "Dash", "--origin", "human-request", "--quote", "- сделай это", "--source", SOURCE]);
  expect(run.exitCode).toBe(0);
  const dirs = await flowDirNames(env.root);
  const flow = await readRawFlow(env.root, `.metaproject/flows/${dirs[0]}`);
  expect(flow.origin?.quote).toBe("- сделай это");
});
