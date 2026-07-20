import { expect, test } from "bun:test";
import {
  buildSideWorkerPrompt,
  buildSideWorkerSystemInstruction,
  isSideWorkerId,
  SIDE_WORKER_ID_PREFIX,
  sideWorkerLabel,
} from "./side-worker";

test("side worker ids and labels", () => {
  expect(isSideWorkerId(`${SIDE_WORKER_ID_PREFIX}1`)).toBe(true);
  expect(isSideWorkerId("agent:main")).toBe(false);
  expect(sideWorkerLabel(2)).toBe("side-2");
});

test("buildSideWorkerPrompt includes live phase and question", () => {
  const p = buildSideWorkerPrompt({
    question: "why is shell blocked?",
    snapshot: { phase: "waiting for your approval", mainDetail: "approval", elapsedSec: 12.3 },
    recentHistory: [
      { role: "user", content: "run tests", provenance: "project" },
      { role: "assistant", content: "I'll run them", provenance: "model" },
    ],
  });
  expect(p).toContain("waiting for your approval");
  expect(p).toContain("why is shell blocked?");
  expect(p).toContain("run tests");
  expect(p).toContain("SIDE question");
  expect(p).not.toMatch(/continue the main task/i); // instruction says do NOT continue
  expect(p).toMatch(/Do NOT continue/i);
});

test("side system instruction forbids shell", () => {
  const s = buildSideWorkerSystemInstruction("p", "m");
  expect(s).toMatch(/shell_exec/i);
  expect(s).toMatch(/SIDE worker/i);
});
