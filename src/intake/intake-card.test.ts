// AC4 (flow 403): the card carries a model assessment of at most 400 characters and a suggestion from the kind's
// own buttons. Ticket text is untrusted: it is redacted and cut before the model sees it, and nothing the model or
// the ticket says can add a link, a button or markup to the card.

import { INTAKE_SERVICE_TOPIC } from "../remote/protocol";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIntakeAssessor, parseAssessment, type IntakeModelCall, type IntakeModelRequest } from "./assess";
import { createIntakeCardSink, plainText, renderIntakeCard } from "./card";
import { FakePressHub, seedCard } from "./intake-actions.test-helpers";
import { setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { readIntakeCardView } from "./store";
import { INTAKE_ACTIONS_BY_KIND, type IntakeAssessInput, type IntakeEvent } from "./types";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function eventOf(over: Partial<IntakeEvent> = {}): IntakeEvent {
  return { key: "issue:o/r#1", kind: "issue", repo: "o/r", ref: "1", title: "Crash on start", stamp: "2026-10-05T09:00:00Z", body: "It crashes.", ...over };
}

function inputOf(over: Partial<IntakeAssessInput> = {}): IntakeAssessInput {
  return { event: eventOf(), allowed: INTAKE_ACTIONS_BY_KIND.issue, signal: new AbortController().signal, remainingUsd: 0.5, ...over };
}

function scripted(text: string, costUsd = 0.01): { call: IntakeModelCall; requests: IntakeModelRequest[] } {
  const requests: IntakeModelRequest[] = [];
  return {
    requests,
    call: async (request) => {
      requests.push(request);
      return { ok: true, text, costUsd };
    },
  };
}

describe("the assessor (AC4)", () => {
  test("a good answer becomes an assessment and a suggestion from the kind's set", async () => {
    const model = scripted('{"assessment": "A startup crash; likely small.", "suggestion": "take"}');
    const result = await createIntakeAssessor(model.call)(inputOf());
    expect(result).toEqual({ ok: true, assessment: "A startup crash; likely small.", suggestion: "take", costUsd: 0.01 });
  });

  test("the model gets one call, and the ticket text is redacted and cut first", async () => {
    const model = scripted('{"assessment": "ok", "suggestion": null}');
    const body = `Token ${SECRET}\n${"x".repeat(10_000)}`;
    await createIntakeAssessor(model.call)(inputOf({ event: eventOf({ title: `${SECRET} ${"t".repeat(900)}`, body }) }));
    expect(model.requests).toHaveLength(1);
    const { user, limitUsd, system } = model.requests[0]!;
    expect(user).not.toContain(SECRET);
    expect(user).toContain("[REDACTED");
    expect(user.length).toBeLessThan(3600);
    expect(limitUsd).toBe(0.5);
    expect(system).toContain("untrusted");
  });

  test("a suggestion outside the kind's buttons is dropped, the assessment stays", async () => {
    const result = await createIntakeAssessor(scripted('{"assessment": "A review request.", "suggestion": "take"}').call)(inputOf({ event: eventOf({ kind: "review" }), allowed: INTAKE_ACTIONS_BY_KIND.review }));
    expect(result).toMatchObject({ ok: true, assessment: "A review request." });
    expect(result.ok && result.suggestion).toBeUndefined();
  });

  test("the assessment is at most 400 characters and carries no link", () => {
    const long = `See https://evil.example/x and www.evil.example ${"a".repeat(900)}`;
    const parsed = parseAssessment(JSON.stringify({ assessment: long, suggestion: "decline" }), INTAKE_ACTIONS_BY_KIND.issue);
    expect(parsed!.assessment.length).toBeLessThanOrEqual(400);
    expect(parsed!.assessment).not.toMatch(/https?:|www\./);
    expect(parsed!.suggestion).toBe("decline");
  });

  test.each(["not json at all", "[]", '{"suggestion": "take"}', '{"assessment": "   "}', '{"assessment": 5}'])("garbage %p is ok:false, so the card goes out without a suggestion", async (text) => {
    const result = await createIntakeAssessor(scripted(text).call)(inputOf());
    expect(result.ok).toBe(false);
  });

  test("an unavailable model, a thrown error, a spent budget and a stopped run are all ok:false without a call", async () => {
    expect((await createIntakeAssessor(async () => ({ ok: false, reason: "no model", costUsd: 0 }))(inputOf())).ok).toBe(false);
    const thrown = await createIntakeAssessor(async () => {
      throw new Error(`boom ${SECRET}`);
    })(inputOf());
    expect(thrown.ok).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain(SECRET);

    const model = scripted('{"assessment": "ok"}');
    expect((await createIntakeAssessor(model.call)(inputOf({ remainingUsd: 0 }))).ok).toBe(false);
    const stopped = new AbortController();
    stopped.abort();
    expect((await createIntakeAssessor(model.call)(inputOf({ signal: stopped.signal }))).ok).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  test("the cost of an unusable answer is still reported to the poll's budget", async () => {
    const result = await createIntakeAssessor(scripted("nonsense", 0.07).call)(inputOf());
    expect(result).toMatchObject({ ok: false, costUsd: 0.07 });
  });
});

describe("the card text (AC4)", () => {
  test("untrusted title and assessment cannot become markup or a link", async () => {
    const hostile = "**bold** [click](https://evil.example) <b>x</b> `code` # heading | cell";
    const card = await seedCard(env.root, { title: hostile, assessment: hostile, suggestion: "take" });
    const text = renderIntakeCard((await readIntakeCardView(env.root, card.id))!);
    const titleLine = text.split("\n").find((l) => l.startsWith("Название:"))!;
    expect(titleLine).not.toMatch(/[*_~`[\]<>|\\]/);
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("](https://evil.example)");
    expect(text).toContain("Совет: Взять в работу");
    expect(text).toContain(`[открыть](${card.content.url})`);
  });

  test("a link that is not plain https is not added", async () => {
    const card = await seedCard(env.root, { url: "javascript:alert(1)" });
    expect(renderIntakeCard((await readIntakeCardView(env.root, card.id))!)).not.toContain("Ссылка");
  });

  test("a card with no assessment says so and has no suggestion line", async () => {
    const card = await seedCard(env.root);
    const text = renderIntakeCard((await readIntakeCardView(env.root, card.id))!);
    expect(text).toContain("Оценка: недоступна");
    expect(text).not.toContain("Совет");
  });

  test("an overlong assessment is cut in the card too", async () => {
    const card = await seedCard(env.root, { assessment: "a".repeat(2000) });
    const line = renderIntakeCard((await readIntakeCardView(env.root, card.id))!).split("\n").find((l) => l.startsWith("Оценка:"))!;
    expect(line.length).toBeLessThanOrEqual("Оценка: ".length + 400);
  });

  test("plainText flattens whitespace and control characters", () => {
    expect(plainText("a\n\nb\tc\u0000d", 50)).toBe("a b c d");
    expect(plainText("x".repeat(30), 10)).toHaveLength(10);
  });

  test("the sink sends the card with its keyboard and reports the ids Telegram gave", async () => {
    const hub = new FakePressHub();
    const card = await seedCard(env.root, { assessment: "Looks small." });
    const view = (await readIntakeCardView(env.root, card.id))!;
    const result = await createIntakeCardSink(hub).sendCard(view);
    expect(result).toMatchObject({ ok: true, chatId: expect.any(String), messageId: expect.any(String) });
    expect(hub.sends).toHaveLength(1);
    expect(hub.sends[0]!.topic).toBe("Intake");
    expect(hub.sends[0]!.keyboard).toHaveLength(1);
  });

  test("S4: the sink has one topic, the one the hub accepts presses from", async () => {
    const hub = new FakePressHub();
    const view = (await readIntakeCardView(env.root, (await seedCard(env.root)).id))!;
    await createIntakeCardSink(hub).sendCard(view);
    await createIntakeCardSink(hub).sendStatus("hello");
    expect(hub.sends.map((m) => m.topic)).toEqual([INTAKE_SERVICE_TOPIC, INTAKE_SERVICE_TOPIC]);
  });

  test("editCard edits the message in place: a status line drops the buttons, none keeps them, no ids is not ok", async () => {
    const hub = new FakePressHub();
    const card = await seedCard(env.root, { assessment: "Small." });
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(await createIntakeCardSink(hub).editCard!(view, "👍 принято 10:42")).toEqual({ ok: true });
    expect(hub.edits[0]!.text).toContain("👍 принято 10:42");
    expect(hub.edits[0]!.keyboard).toBeUndefined();
    expect(await createIntakeCardSink(hub).editCard!(view)).toEqual({ ok: true });
    expect(hub.edits[1]!.keyboard).toHaveLength(1);
    const noIds = (await readIntakeCardView(env.root, (await seedCard(env.root, { withoutIds: true })).id))!;
    expect(await createIntakeCardSink(hub).editCard!(noIds, "x")).toEqual({ ok: false });
    expect(hub.edits).toHaveLength(2);
  });

  test("a card the durable queue holds is ok without ids; a refused send is not ok", async () => {
    const view = (await readIntakeCardView(env.root, (await seedCard(env.root)).id))!;
    const queued = { sendToServiceTopic: async () => ({ ok: true as const, state: "queued" as const, threadId: 1 }) };
    expect(await createIntakeCardSink(queued).sendCard(view)).toEqual({ ok: true });
    const refused = { sendToServiceTopic: async () => ({ ok: false as const, reason: "not connected" }) };
    expect(await createIntakeCardSink(refused as never).sendCard(view)).toMatchObject({ ok: false });
  });
});
