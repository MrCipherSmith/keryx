// flow 268 T18 — guard test: session compaction's summary message must be
// built only from `content`, never from a compacted message's `reasoning`
// field (AC12).
//
// `compactMessages` (./compact.ts) is a pure, deterministic summarizer (no
// model call at all, per its own top-of-file comment) that reads `.content`
// off user/tool/assistant messages when building `summaryText` (see the
// `userPrompts`/`tools`/`lastAssistant.content` reads). This test pins that
// a `reasoning` field attached to a compacted assistant message — a real
// shape since flow 268 T11 (`MessageReasoning`) — never contributes to the
// injected summary.

import { expect, test } from "bun:test";
import { compactMessages } from "./compact";
import type { MessageReasoning, NormalizedMessage } from "../harness/provider/types";

const REASONING_MARKER = "REASONING-MARKER-268";

test("flow 268 T18: compactMessages's summaryText never contains a compacted message's reasoning marker (AC12)", () => {
  const leakyReasoning: MessageReasoning = { text: `${REASONING_MARKER} internal deliberation from an earlier turn` };

  const history: NormalizedMessage[] = [
    { role: "user", content: "first question", provenance: "project" },
    { role: "assistant", content: "first answer", provenance: "model" },
    { role: "user", content: "second question", provenance: "project" },
    { role: "assistant", content: "second answer", provenance: "model" },
    { role: "user", content: "third question", provenance: "project" },
    {
      // The LAST assistant message in the compacted prefix — this is the one
      // `compactMessages` actually reads for "Last assistant note before cut"
      // (`[...prefix].reverse().find((m) => m.role === "assistant")`), so the
      // marker belongs here to exercise the real read path.
      role: "assistant",
      content: "third answer, clean text",
      provenance: "model",
      reasoning: leakyReasoning,
    },
    { role: "user", content: "fourth question — triggers compaction of the above", provenance: "project" },
  ];

  const result = compactMessages(history, { keepLastUserTurns: 1 });

  expect(result.noop).toBe(false);
  expect(result.summaryText).not.toContain(REASONING_MARKER);
  expect(result.summaryText).toContain("third answer, clean text");
  // The injected summary message itself (what actually re-enters the model
  // context) must also be clean.
  expect(result.context[0]?.content).not.toContain(REASONING_MARKER);
});
