import { GIT_DISCOVERY_OVERRIDE_VARS } from "../lib/git-env";
import { privateGitEnv } from "./autonomous-run";

/** Direct fixture commands and CLI children always discover the temporary repository. */
export function fixtureGitEnv(): NodeJS.ProcessEnv {
  return { ...privateGitEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

/** In-process Review lookups use process.env. Restore only repository discovery overrides. */
export function isolateGitDiscovery(): () => void {
  const saved = new Map(GIT_DISCOVERY_OVERRIDE_VARS.map(name => [name, process.env[name]]));
  for (const name of saved.keys()) delete process.env[name];
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
