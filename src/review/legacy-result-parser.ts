import type { ParsedResult } from "./ledger";

/**
 * `parseReviewResult` as it stood at 249bc59b, before flow 441 T1 (PR 997) replaced it. Kept byte-for-byte in behaviour so
 * the replay of the closed review rounds (`replay.ts`) can say what the parser used to return for a raw reviewer file.
 * Nothing else may call it: it nests, takes the last object with a string `status`, and accepts a status-only fragment.
 */
export function legacyParseReviewResult(raw: string): ParsedResult | undefined {
  const labelled = [...raw.matchAll(/```REVIEW_RESULT\s*\n([\s\S]*?)```/gi)];
  if (labelled.length > 0) {
    try {
      const parsed = JSON.parse(labelled[labelled.length - 1]![1]!);
      return parsed !== null && typeof parsed === "object" && typeof parsed.status === "string"
        ? parsed as ParsedResult : undefined;
    } catch { return undefined; }
  }
  let result: ParsedResult | undefined;
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < raw.length; end += 1) {
      const char = raw[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, end + 1));
          if (typeof parsed.status === "string") result = parsed as ParsedResult;
          start = end;
        } catch { /* prose brace: try the next candidate */ }
        break;
      }
    }
  }
  return result;
}
