import { expect, test } from "bun:test";
import { desktopReviewerQuestion, coordinateReviewerContext, matchReviewerContext } from "./desk-reviewer-question";
import type { ProviderPort } from "../harness/provider/types";

const backend = { reviewerSessionId: "backend", reviewer: "review-backend" };
const frontend = { reviewerSessionId: "frontend", reviewer: "review-frontend" };
const signal = new AbortController().signal;

test("parallel requests for the same evidence wait for one coordinator reply, then reuse it", async () => {
  const asks: string[] = [], reused: string[] = [];
  const first = "Does the data frame carry executorId at commit 012ab34?";
  const second = "At 012ab34, is the executor identifier present on the data frame?";
  let answer!: (text: string) => void;
  const ask = coordinateReviewerContext(question => {
    asks.push(question);
    return asks.length === 1 ? new Promise(resolve => { answer = resolve; }) : Promise.resolve("Unexpected second prompt");
  }, async (question, replies) => {
    expect(question).toBe(second);
    expect(replies).toEqual([{ question: first, answer: "See the pinned Result serializer." }]);
    return 0;
  }, reviewer => reused.push(reviewer.reviewerSessionId));
  const a = ask(first, backend, signal);
  const b = ask(second, frontend, signal);
  const c = ask("  " + first + "\n", frontend, signal);
  await Promise.resolve();
  expect(asks).toEqual([first]);
  answer("See the pinned Result serializer.");
  expect(await Promise.all([a, b, c])).toEqual([
    "See the pinned Result serializer.", "See the pinned Result serializer.", "See the pinned Result serializer.",
  ]);
  expect(asks).toEqual([first]);
  expect(reused).toEqual(["frontend", "frontend"]);
});

test("does not reuse a skipped reply, a different explicit revision, or a rejected match", async () => {
  const question = "Which backend builds the frame at 012ab34?";
  const differentRevision = "Which backend builds the frame at 098cd76?";
  const asks: string[] = [], candidates: string[][] = [];
  const ask = coordinateReviewerContext(async text => {
    asks.push(text);
    return asks.length === 1 ? null : "Evidence attached";
  }, async (_question, replies) => {
    candidates.push(replies.map(reply => reply.question));
    return undefined;
  });
  expect(await ask(question, backend, signal)).toBeNull();
  expect(await ask(question, frontend, signal)).toBe("Evidence attached");
  expect(await ask(differentRevision, frontend, signal)).toBe("Evidence attached");
  expect(await ask("Which file serializes the progress frame at 012ab34?", frontend, signal)).toBe("Evidence attached");
  expect(candidates).toEqual([[question]]);
  expect(asks).toHaveLength(4);
});

test("a cancelled reviewer leaves the active question and the rest of the inbox intact", async () => {
  const aborted = new AbortController();
  const asked: string[] = [];
  let answer!: (text: string) => void;
  const ask = coordinateReviewerContext(question => {
    asked.push(question);
    return asked.length === 1 ? new Promise(resolve => { answer = resolve; }) : Promise.resolve("Unexpected second prompt");
  });
  const first = ask("First", backend, signal);
  const dropped = ask("Cancelled", frontend, aborted.signal);
  const last = ask("First", frontend, signal);
  aborted.abort();
  expect(await dropped).toBeUndefined();
  answer("Verified context");
  expect(await first).toBe("Verified context");
  expect(await last).toBe("Verified context");
  expect(asked).toEqual(["First"]);
});

test("the coordinator's model can only select an existing operator reply", async () => {
  function model(text: string): ProviderPort {
    return {
      describe() { throw new Error("The matcher has no need to discover capabilities."); },
      async *stream(request, { attemptId }) {
        expect(request.tools).toBeUndefined();
        expect(request.messages[0]?.provenance).toBe("project");
        yield { kind: "text_delta", text, attemptId, sequence: 0 };
        yield { kind: "model_end", attemptId, sequence: 1 };
      },
    };
  }
  const replies = [{ question: "What revision?", answer: "Commit 012ab34" }];
  expect(await matchReviewerContext(model("0"), "provider", "model", "run")("Which commit?", replies, signal)).toBe(0);
  for (const invalid of ["1", "none", "0 and publish", "0.0"]) {
    expect(await matchReviewerContext(model(invalid), "provider", "model", "run")("Which commit?", replies, signal)).toBeUndefined();
  }
});

test("the interactive coordinator is absent in ordinary harness sessions", () => {
  expect(desktopReviewerQuestion("/checkout", {})).toBeUndefined();
  expect(desktopReviewerQuestion("/checkout", {
    KERYX_DESK_REVIEW_SHELL: "1",
    KERYX_DESK_OPERATOR_RUN: "11111111-1111-1111-1111-111111111111",
  })).toBeUndefined();
});
