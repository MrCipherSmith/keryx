// Flow 313 (W4) review R2-F5 / R3-F7 / R3-F8, choke point d: the ONE logical-line
// splitter every header/line-based parser in the memory subsystem must use, so
// they all agree on what counts as a line break. Used by `memory/store.ts`
// (`parseEntry`, `collectEntriesStrict`), the MCP `memory.propose` guard
// (`mcp/tools.ts`) and `memory/templates.ts` (`renderMemoryEntry`'s injection
// guard) - never a locally re-derived split regex.
//
// Pre-fix, `memory/store.ts` normalised only CRLF/lone-CR before splitting on
// LF, while the MCP guard and `renderMemoryEntry`'s guard split on a
// different four-codepoint list - neither list included NEL (U+0085), and
// the guard's list silently drifted from the parser's. A `Target-Harnesses:`
// header line separated from the rest of the file by LINE SEPARATOR,
// PARAGRAPH SEPARATOR or NEL parsed as absent everywhere (fail-open: the
// restriction was silently lost) while a guard using the narrower list let a
// header-shaped line smuggled via one of those separators through
// undetected. One shared function closes both gaps at once and keeps every
// call site in agreement going forward.
//
// `src/mcp/` may import only service facades + `src/lib/*` (M-3) - this file
// lives in `src/lib/` precisely so the MCP boundary guard can depend on it
// without reaching into `memory/`'s internals.
//
// Built with `new RegExp` from escape sequences rather than a `/.../` literal
// containing the raw codepoints: a literal LINE SEPARATOR / PARAGRAPH
// SEPARATOR inside a regex literal is itself treated as a line terminator by
// some source tooling (and by the JS parser itself), which is exactly the
// ambiguity this file exists to close - the pattern must not itself depend
// on a tool treating those bytes as ordinary text.
const LOGICAL_LINE_BREAK_RE = new RegExp("\\r\\n|\\r|\\n|\\u2028|\\u2029|\\u0085");

/**
 * Splits `text` into logical lines on every line-terminator codepoint this
 * codebase's header parsers must treat as a line break: LF, CR (bare or as
 * part of CRLF), U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR) and
 * U+0085 (NEXT LINE). Never U+000B/U+000C (vertical tab / form feed) or any
 * Unicode space separator - those are intra-line whitespace, not line
 * breaks, and folding them in here would silently change what a single
 * logical line is for every caller.
 */
export function splitLogicalLines(text: string): string[] {
  return text.split(LOGICAL_LINE_BREAK_RE);
}
