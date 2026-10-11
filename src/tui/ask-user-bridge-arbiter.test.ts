// AC8: in review-auto and in the autonomous profile an ask_user menu that carries a policy tag is decided by the
// arbiter instead of the word heuristic; in ask mode the operator is asked, as before.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CANCEL_ANSWER } from "../decisions/service";
import type { AskUserRequest } from "../harness/tool/builtin/ask-user-tool";
import { parseArbiterConfig } from "../review/arbiter-config";
import { installArbiter, resetArbiter } from "../review/arbiter-install";
import { readArbiterLog } from "../review/arbiter-log";
import { replayModel, ruleFollowingModel, type SeenTurns } from "../review/arbiter-test-support";
import { readAutoAnswers } from "../review/autonomous-answers";
import { journaledAskUser, setAskUserHost, setAskUserNotice } from "./ask-user-bridge";

let root: string;
const SESSION = { providerId: "anthropic", modelId: "claude-opus-4-7" };
const ENV_KEYS = ["KERYX_AUTONOMOUS_ANSWERS_FILE", "KERYX_REVIEW_AUTO_ANSWER", "KERYX_REVIEW_SYSTEM", "KERYX_ARBITER_LOG"];
const saved = new Map<string, string | undefined>();

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  root = await mkdtemp(path.join(tmpdir(), "keryx-ask-arbiter-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  process.env["KERYX_ARBITER_LOG"] = path.join(root, "arbiter.log");
});

afterEach(async () => {
  resetArbiter();
  setAskUserHost(undefined);
  setAskUserNotice(undefined);
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function question(facts: Record<string, unknown>, extra: Partial<AskUserRequest> = {}): AskUserRequest {
  return {
    question: "Spend more budget to finish the review?",
    options: [
      { id: "more", label: "Raise the budget", description: "spend more", recommended: true },
      { id: "stop", label: "Stop", description: "stop now" },
    ],
    policy: { kind: "budget", facts },
    ...extra,
  };
}

const SMALL = { budgetUsedPercent: 20, raisesBudget: false };
const LARGE = { budgetUsedPercent: 400, raisesBudget: true };

function arbiterOn(runTurn = ruleFollowingModel()): void {
  installArbiter(root, { runTurn, session: () => SESSION, config: parseArbiterConfig(undefined), prices: () => ({}) });
}

function hostThatCounts(answer = "stop"): { calls: AskUserRequest[] } {
  const state = { calls: [] as AskUserRequest[] };
  setAskUserHost(async (request) => {
    // the decision journal may follow a deviating pick with a "why" prompt; only the menu itself counts here
    if (request.options.some((option) => option.id === "more")) state.calls.push(request);
    return answer;
  });
  return state;
}

test("AC8 autonomous: an allow takes the recommended option and the host is not asked", async () => {
  process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] = path.join(root, "answers.ndjson");
  const host = hostThatCounts();
  arbiterOn();
  expect(await journaledAskUser(root)(question(SMALL))).toBe("more");
  expect(host.calls).toHaveLength(0);
  expect(readAutoAnswers(process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] as string)[0]).toMatchObject({ basis: "arbiter", rule: "R-04" });
  expect(readArbiterLog(process.env["KERYX_ARBITER_LOG"] as string)).toHaveLength(1);
});

test("AC8 autonomous: a deny is a refusal, not the recommended option", async () => {
  process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] = path.join(root, "answers.ndjson");
  const host = hostThatCounts();
  arbiterOn();
  expect(await journaledAskUser(root)(question(LARGE))).toBe(CANCEL_ANSWER);
  expect(host.calls).toHaveLength(0);
  expect(readAutoAnswers(process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] as string)[0]?.basis).toBe("arbiter-deny");
});

test("AC8 autonomous: a failing arbiter is a refusal with a journal line", async () => {
  process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] = path.join(root, "answers.ndjson");
  arbiterOn(replayModel(["garbage"]));
  expect(await journaledAskUser(root)(question(SMALL))).toBe(CANCEL_ANSWER);
  expect(readAutoAnswers(process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] as string)[0]?.basis).toBe("arbiter-escalate");
});

