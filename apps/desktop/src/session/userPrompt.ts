import type { LocalAttachment } from "./chatImages";
import type { PicksBlock } from "../panels/elementPicks";

export interface UserPromptContext {
  images: readonly string[];
  local: readonly LocalAttachment[];
  pickedCount: number;
  blocks: readonly object[];
}

export function userPromptContext(images: readonly string[], local: readonly LocalAttachment[], picked?: { count: number; block: PicksBlock }): UserPromptContext {
  const lines = [
    ...images.map((path) => `Image: ${JSON.stringify(path)}`),
    ...local.map(({ kind, label, path }) => `${kind === "folder" ? "Folder" : "File"} ${JSON.stringify(label)}: ${JSON.stringify(path)}`),
  ];
  const blocks: object[] = picked ? [picked.block] : [];
  if (lines.length) blocks.push({
    type: "resource",
    resource: { uri: "keryx-desktop:local-attachments", mimeType: "text/plain", text: `Local attachment paths:\n${lines.join("\n")}` },
    _meta: { keryx: { untrusted: true } },
  });
  return { images, local, pickedCount: picked?.count ?? 0, blocks };
}

export function buildUserPrompt(text: string, extra: readonly object[], literal = false): object[] {
  const body = text.trim() ? [{ type: "text", text }] : [];
  // ACP recognizes commands only in the first text block. A resend is never a command.
  if (literal && text.startsWith("/")) return [{ type: "text", text: "" }, ...body, ...extra];
  return [...body, ...extra];
}

// Older ACP replays flatten resource blocks to annotated text. Do not resend that text as operator instructions.
export function replayHasFlattenedContext(text: string): boolean {
  // The header line and the closing marker of an untrusted block (see untrustedBoundary in src/acp/prompt-content.ts).
  return /(?:^|\n)\[(?:external content [\w-]+ from [^\n\]]+|end of external content [\w-]+\])/.test(text);
}
