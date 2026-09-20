/**
 * The ONE definition of a safe workspace-relative reference, and the
 * normalization every caller-facing surface owes its input.
 *
 * Why this exists: the same regex used to live (and still does, unimported, in
 * `fwk-service.ts`/`policy-experiment.ts`) as a private const in `index.ts`,
 * while every surface that ACCEPTS a reference from a human or a model —
 * `workspace_create` (agent tool), `sac.workspaceCreate` (MCP) and
 * `keryx workspace create/add-resource --component/--uri` (CLI) — passed the
 * caller's raw string straight into `uri`. So the natural spelling
 * `src/harness/search` was rejected by the contract with a pair of schema
 * codes (`schema_pattern` + `unsafe_workspace_reference`) that name nothing a
 * caller can act on, and only `./src/harness/search` worked. The contract is
 * right to be strict about what reaches disk; the callers are the layer that
 * should say what shape is accepted, and normalize the obvious spelling.
 */

/**
 * The stored form: `./`-prefixed, no `..` segment, `[A-Za-z0-9._-]` per segment.
 *
 * The `..` prohibition is `(?!(?:.*\/)?\.\.(?:\/|$))`, NOT the
 * `(?!.*(?:^|\/)\.\.(?:\/|$))` it replaced. In a non-`m` regex `^` matches only
 * at index 0, and the engine has already consumed the leading `./` by the time
 * the lookahead runs — so a reference whose FIRST segment was `..`
 * (`./../escape`) satisfied that alternative and was ACCEPTED: the traversal
 * the lookahead exists to forbid. A `..` in any later position
 * (`./src/../x`) was caught, which is why this went unnoticed until the
 * round-trip test in workspace-reference.test.ts exercised `./../escape`.
 */
export const WORKSPACE_REFERENCE_PATTERN = /^\.\/(?!(?:.*\/)?\.\.(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export type WorkspaceReferenceResult = { ok: true; uri: string } | { ok: false; reason: string };

const UNSAFE_ABSOLUTE = /^[/\\]/;
const UNSAFE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Turn a caller-supplied reference into the stored form, or explain why it
 * cannot be one.
 *
 * Accepts what a person would type — `src/harness/search`, `./src/harness/search`,
 * `src/harness/search/` — and refuses, by name, what must never reach disk: an
 * absolute path, a URL, a Windows path, or a `..` segment. Refusal is a value
 * (`{ ok: false, reason }`), never a throw, so each surface can render it in
 * its own idiom (an agent tool returns an error output, MCP and the CLI throw).
 */
/** `normalizeWorkspaceReference`, for surfaces whose idiom is to throw. */
export function requireWorkspaceReference(raw: string): string {
  const normalized = normalizeWorkspaceReference(raw);
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.uri;
}

export function normalizeWorkspaceReference(raw: string): WorkspaceReferenceResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "a workspace reference must be a non-empty workspace-relative path, e.g. \"./src/harness/search\"" };
  }
  if (UNSAFE_ABSOLUTE.test(trimmed) || UNSAFE_SCHEME.test(trimmed) || trimmed.includes("\\")) {
    return {
      ok: false,
      reason: `"${trimmed}" is not a workspace-relative path — an absolute path, a URL and a Windows path are all refused. Use a path inside the project, e.g. "./src/harness/search".`,
    };
  }
  const withoutDotSlash = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const withoutTrailingSlash = withoutDotSlash.replace(/\/+$/, "");
  if (withoutTrailingSlash.length === 0) {
    return { ok: false, reason: `"${trimmed}" names the project root rather than a path inside it — name a directory or file, e.g. "./src/harness/search".` };
  }
  // Checked here as well as by the pattern below: a "." / ".." segment deserves
  // its own sentence (and this is the check that does not depend on getting a
  // lookahead's anchoring exactly right).
  const segments = withoutTrailingSlash.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return { ok: false, reason: `"${trimmed}" contains a "." or ".." path segment — a workspace reference must stay inside the project.` };
  }
  const uri = `./${withoutTrailingSlash}`;
  if (!WORKSPACE_REFERENCE_PATTERN.test(uri)) {
    return {
      ok: false,
      reason:
        `"${trimmed}" is not a usable workspace reference. The stored form is "${uri}" if the characters are the problem: ` +
        "each path segment may contain only letters, digits, \".\", \"_\" and \"-\", and no \"..\" segment is allowed.",
    };
  }
  return { ok: true, uri };
}
