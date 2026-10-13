// Line patterns shared by the splitter (format.ts) and the two renderers (format-html.ts,
// format-rich.ts), so a line is classified the same way everywhere (flow 395).

export const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
export const BULLET = /^([ \t]*)[-*][ \t]+(.*)$/;
/** An ordered list item: indentation, the number, the delimiter, the text. */
export const ORDERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+(.*)$/;
export const QUOTE = /^ {0,3}>(?: (.*))?$/;
/**
 * `---` (three or more hyphens, nothing else): a thematic break. `***` and `___` are left as
 * text on purpose: they are also what emphasis markers look like on their own, and 0.3.63 shows
 * them unchanged.
 */
export const RULE = /^ {0,3}-{3,}[ \t]*$/;
/** The text of a bullet that is a task item: `[ ] x`, `[x] x`, and the box alone. */
export const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;
export const UNCHECKED_BOX = "☐";
export const CHECKED_BOX = "☑";
export const RULE_GLYPH = "─";
/** How many glyphs a rendered rule is in HTML and plain text. */
export const RULE_LENGTH = 12;
