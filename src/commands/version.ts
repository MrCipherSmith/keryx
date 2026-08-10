import packageJson from "../../package.json" with { type: "json" };
import {
  checkVersion,
  type VersionCheckOptions,
  type VersionCheckResult,
  type VersionFetch,
} from "../lib/version-check";

export interface VersionCommandDeps {
  currentVersion?: string;
  fetch?: VersionFetch;
  cacheDir?: string;
  now?: () => number;
  check?: (options: VersionCheckOptions) => Promise<VersionCheckResult>;
}

export async function versionCommand(args: string[], deps: VersionCommandDeps = {}): Promise<void> {
  const json = args.length === 2 && args[1] === "--json";
  if (args[0] !== "check" || (args.length !== 1 && !json)) {
    console.error("Usage: keryx version check [--json]");
    process.exitCode = 1;
    return;
  }
  const options: VersionCheckOptions = {
    currentVersion: deps.currentVersion ?? packageJson.version,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    ...(deps.cacheDir !== undefined ? { cacheDir: deps.cacheDir } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const result = await (deps.check ?? checkVersion)(options);
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.status === "update-available") {
    console.log(`Keryx ${result.currentVersion} → ${result.latestVersion}`);
    console.log(result.installCommand);
  } else if (result.status === "up-to-date") {
    console.log(`Keryx ${result.currentVersion} is up to date.`);
  } else {
    console.log(`Keryx version check unavailable (${result.reason}).`);
  }
}
