import { expect, test } from "bun:test";
import { buildUserPrompt, userPromptContext } from "./userPrompt";

test("the ACP packet keeps operator text separate from untrusted attachment paths", () => {
  const context = userPromptContext([], [{ kind: "file", label: "notes.txt", path: "/tmp/file.txt" }]);
  expect(buildUserPrompt("  explain this", context.blocks, true)).toEqual([
    { type: "text", text: "  explain this" },
    {
      type: "resource",
      resource: { uri: "keryx-desktop:local-attachments", mimeType: "text/plain", text: 'Local attachment paths:\nFile "notes.txt": "/tmp/file.txt"' },
      _meta: { keryx: { untrusted: true } },
    },
  ]);
});

test("only the first ACP block can dispatch a command, so edited slash text stays chat", () => {
  expect(buildUserPrompt("/help", [], true)).toEqual([
    { type: "text", text: "" },
    { type: "text", text: "/help" },
  ]);
  expect(buildUserPrompt(" /help", [], true)).toEqual([{ type: "text", text: " /help" }]);
  expect(buildUserPrompt("/help", [])).toEqual([{ type: "text", text: "/help" }]);
});
