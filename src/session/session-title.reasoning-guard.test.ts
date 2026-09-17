// flow 268 T18 — guard test: a session's title must be derived from a user
// message's `content` only, never from an assistant message's `reasoning`
// field (AC12).
//
// `persistHistory` (./store.ts) auto-fills the title from the first ARCHIVE
// message whose `role === "user"`, via `titleFromPrompt(firstUser.content)`
// — see `store.ts` around `title = titleFromPrompt(firstUser.content)`.
// Assistant `reasoning` is never read by this path at all; this test proves
// it behaviourally with a transcript that carries a reasoning-marker on the
// assistant message and a clean prompt on the user message.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory } from "./index";
import type { MessageReasoning, NormalizedMessage } from "../harness/provider/types";

const REASONING_MARKER = "REASONING-MARKER-268";

test("flow 268 T18: session title is derived from user content, never from an assistant message's reasoning (AC12)", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-session-title-guard-data-"));
  const proj = mkdtempSync(path.join(tmpdir(), "keryx-session-title-guard-proj-"));
  try {
    const handle = createSession({ cwd: proj, dataDir });

    const leakyReasoning: MessageReasoning = { text: `${REASONING_MARKER} internal deliberation` };
    const context: NormalizedMessage[] = [
      { role: "user", content: "help me fix the flaky test", provenance: "project" },
      {
        role: "assistant",
        content: "Sure, let's look at it.",
        provenance: "model",
        reasoning: leakyReasoning,
      },
    ];

    const updated = persistHistory(handle, context);

    expect(updated.summary.title).toBe("help me fix the flaky test");
    expect(updated.summary.title).not.toContain(REASONING_MARKER);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
