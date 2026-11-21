import { expect, test } from "bun:test";
import { formatLineComments, lineCommentRange, textWithLineComments, type LineComment } from "./lineComments";
import { buildUserPrompt, userPromptContext } from "./userPrompt";

const A: LineComment = { path: "src/a.ts", startLine: 12, endLine: 14, side: "new", text: "Rename this" };
const B: LineComment = { path: "src/b.ts", startLine: 40, endLine: 40, side: "old", text: "Why was this\nremoved?\n\n  Please say." };

test("comments are one plain text block in the exact agreed form", () => {
  expect(formatLineComments([A, B])).toBe(
    "Line comments:\n- src/a.ts:12-14 (new): Rename this\n- src/b.ts:40 (old): Why was this removed? Please say.",
  );
  expect(formatLineComments([])).toBe("");
  expect(lineCommentRange(A)).toBe("src/a.ts:12-14");
  expect(lineCommentRange(B)).toBe("src/b.ts:40");
});

test("the block is appended to the user's text, or stands alone when there is none", () => {
  expect(textWithLineComments("fix it", [A])).toBe("fix it\n\nLine comments:\n- src/a.ts:12-14 (new): Rename this");
  expect(textWithLineComments("  \n", [A])).toBe("Line comments:\n- src/a.ts:12-14 (new): Rename this");
  expect(textWithLineComments("fix it", [])).toBe("fix it");
});

test("line comments are plain text: no resource block and nothing untrusted", () => {
  const context = userPromptContext([], [], undefined);
  const blocks = buildUserPrompt(textWithLineComments("", [A, B]), context.blocks, true);
  expect(blocks).toEqual([{ type: "text", text: formatLineComments([A, B]) }]);
  expect(JSON.stringify(blocks)).not.toContain("untrusted");
  expect(JSON.stringify(blocks)).not.toContain("resource");
});

test("with a file attachment only the file's resource block is untrusted", () => {
  const context = userPromptContext([], [{ kind: "file", label: "notes.txt", path: "/tmp/file.txt" }]);
  const blocks = buildUserPrompt(textWithLineComments("look", [A]), context.blocks, true) as Array<Record<string, unknown>>;
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toEqual({ type: "text", text: "look\n\nLine comments:\n- src/a.ts:12-14 (new): Rename this" });
  expect(blocks[0]!._meta).toBeUndefined();
  expect(blocks[1]).toMatchObject({ type: "resource", _meta: { keryx: { untrusted: true } } });
  expect(JSON.stringify(blocks[1])).not.toContain("Line comments");
});
