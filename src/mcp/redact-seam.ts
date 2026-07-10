// Output-redaction choke point (specification.md §8, §11; M-5, AC4, C0-11).
//
// EVERY MCP tool result is routed through `security/guard.ts:redactRaw` before
// it reaches a transport. `redactRaw` is the single sanctioned dependency
// `src/mcp/` has on the security engine (M-3). When the security module is
// disabled it returns byte-identical content; on any internal error it degrades
// to the original content. This wrapper therefore NEVER throws and NEVER blocks
// a tool from returning — it only masks secrets in transit.

import { redactRaw } from "../security/guard";

// Redact a serialized tool result. `enabled=false` (config `redactToolOutput:
// false`) skips the seam entirely and returns the input unchanged.
export async function redactToolOutput(
  cwd: string,
  content: string,
  enabled = true,
): Promise<string> {
  if (!enabled || content.length === 0) {
    return content;
  }
  try {
    const { content: redacted } = await redactRaw({
      cwd,
      content,
      source: "tool-output",
    });
    return redacted;
  } catch {
    // Advisory-safe: a redaction failure must never break a tool response.
    return content;
  }
}
