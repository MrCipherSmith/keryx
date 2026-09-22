// Is there a keryx metaproject here — and is it one the index tools can answer from?
//
// The DIRECTORY is not evidence of anything. `.metaproject/` can exist with nothing in it
// but an empty `workspaces/`: an interrupted `keryx init`, a hand-made folder, a checkout
// that kept one subdirectory. `keryx status` has always answered this in three ways
// (`not initialized` / `incomplete` / `ready`), but the agent surfaces tested
// `existsSync(".metaproject")` and stopped there — so a session opened in such a project
// was handed the graph/wiki/memory/health/flow/skills tools, every call came back
// `index-incomplete`, and an empty answer read like an empty project instead of an
// unusable workspace. Measured on a `vantage-specs` checkout holding only
// `.metaproject/workspaces/`: eighteen index tools offered, all of them unusable.
//
// This module is the ONE place that answers the question, for both the CLI report and the
// tool roster, so the two cannot drift apart again.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * `absent` — no `.metaproject/` at all: an ordinary repository, and `keryx shell` is
 * expected to work in it as a plain agent.
 *
 * `incomplete` — the directory is there but the manifest is missing, unreadable or not a
 * JSON object: something was started and did not finish.
 *
 * `ready` — `.metaproject/metaproject.json` is present and parses: exactly the condition
 * `keryx status` reports as ready.
 */
export type MetaprojectState =
  | { readonly state: "absent" }
  | {
      readonly state: "incomplete";
      readonly reason: "missing-manifest" | "unreadable-manifest";
      /** Operator-facing detail: what was looked for, or what went wrong reading it. */
      readonly detail: string;
    }
  | { readonly state: "ready" };

export function metaprojectDir(cwd: string): string {
  return path.join(cwd, ".metaproject");
}

export function metaprojectManifestPath(cwd: string): string {
  return path.join(metaprojectDir(cwd), "metaproject.json");
}

/** Never throws: an unreadable or non-object manifest is a state, not an exception. */
export function readMetaprojectState(cwd: string): MetaprojectState {
  if (!existsSync(metaprojectDir(cwd))) {
    return { state: "absent" };
  }
  const manifestPath = metaprojectManifestPath(cwd);
  if (!existsSync(manifestPath)) {
    return {
      state: "incomplete",
      reason: "missing-manifest",
      detail: "missing .metaproject/metaproject.json",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      state: "incomplete",
      reason: "unreadable-manifest",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      state: "incomplete",
      reason: "unreadable-manifest",
      detail: ".metaproject/metaproject.json is not a JSON object",
    };
  }
  return { state: "ready" };
}

/** The parsed manifest, or `undefined` when it is missing, unreadable or not an object. */
export function readMetaprojectManifest<T = Record<string, unknown>>(cwd: string): T | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metaprojectManifestPath(cwd), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as T;
  } catch {
    return undefined;
  }
}

/**
 * What only exists because something was actually BUILT under `.metaproject/`.
 *
 * Deliberately NOT the directory, and deliberately not `index.md`: a project holding a
 * routing document but no graph, wiki or memory has nothing for these tools to read, and
 * injecting that routing document is what tells a model to run `keryx gdgraph build` in a
 * workspace that was never initialized. `.metaproject/workspaces/` does not qualify either
 * — an empty SAC workspace is exactly the shape this predicate exists to reject.
 */
export const INDEX_ARTIFACT_PATHS: readonly (readonly string[])[] = [
  ["data", "gdgraph", "artifacts", "summary.md"], // the code graph was built
  ["wiki", "index.md"], // the wiki was built
  ["memory"], // a project memory store exists
];

export function hasIndexArtifacts(cwd: string): boolean {
  return INDEX_ARTIFACT_PATHS.some((parts) => existsSync(path.join(metaprojectDir(cwd), ...parts)));
}

/**
 * Should this session be offered the metaproject-bound tools (`graph_*`, `wiki_*`,
 * `memory_search`, `health_status`, `flow_status`, `skills_*`, `test_related`, `repomap`, …)?
 *
 * A manifest-less project that still HAS an index is kept, not stripped: `keryx update`
 * recovers `metaproject.json` for metaprojects created before it existed, and until that
 * runs, the graph and wiki answer perfectly well from the artifacts on disk. The question
 * here is "can these tools read anything", which is what a roster is for — not "does the
 * workspace validate".
 */
export function offersIndexTools(cwd: string): boolean {
  const state = readMetaprojectState(cwd);
  if (state.state === "ready") {
    return true;
  }
  return state.state === "incomplete" && hasIndexArtifacts(cwd);
}

/**
 * One operator-facing line for the state that is confusing on its own — `.metaproject/`
 * exists, so nothing looks wrong, but the session's index tools are missing. `undefined`
 * when there is nothing to say: no `.metaproject/` at all is a normal repository, and a
 * ready workspace needs no note. The caller adds the newline.
 */
export function metaprojectIncompleteNotice(cwd: string): string | undefined {
  const state = readMetaprojectState(cwd);
  if (state.state !== "incomplete") {
    return undefined;
  }
  return hasIndexArtifacts(cwd)
    ? "Metaproject: incomplete (" + state.detail + ") — the index was built but this " +
        "workspace has no manifest; run `keryx update` to restore it."
    : "Metaproject: incomplete (" + state.detail + ") — the graph, wiki, memory, health, " +
        "flow and skills tools are not offered in this session. Run `keryx update` (or " +
        "`keryx init`) to create the workspace they read.";
}
