import { createHash } from "node:crypto";
import type { HarnessId } from "./manifest";

/** Prefix of an activity-layer rule on the claude target (ADR-0001 P5): `.claude/rules/keryx-activity-<name>.mdc`. */
export const CLAUDE_ACTIVITY_RULE_PREFIX = "keryx-activity-";

/**
 * A skill or rule names an activity rule at its keryx path,
 * `.metaproject/rules/activity/<name>.mdc`, or shortened to
 * `rules/activity/<name>.mdc` or `activity/<name>.mdc` — the review lenses all
 * point at `review.mdc` instead of carrying the shared laws (ADR-0001 P5). The
 * claude target installs that rule at `.claude/rules/keryx-activity-<name>.mdc`,
 * so every skill and rule file installed there is rewritten to cite that path:
 * otherwise a Claude Code agent would be sent to a file the install never wrote
 * (review of #1229, M2 and N1). The match starts at a path boundary, so the
 * project's own copy, `.metaproject/rules/project/activity/…`, is left as
 * written.
 */
const ACTIVITY_CITATION = /(?<![\w./-])(?:\.metaproject\/)?(?:rules\/)?activity\/([a-z0-9._-]+\.mdc)/g;

/** The bytes `destination` receives on `target`: the source, with any per-target rewrite applied. */
export function installedContent(target: HarnessId, destination: string, source: Buffer): Buffer {
  if (target !== "claude" || !destination.startsWith(".claude/") || !/\.mdc?$/.test(destination)) return source;
  const text = source.toString("utf8");
  const rewritten = text.replace(ACTIVITY_CITATION, `.claude/rules/${CLAUDE_ACTIVITY_RULE_PREFIX}$1`);
  return rewritten === text ? source : Buffer.from(rewritten, "utf8");
}

/** sha256 of {@link installedContent}: what the destination holds once written. */
export function installedSha256(target: HarnessId, destination: string, source: Buffer): string {
  return createHash("sha256").update(installedContent(target, destination, source)).digest("hex");
}
