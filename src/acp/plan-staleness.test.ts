// An ordinary ACP shell-profile turn (what the Desktop app runs) reads the session's plan: the model sees the plan
// snapshot from the round after plan_set, and the stale-plan note once the open plan has gone unchanged for the
// stale window. Before, the plan reached the model only after `/goal` had opened a slate.

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { NormalizedEvent, NormalizedRequest, ProviderPort, StreamOptions } from "../harness/provider/types";
import { EXECUTION_PLAN_STALE_NOTE, EXECUTION_PLAN_STALE_ROUNDS } from "../session/execution-plan";
import { driveTurn, shellHarness, textRound, toolRound, type Round } from "./shell-profile.test-helpers";

const READS = EXECUTION_PLAN_STALE_ROUNDS + 2;

function recordingProvider(rounds: readonly Round[]): { provider: ProviderPort; systems: string[] } {
  const systems: string[] = [];
  let call = 0;
  const provider: ProviderPort = {
    describe: () => ({
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: true,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "recording" },
    }),
    stream: (request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> => {
      systems.push(request.systemInstruction ?? "");
      const events = rounds[call] ?? [];
      call += 1;
      return (async function* () {
        let sequence = 0;
        for (const partial of events) yield { sequence: sequence++, attemptId: opts.attemptId, ...partial } as NormalizedEvent;
      })();
    },
  };
  return { provider, systems };
}

test("an ordinary ACP turn sees its plan and, once the plan stalls, the stale-plan note", async () => {
  const rounds: Round[] = [
    toolRound("p1", "plan_set", {
      expectedRevision: 0,
      items: [
        { id: "review", title: "Run the review", status: "in_progress" },
        { id: "report", title: "Write the report", status: "pending" },
      ],
    }),
    ...Array.from({ length: READS }, (_, i) => toolRound(`r${i}`, "read_file", { path: `f${i}.txt` })),
    textRound("done"),
  ];
  const { provider, systems } = recordingProvider(rounds);
  const h = shellHarness({ serverOptions: { provider } });
  try {
    for (let i = 0; i < READS; i++) writeFileSync(path.join(h.projectDir, `f${i}.txt`), `file ${i}\n`, "utf8");
    await h.initialize();
    const { sessionId } = await h.newSession();
    const { reply } = await driveTurn(h, sessionId, "Review the open PR and report");
    expect(reply.result?.["stopReason"]).toBe("end_turn");
  } finally {
    await h.end();
  }

  expect(systems).toHaveLength(READS + 2);
  // Round 1 runs before plan_set: no plan yet. Every later round carries the snapshot.
  expect(systems[0]).not.toContain("Current execution plan");
  expect(systems.slice(1).every((system) => system.includes("Current execution plan (revision 1)"))).toBe(true);
  // Round 2 takes the baseline; the note appears once the plan has been unchanged for the whole window.
  const firstStale = 1 + EXECUTION_PLAN_STALE_ROUNDS;
  expect(systems.slice(0, firstStale).some((system) => system.includes(EXECUTION_PLAN_STALE_NOTE))).toBe(false);
  expect(systems.slice(firstStale).every((system) => system.endsWith(EXECUTION_PLAN_STALE_NOTE))).toBe(true);
}, 60_000);
