/**
 * The id form a finding's display `id` must have, checked where findings and claims are first accepted (flow 460).
 *
 * `#` is the global_id separator: ingest mints `<reviewId>#<id>`, and review-finding.schema.json requires a global_id
 * to hold exactly one `#`. A display id that already holds one (`review-logic-w1#F-001`, as an operator consolidating
 * several waves might write it) mints a key the schema refuses, and that refusal used to be the first place it failed:
 * after locating, verifying and merging the whole round. So every place that takes a display id refuses it up front.
 */

/** The display id form, in words, for every refusal. */
export const DISPLAY_ID_FORM =
  'a display id holds no "#": "#" separates a global_id (`<reviewId>#<id>`), which ingest mints. Use another separator, e.g. `review-logic-w1:F-001`';

/** Whether `id` is a display id ingest can mint a global_id from. Not a string is not this check's concern. */
export function displayIdHasHash(id: unknown): id is string {
  return typeof id === "string" && id.includes("#");
}

/** The display ids among `ids` that hold `#`, distinct and in order. */
export function hashedDisplayIds(ids: Iterable<unknown>): string[] {
  const found: string[] = [];
  for (const id of ids) {
    if (displayIdHasHash(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

/** One refusal line: which ids, where, and the form ingest needs. */
export function hashedDisplayIdMessage(ids: readonly string[], where: string): string {
  const shown = ids.slice(0, 8).join(", ") + (ids.length > 8 ? `, … (+${ids.length - 8})` : "");
  return `${ids.length} finding id(s) in ${where} hold "#": ${shown}. ${DISPLAY_ID_FORM}.`;
}
