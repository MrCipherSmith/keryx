import { describe, expect, test } from "bun:test";
import { repeatedCorrectionSignal } from "./repeated-correction";
import type { ObservationLine } from "./types";
import type { ObservationEvent } from "../types";

const PROJECT = { identity: "a".repeat(64), identityKind: "remote-hash" as const };
const PATH_DIGEST = "3".repeat(64);

function editLine(hash: { removed: string; added: string }, n: number, event: ObservationEvent["event"] = "tool-complete"): ObservationLine {
  const observation: ObservationEvent = {
    schemaVersion: 1,
    event,
    tool: event === "turn-stop" ? null : "Edit",
    inputDigest: "b".repeat(64),
    inputPreview: '{"file_path":"/repo/src/foo.ts","old_string":"a","new_string":"b"}',
    outputPreview: null,
    sessionId: "sess-1",
    toolUseId: `tu-${n}`,
    cwdHash: "c".repeat(64),
    project: PROJECT,
    observedAt: `2026-09-24T00:0${n}:00.000Z`,
    ...(event === "turn-stop"
      ? {}
      : { edit: { pathDigest: PATH_DIGEST, removedDigest: hash.removed, addedDigest: hash.added } }),
  };
  return { event: observation, sourceRef: `.metaproject/data/learning/observations/2026-09-24.jsonl#L${n}` };
}

function turnStop(n: number): ObservationLine {
  return editLine({ removed: "x", added: "y" }, n, "turn-stop");
}

describe("repeatedCorrectionSignal", () => {
  test("a second edit removing what the first added, within 3 turn-stops, yields one draft", async () => {
    const window: ObservationLine[] = [
      editLine({ removed: "1".repeat(64), added: "2".repeat(64) }, 1),
      turnStop(2),
      editLine({ removed: "2".repeat(64), added: "4".repeat(64) }, 3),
    ];
    const drafts = await repeatedCorrectionSignal("/root", window);
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.extractor).toBe("repeated-correction");
    expect(drafts[0]?.domain).toBe("workflow");
  });

  test("more than 3 intervening turn-stops does not pair", async () => {
    const window: ObservationLine[] = [
      editLine({ removed: "1".repeat(64), added: "2".repeat(64) }, 1),
      turnStop(2),
      turnStop(3),
      turnStop(4),
      turnStop(5),
      editLine({ removed: "2".repeat(64), added: "4".repeat(64) }, 6),
    ];
    expect(await repeatedCorrectionSignal("/root", window)).toEqual([]);
  });

  test("a plain revert (B.addedDigest === A.removedDigest) is not a repeated-correction", async () => {
    const window: ObservationLine[] = [
      editLine({ removed: "1".repeat(64), added: "2".repeat(64) }, 1),
      editLine({ removed: "2".repeat(64), added: "1".repeat(64) }, 2),
    ];
    expect(await repeatedCorrectionSignal("/root", window)).toEqual([]);
  });
});