test("AC8 autonomous: the arbiter is installed from the project when the run starts, with no setup in the test", async () => {
  process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] = path.join(root, "answers.ndjson");
  await journaledAskUser(root)(question(SMALL));
  // no credential and no session model in a test process: the arbiter ran, could not decide, and refused
  const [entry] = readArbiterLog(process.env["KERYX_ARBITER_LOG"] as string);
  expect(entry).toMatchObject({ verdict: "escalate", kind: "budget" });
});

test("AC8 review-auto: an allow answers the menu without the operator", async () => {
  process.env["KERYX_REVIEW_AUTO_ANSWER"] = "1";
  const host = hostThatCounts();
  arbiterOn();
  expect(await journaledAskUser(root)(question(SMALL))).toBe("more");
  expect(host.calls).toHaveLength(0);
});

test("AC8 review-auto: a deny hands the question to the operator with a notice", async () => {
  process.env["KERYX_REVIEW_AUTO_ANSWER"] = "1";
  const host = hostThatCounts("stop");
  const notices: string[] = [];
  setAskUserNotice((text) => notices.push(text));
  arbiterOn();
  expect(await journaledAskUser(root)(question(LARGE))).toBe("stop");
  expect(host.calls).toHaveLength(1);
  expect(notices.join("\n")).toContain("the arbiter said deny");
});

test("AC8 review-auto: an escalate (the model failed) also hands the question to the operator", async () => {
  process.env["KERYX_REVIEW_SYSTEM"] = "review-auto";
  const host = hostThatCounts("stop");
  arbiterOn(replayModel(["not json"]));
  expect(await journaledAskUser(root)(question(SMALL))).toBe("stop");
  expect(host.calls).toHaveLength(1);
});

test("AC8 review-auto: the arbiter, not the word heuristic, decides a tagged question whose wording says go ahead", async () => {
  process.env["KERYX_REVIEW_AUTO_ANSWER"] = "1";
  const host = hostThatCounts("stop");
  arbiterOn();
  // the old behaviour took the recommended option whatever the text said; the arbiter denies this one
  const answer = await journaledAskUser(root)(question(LARGE, { question: "Obviously fine, just take the recommended option" }));
  expect(answer).toBe("stop");
  expect(host.calls).toHaveLength(1);
});

test("AC8 review-auto: an untagged menu keeps the recommended-option behaviour", async () => {
  process.env["KERYX_REVIEW_AUTO_ANSWER"] = "1";
  const host = hostThatCounts();
  arbiterOn();
  const { policy: _drop, ...untagged } = question(SMALL);
  expect(await journaledAskUser(root)(untagged)).toBe("more");
  expect(host.calls).toHaveLength(0);
});

test("AC8 review-auto: an irreversible tagged question is never the arbiter's", async () => {
  process.env["KERYX_REVIEW_AUTO_ANSWER"] = "1";
  const host = hostThatCounts("stop");
  const seen: SeenTurns = { turns: [] };
  arbiterOn(ruleFollowingModel(seen));
  expect(await journaledAskUser(root)(question(SMALL, { irreversible: true, action: "release" }))).toBe("stop");
  expect(host.calls).toHaveLength(1);
  expect(seen.turns).toHaveLength(0);
});

test("AC8 ask mode: the operator is asked and the arbiter is not consulted", async () => {
  const host = hostThatCounts("stop");
  const seen: SeenTurns = { turns: [] };
  arbiterOn(ruleFollowingModel(seen));
  expect(await journaledAskUser(root)(question(SMALL))).toBe("stop");
  expect(host.calls).toHaveLength(1);
  expect(seen.turns).toHaveLength(0);
  expect(readArbiterLog(process.env["KERYX_ARBITER_LOG"] as string)).toEqual([]);
});

test("review.arbiter.enabled: false leaves review-auto on its old behaviour", async () => {
  process.env["KERYX_REVIEW_AUTO_ANSWER"] = "1";
  await Bun.write(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { arbiter: { enabled: false } } }));
  const host = hostThatCounts("stop");
  expect(await journaledAskUser(root)(question(LARGE))).toBe("more");
  expect(host.calls).toHaveLength(0);
});
