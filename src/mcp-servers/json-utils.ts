// Flow 356 (A-5, audit remediation 3): `parseJsonTolerant`, split out of
// `config.ts` to break a cycle. `config.ts` imports `compatFiles`/
// `readCompatFile` from `./compat`, and `compat.ts` imported this function
// back from `./config` — the whole cycle `gdgraph query cycles` reported for
// the pair. This module has no import of either, so both can depend on it
// without depending on each other.

const BOM_PATTERN = new RegExp("^\\uFEFF");

/**
 * `JSON.parse`, minus a leading byte-order mark.
 *
 * EXPORTED and shared, because the first version of this put the strip in
 * `parseConfigFile` alone — one of the three readers of these same files.
 * The result was two surfaces disagreeing about one file: `keryx mcp list`
 * read a BOM'd config perfectly while `keryx mcp add` refused it, and
 * `keryx mcp enable` reported success while silently skipping the
 * sticky-flag cleanup. Worse, a BOM on the OVERLAY made `disable` not take
 * effect: the overrides were "ignored" and the server started.
 *
 * Windows editors write a BOM by default. It is not a syntax error the
 * operator made.
 */
export function parseJsonTolerant(text: string): unknown {
  return JSON.parse(text.replace(BOM_PATTERN, "")) as unknown;
}
