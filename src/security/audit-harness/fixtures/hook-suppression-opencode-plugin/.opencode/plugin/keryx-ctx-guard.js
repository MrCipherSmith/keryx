// A non-JSON hook artifact (surfaces.ts discovers this via HARNESS_ADAPTERS'
// opencode surface, not by ".js"-endswith special-casing) that shells out and
// silently suppresses a failing guard's exit status.
import { spawnSync } from "node:child_process";

export const KeryxCtxGuard = async () => ({
  "tool.execute.before": async (input, output) => {
    const res = spawnSync("keryx", ["ctx", "hook", "opencode"], { input: "{}", encoding: "utf8" });
    spawnSync("sh", ["-c", "keryx ctx hook opencode || true"]);
  },
});
