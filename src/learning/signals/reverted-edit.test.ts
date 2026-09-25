import { describe, expect, test } from "bun:test";
import { revertedEditSignal } from "./reverted-edit";
import type { ObservationLine } from "./types";
import type { ObservationEvent } from "../types";

const PROJECT = { identity: "a".repeat(64), identityKind: "remote-hash" as const };
const HASH_ORIGINAL = "1".repeat(64);
const HASH_EDITED = "2".repeat(64);
const PATH_DIGEST = "3".repeat(64);

function line(overrides: Partial<ObservationEvent>, n: number): ObservationLine {
  const event: ObservationEvent = {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Edit",
    inputDigest: "b".repeat(64),
    inputPreview: '{"file_path":"/repo/src/foo.ts","old_string":"a","new_string":"b"}',
    outputPreview: null,
    sessionId: "sess-1",
    toolUseId: `tu-${n}`,
    cwdHash: "c".repeat(64),
    project: PROJECT,
    observedAt: `2026-09-24T00:0${n}:00.000Z`,
    ...overrides,
  };
  return { event, sourceRef: `.metaproject/data/learning/observations/2026-09-24.jsonl#L${n}` };
}

describe("revertedEditSignal", () => {
  test("an edit undone byte-for-byte in the same session yields one draft", async () => {
    const window: ObservationLine[] = [
      line({ edit: { pathDigest: PATH_DIGEST, removedDigest: HASH_ORIGINAL, addedDigest: HASH_EDITED } }, 1),
      line({ edit: { pathDigest: PATH_DIGEST, removedDigest: HASH_EDITED, addedDigest: HASH_ORIGINAL } }, 2),
    ];
    const drafts = await revertedEditSignal("/root", window);
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.extractor).toBe("reverted-edit");
    expect(drafts[0]?.domain).toBe("workflow");
    expect(drafts[0]?.trigger).toContain("foo.ts");
    expect(drafts[0]?.trigger.length).toBeGreaterThanOrEqual(8);
  });

  test("a different session does not pair", async () => {
    const window: ObservationLine[] = [
      line({ sessionId: "sess-1", edit: { pathDigest: PATH_DIGEST, removedDigest: HASH_ORIGINAL, addedDigest: HASH_EDITED } }, 1),
      line({ sessionId: "sess-2", edit: { pathDigest: PATH_DIGEST, removedDigest: HASH_EDITED, addedDigest: HASH_ORIGINAL } }, 2),
    ];
    expect(await revertedEditSignal("/root", window)).toEqual([]);
  });

  test("a further edit (not a revert) does not pair", async () => {
    const window: ObservationLine[] = [
      line({ edit: { pathDigest: PATH_DIGEST, removedDigest: HASH_ORIGINAL, addedDigest: HASH_EDITED } }, 1),
      line({ edit: { pathDigest: PATH_DIGEST, removedDigest: HASH_EDITED, addedDigest: "9".repeat(64) } }, 2),
    ];
    expect(await revertedEditSignal("/root", window)).toEqual([]);
  });
});
