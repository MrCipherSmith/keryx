// Flow 390, AC5 — `outcomeAuthor` is derived from the origin when it is not set,
// an explicit setting is never overwritten, and `keryx flow origin set <id> <kind>
// --reason` changes the origin and writes a journal line carrying the reason.
import { afterEach, expect, test } from "bun:test";
import { effectiveOutcomeAuthor } from "./service";
import { originRoot, plain, readJournal, readRawFlow, runFlowCli, type OriginRoot } from "./origin.test-helpers";
import { flowCommand } from "../commands/flow";

let env: OriginRoot | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

test("effectiveOutcomeAuthor: explicit wins, a recorded origin derives agent, nothing reads unknown", () => {
  expect(effectiveOutcomeAuthor({})).toBe("unknown");
  expect(effectiveOutcomeAuthor({ origin: { kind: "human-request", quote: "q", source: "s" } })).toBe("agent");
  expect(effectiveOutcomeAuthor({ origin: { kind: "agent-finding", source: "s" } })).toBe("agent");
  expect(effectiveOutcomeAuthor({ outcomeAuthor: "human", origin: { kind: "agent-finding", source: "s" } })).toBe("human");
  expect(effectiveOutcomeAuthor({ outcomeAuthor: "agent" })).toBe("agent");
  expect(effectiveOutcomeAuthor({ outcomeAuthor: "robot", origin: { kind: "agent-proposal", source: "s" } })).toBe("agent");
  expect(effectiveOutcomeAuthor({ outcomeAuthor: "robot" })).toBe("unknown");
});

test("init with an origin and no --outcome-author leaves the field unset and derives it", async () => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: "Derived", origin: "human-request", originQuote: "q", originSource: "s" });
  expect((await readRawFlow(env.root, result.dir)).outcomeAuthor).toBeUndefined();
  expect(effectiveOutcomeAuthor(result.flow)).toBe("agent");

  const status = plain((await runFlowCli(flowCommand, env.root, ["status", result.flow.id])).out);
  expect(status).toContain("outcome author: agent (derived from origin)");
});

test("init with an origin and an explicit --outcome-author human keeps human", async () => {
  env = await originRoot();
  const result = await env.service.init({
    cwd: env.root,
    title: "Explicit",
    origin: "human-request",
    originQuote: "q",
    originSource: "s",
    outcomeAuthor: "human",
  });
  expect((await readRawFlow(env.root, result.dir)).outcomeAuthor).toBe("human");
  expect(effectiveOutcomeAuthor(result.flow)).toBe("human");
});

test("init without an origin keeps the existing default, agent", async () => {
  env = await originRoot();
  const result = await env.service.init({ cwd: env.root, title: "Plain" });
  expect((await readRawFlow(env.root, result.dir)).outcomeAuthor).toBe("agent");
});

test("origin set never overwrites an explicit outcomeAuthor, and never writes one", async () => {
  env = await originRoot();
  const explicit = await env.service.init({ cwd: env.root, title: "Explicit human", outcomeAuthor: "human" });
  await env.service.originSet({ cwd: env.root, id: explicit.flow.id, kind: "agent-finding", source: "ci", reason: "found by CI" });
  const after = await readRawFlow(env.root, explicit.dir);
  expect(after.outcomeAuthor).toBe("human");
  expect(after.origin).toEqual({ kind: "agent-finding", source: "ci" });

  const bare = await env.service.init({ cwd: env.root, title: "Bare", origin: "human-request", originQuote: "q", originSource: "s" });
  await env.service.originSet({ cwd: env.root, id: bare.flow.id, kind: "agent-proposal", source: "design talk", reason: "it was the agent's idea" });
  expect((await readRawFlow(env.root, bare.dir)).outcomeAuthor).toBeUndefined();
});

test("flow origin set changes the origin and journals the reason", async () => {
  env = await originRoot();
  const created = await env.service.init({ cwd: env.root, title: "Relabel me" });
  const run = await runFlowCli(flowCommand, env.root, [
    "origin",
    "set",
    created.flow.id,
    "human-request",
    "--reason",
    "operator confirmed it was their idea",
    "--quote",
    "сделай это",
    "--source",
    "chat 9",
  ]);
  expect(run.exitCode).toBe(0);
  expect(plain(run.out)).toContain("Origin unknown");
  expect(plain(run.out)).toContain("human-request");

  const flow = await readRawFlow(env.root, created.dir);
  expect(flow.origin).toEqual({ kind: "human-request", quote: "сделай это", source: "chat 9" });
  const journal = await readJournal(env.root, created.dir);
  expect(journal).toContain("origin-set");
  expect(journal).toContain("operator confirmed it was their idea");
  expect(flow.history.at(-1)?.event).toBe("origin-set");
});

test("setting the same origin again writes nothing", async () => {
  env = await originRoot();
  const created = await env.service.init({ cwd: env.root, title: "Same", origin: "agent-finding", originSource: "ci" });
  const before = await readJournal(env.root, created.dir);
  const result = await env.service.originSet({ cwd: env.root, id: created.flow.id, kind: "agent-finding", reason: "no change" });
  expect(result.changed).toBe(false);
  expect(await readJournal(env.root, created.dir)).toBe(before);
});

test("origin set needs a single-line reason, and unknown clears the origin", async () => {
  env = await originRoot();
  const created = await env.service.init({ cwd: env.root, title: "Clear", origin: "agent-finding", originSource: "ci" });
  await expect(env.service.originSet({ cwd: env.root, id: created.flow.id, kind: "unknown", reason: "" })).rejects.toThrow(/--reason/);
  await expect(env.service.originSet({ cwd: env.root, id: created.flow.id, kind: "unknown", reason: "a\nb" })).rejects.toThrow();

  const cleared = await env.service.originSet({ cwd: env.root, id: created.flow.id, kind: "unknown", reason: "recorded by mistake" });
  expect(cleared.changed).toBe(true);
  expect((await readRawFlow(env.root, created.dir)).origin).toBeUndefined();
  expect(await readJournal(env.root, created.dir)).toContain("recorded by mistake");
});
