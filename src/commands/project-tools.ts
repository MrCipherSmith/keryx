// The project tools — keryx's read-only metaproject operations (graph, wiki,
// memory, flow status, skills, repomap, test_related, health status and
// `search_code`) — and the gate that decides whether a project gets them.
//
// ONE assembly, called by every surface that offers them: `keryx shell`'s
// factory (`buildInteractiveAgentTools`) and `keryx acp`'s session roster
// (`../acp/roster.ts`, flow 288 AC1). Before this existed the gate lived inline
// in the shell factory, and a second surface could only get the same set by
// copying it — which is exactly how two rosters drift.

import { builtinMetaprojectTools, makeKeryxRunner } from "../harness/tool/builtin/metaproject-tools";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { offersIndexTools } from "../lib/metaproject-state";

/**
 * The metaproject tools that work in a project with no USABLE metaproject.
 *
 * Every other metaproject operation reads an artifact under `.metaproject/` — the
 * graph database, the wiki, memory, flows, health and testing reports, the skill
 * tree — and in a project without one it can only fail. The arena's control arm
 * was offered all of them, called `graph_find`, and got `index-incomplete … never
 * built here`; each was also a description the model re-read every round.
 * `search_code` runs ripgrep over the tree and needs nothing.
 *
 * "Without one" is `offersIndexTools`' question: a manifest-less project that still has
 * a built graph or wiki KEEPS its tools (`keryx update` restores the manifest), and a
 * bare `.metaproject/` with nothing under it does not get them merely by existing. What
 * must never happen is offering them to a session whose every call can only answer
 * `index-incomplete` — an empty answer that reads like an empty project.
 */
export const METAPROJECT_FREE_TOOLS: ReadonlySet<string> = new Set(["search_code"]);

export interface ProjectTools {
  /**
   * Every project tool, whatever the project. The shell checks `--deny-tools`
   * against this full set, so a denial names a real tool in every directory.
   */
  readonly all: readonly InteractiveTool[];
  /** The subset this project is offered: `all` when `offersIndexTools`, else only `METAPROJECT_FREE_TOOLS`. */
  readonly offered: readonly InteractiveTool[];
}

/**
 * Build the project tools bound to `cwd` and decide which of them `cwd` is offered.
 *
 * K-009's project filter, re-based on "is this a metaproject these tools can read"
 * rather than "does a `.metaproject` directory exist". The directory alone is what a
 * not-quite-initialized project has, and offering eighteen tools that can only answer
 * `index-incomplete` — in a session whose operator reads emptiness as a finding — is
 * the defect this filter exists to close.
 */
export function buildProjectTools(cwd: string, metaprojectPort: MetaprojectPort): ProjectTools {
  const all = builtinMetaprojectTools(cwd, makeKeryxRunner(cwd), metaprojectPort);
  const offered = offersIndexTools(cwd) ? all : all.filter((tool) => METAPROJECT_FREE_TOOLS.has(tool.definition.name));
  return { all, offered };
}
