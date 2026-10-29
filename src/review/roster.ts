import { installedReviewerNames } from "./coverage";
import { manifestRosterRoles } from "./round-split";
import type { SliceEntry } from "./slice";

/** The roster roles a slice manifest adds to a round, limited to the reviewers the project at `root` has installed. */
export async function installedRosterRoles(root: string, manifest: { slices: readonly SliceEntry[] }): Promise<string[]> {
  return manifestRosterRoles(manifest, await installedReviewerNames(root));
}
