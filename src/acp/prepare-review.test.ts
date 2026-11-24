import { expect, test } from "bun:test";
import { PREPARE_REVIEW_METHOD } from "./review-draft";
import { callsOf, shellHarness, textRound, toolRound } from "./shell-profile.test-helpers";

test("the model prepares the named PR in its own Desktop session and receives a configuration receipt", async () => {
  const h = shellHarness({ clientCapabilities: { _meta: { keryx: { prepareReview: true } } },
    rounds: [toolRound("call-1", "prepare_review", { target: "7", flowId: "505" }), textRound("Configuration requested.")] });
  try {
    const init = await h.initialize();
    expect(init.result).toMatchObject({ _meta: { keryx: { extensions: expect.arrayContaining([PREPARE_REVIEW_METHOD]) } } });
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Configure a review of PR 7.");
    const ask = await h.waitFor(frame => frame.method === PREPARE_REVIEW_METHOD);
    expect(ask.params as unknown).toEqual({ sessionId, target: "#7", flowId: "505" });
    h.respond(ask.id, { result: { prepared: true } });
    await h.waitFor(frame => frame.id === id);
    const calls = callsOf(h.frames, "prepare_review");
    expect(calls.announced[0]?.kind).toBe("think");
    expect(calls.updates.at(-1)?.rawOutput).toContain("Review configuration requested");
  } finally {
    await h.end();
  }
}, 15000);

test.each(["shell", "editor"] as const)("an ordinary %s connection cannot request a Desktop Review dialog", async profile => {
  const h = shellHarness({ profile, rounds: [toolRound("call-1", "prepare_review", { target: "#7" }), textRound("Done.")] });
  try {
    await h.initialize();
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Review PR 7.");
    await h.waitFor(frame => frame.id === id);
    expect(h.frames.some(frame => frame.method === PREPARE_REVIEW_METHOD)).toBe(false);
  } finally {
    await h.end();
  }
}, 15000);

test("an ACP shell task receives its own session identity", async () => {
  const h = shellHarness({ storedMode: "trust", rounds: [
    toolRound("shell-session", "shell_exec", { command: 'printf "session=%s" "$KERYX_REVIEW_SESSION_ID"' }),
    textRound("Done."),
  ] });
  try {
    await h.initialize();
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Check session context.");
    await h.waitFor(frame => frame.id === id);
    const output = callsOf(h.frames, "shell_exec").updates.map(update => String(update.rawOutput ?? "")).join("\n");
    expect(output).toContain(`session=${sessionId}`);
  } finally { await h.end(); }
}, 15000);
