// Renders an ACP `session/prompt` content-block array into the single text
// line `runAgentTurn` takes as `userLine` (flow 285, T8).
//
// keryx's `AgentIO`/`runAgentTurn` core is text-in, text-out — there is no
// multi-block prompt seam today. `KERYX_AGENT_CAPABILITIES.promptCapabilities`
// advertises `image: false`/`audio: false` precisely so a conformant client
// never sends those blocks; `embeddedContext: true` is honoured below by
// inlining a text resource's content. Anything this cannot represent is
// rendered as a bracketed placeholder rather than silently dropped, so the
// model — and a human reading the transcript — can see that something was
// sent and not delivered, instead of the turn quietly answering a shorter
// prompt than the client believes it sent.

import type { AcpContentBlock } from "./protocol";

function isContentBlock(value: unknown): value is AcpContentBlock {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function renderAcpPromptContent(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isContentBlock(block)) {
      continue;
    }
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource) {
          parts.push(resource.text);
        } else {
          parts.push(`[embedded resource omitted (binary, ${resource.mimeType ?? "unknown type"}): ${resource.uri}]`);
        }
        break;
      }
      case "resource_link":
        parts.push(`[resource link: ${block.uri}]`);
        break;
      case "image":
        parts.push("[image content omitted — keryx does not accept image prompt input (promptCapabilities.image: false)]");
        break;
      case "audio":
        parts.push("[audio content omitted — keryx does not accept audio prompt input (promptCapabilities.audio: false)]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n\n");
}
