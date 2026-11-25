import { expect, test } from "bun:test";
import { callsOf, shellHarness, textRound, toolRound } from "./shell-profile.test-helpers";
import { clientShowsOperatorCards } from "./shell-roster";

// TM-04 §6c: the operator card tools reach a `keryx acp --profile shell` session only when the client declared that it
// shows operator cards. Without the declaration the session is offered none of them, as before.

test("only a client that declared operatorCards is read as showing them", () => {
  expect(clientShowsOperatorCards({ _meta: { keryx: { operatorCards: true } } })).toBe(true);
  expect(clientShowsOperatorCards({ _meta: { keryx: { operatorCards: "yes" } } })).toBe(false);
  expect(clientShowsOperatorCards({ _meta: { keryx: { askUser: true } } })).toBe(false);
  expect(clientShowsOperatorCards(undefined)).toBe(false);
});

test("with operatorCards the session has review_complete: a package that does not exist is refused by the card, with nothing asked", async () => {
  const h = shellHarness({ clientCapabilities: { _meta: { keryx: { operatorCards: true } } },
    rounds: [toolRound("call-1", "review_complete", { package: "no-such-package" }), textRound("Done.")] });
  try {
    await h.initialize();
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Close the review.");
    await h.waitFor(frame => frame.id === id);
    const output = String(callsOf(h.frames, "review_complete").updates.at(-1)?.rawOutput ?? "");
    expect(output).toContain("review_complete refused");
    expect(h.frames.some(frame => frame.method === "session/request_permission")).toBe(false);
  } finally {
    await h.end();
  }
}, 15000);

test("without operatorCards the session is not offered review_complete", async () => {
  const h = shellHarness({ rounds: [toolRound("call-1", "review_complete", { package: "no-such-package" }), textRound("Done.")] });
  try {
    await h.initialize();
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Close the review.");
    await h.waitFor(frame => frame.id === id);
    const output = String(callsOf(h.frames, "review_complete").updates.at(-1)?.rawOutput ?? "");
    expect(output).not.toContain("review_complete refused");
    expect(h.frames.some(frame => frame.method === "session/request_permission")).toBe(false);
  } finally {
    await h.end();
  }
}, 15000);

// A card tool that is offered answers a subject that does not exist with its own refusal; one that is not offered never
// gets that far. Neither asks for permission, so the pair tells "offered" from "not offered" without a card on screen.
const OTHER_CARDS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["flow_confirm", { flow_id: "999999" }],
  ["external_apply", { run_id: "no-such-run" }],
  ["learn_accept", { id: "no-such-pattern" }],
  ["schedule_pause", { name: "no-such-schedule" }],
];

test.each(OTHER_CARDS)("with operatorCards the session has %s", async (name, input) => {
  const h = shellHarness({ clientCapabilities: { _meta: { keryx: { operatorCards: true } } },
    rounds: [toolRound("call-1", name, input), textRound("Done.")] });
  try {
    await h.initialize();
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Take the decision.");
    await h.waitFor(frame => frame.id === id);
    expect(String(callsOf(h.frames, name).updates.at(-1)?.rawOutput ?? "")).toContain(`${name} refused`);
  } finally {
    await h.end();
  }
}, 15000);

test.each(OTHER_CARDS)("without operatorCards the session is not offered %s", async (name, input) => {
  const h = shellHarness({ rounds: [toolRound("call-1", name, input), textRound("Done.")] });
  try {
    await h.initialize();
    const { sessionId } = await h.newSession();
    const id = h.prompt(sessionId, "Take the decision.");
    await h.waitFor(frame => frame.id === id);
    expect(String(callsOf(h.frames, name).updates.at(-1)?.rawOutput ?? "")).not.toContain(`${name} refused`);
    expect(h.frames.some(frame => frame.method === "session/request_permission")).toBe(false);
  } finally {
    await h.end();
  }
}, 15000);
