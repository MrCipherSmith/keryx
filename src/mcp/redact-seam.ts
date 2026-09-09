// Mandatory deterministic output floor. Advisory settings never authorize
// disclosure of detected secrets. Keep all MCP security imports at this seam.
import { validateOutputForTransport, type OutputRedaction } from "../security/guard";
import { validateSerializedOutput } from "../security/service";
import type { JsonSchema } from "./types";

export type { OutputRedaction };
export function validateToolOutput(value: unknown, schema?: JsonSchema) {
  return validateOutputForTransport({ value, format: "json", ...(schema === undefined ? {} : { schema }) });
}
export function validateTextOutput(value: string) {
  return validateOutputForTransport({ value, format: "text" });
}

// Compatibility wrapper for callers holding serialized content. The old
// enabled flag remains accepted; it cannot disable the mandatory secret floor.
// It shares the serialized adapter with `validateSerializedOutput`, so the
// original bytes reach the client only when they are a faithful spelling of the
// structure the floor validated; a serialization carrying anything the walk did
// not see — a duplicate member, whatever it holds and however it is spelled — is
// replaced by the safe canonical form (T24 F-002). Spelling alone never costs a
// payload its bytes, so the client is never handed a different number than the
// one the tool produced (T24R2#F-002) and never told a redaction occurred when
// nothing was removed (T24R2#F-003).
//
// The adapter is reached through the `../security/service` facade, never by
// importing the validator: `src/mcp/boundary.test.ts` (M-3) forbids `src/mcp/`
// from importing a module's internals.
export async function redactToolOutput(
  _cwd: string,
  content: string,
  _enabled = true,
): Promise<string> {
  return validateSerializedOutput(content).text;
}
