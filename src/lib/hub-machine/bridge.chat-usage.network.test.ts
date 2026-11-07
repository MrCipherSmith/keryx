import { expect, test } from "bun:test";
import type { SessionChatUsage } from "../../remote-control/chat-usage";
import type { Script } from "../../commands/agent.test-helpers";
import { bridgeHarness, wait } from "./bridge.test-support";

const harness = bridgeHarness();

test("chat reports both turns' provider usage after the last run ends", async () => {
  const answer = (inputTokens: number, outputTokens: number, cacheReadTokens: number): Script => [
    { kind: "text_delta", text: "Measured response." },
    { kind: "usage_update", usage: { inputTokens, outputTokens, cacheReadTokens } },
    { kind: "model_end" },
  ];
  const { session } = await harness.machine({ scripts: [answer(30, 6, 10), answer(44, 7, 14)] });
  const usage = () => harness.get<SessionChatUsage>(session.path + "/usage");
  expect(await usage()).toEqual({ turn: null, session: null, incomplete: false });
  const { lease } = await session.claim();
  for (const prompt of ["First measurement", "Second measurement"]) {
    const turn = await session.turn(lease, prompt);
    await session.waitRun(turn.runId!, run => run.state === "succeeded");
    await wait(session.read, state => state.activeRunId === null);
  }

  const measured = await usage();
  expect(measured).toMatchObject({
    turn: { tokensIn: 44, tokensOut: 7, cacheRead: 14 },
    session: { tokensIn: 74, tokensOut: 13, cacheRead: 24 },
    incomplete: false,
  });
  expect(measured.session!.activeMs).toBeGreaterThanOrEqual(measured.turn!.activeMs);
  expect((await harness.hub().call(session.path + "/usage")).status).toBe(401);
});
