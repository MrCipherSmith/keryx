import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const HUB_UPDATE_HELP = `keryx hub update [version] [--check|--dry-run] [--install-dir path] [--yes]
  Update the local server installation from a published release (default: latest stable).
  --check        Read installed/available release information; no services or data changed.
  --dry-run      Validate and preview an update without changing the installation.
  --install-dir  Installation root (default: ~/keryx-team-hub); run on the Hub host.
  --yes          Explicitly accept the installation tool's upgrade confirmation.
The release is built in CI. This command delegates to the installed hubctl, never a checkout,
Hub project token or remote HTTP update API. Legacy source-build installs need migration first.
`;

type UpdateArguments = { version: string; installDir: string; mode: "apply" | "check" | "dry-run"; yes: boolean };
const stableVersion = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const invalidArguments = () => new Error("Invalid hub update arguments; use keryx hub update --help");

function parseArguments(args: string[], home: string): UpdateArguments {
  let version: string | undefined;
  let installDir = join(home, "keryx-team-hub");
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value.startsWith("-")) {
      if (!["--check", "--dry-run", "--install-dir", "--yes"].includes(value) || flags.has(value)) throw invalidArguments();
      flags.add(value);
      if (value === "--install-dir") {
        const path = args[++i];
        if (!path || path.startsWith("-") || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /^[a-z][a-z0-9+.-]*:/i.test(path)) throw invalidArguments();
        installDir = resolve(path);
      }
    } else {
      if (version !== undefined || value.length > 128 || (value !== "latest" && !stableVersion.test(value))) throw invalidArguments();
      version = value;
    }
  }
  if ((flags.has("--check") && flags.has("--dry-run")) || (flags.has("--yes") && (flags.has("--check") || flags.has("--dry-run")))) throw invalidArguments();
  return { version: version ?? "latest", installDir, mode: flags.has("--check") ? "check" : flags.has("--dry-run") ? "dry-run" : "apply", yes: flags.has("--yes") };
}

/** Never discover executable paths from project bindings, credentials, PATH or shell text. */
async function installationTool(installDir: string): Promise<string> {
  try {
    const invokingUid = process.getuid?.();
    if (invokingUid === undefined) throw new Error("installation updates require Unix ownership checks");
    const trustedOwner = (uid: number) => uid === 0 || uid === invokingUid;
    const root = await realpath(installDir);
    const tool = join(root, "hubctl");
    const toolStat = await lstat(tool);
    if (!toolStat.isFile() || !trustedOwner(toolStat.uid) || (toolStat.mode & 0o022) !== 0 || toolStat.size > 256 * 1024) throw new Error("unsafe installation tool");
    await access(tool, constants.X_OK);
    const script = await readFile(tool, "utf8");
    if (!/^# keryx-hub-update-protocol: 1\r?$/m.test(script)) throw new Error("legacy installation: migrate this source-build Hub to the release installer before using hub update");
    const releases = await realpath(join(root, "releases"));
    const current = await realpath(join(root, "current"));
    if (dirname(releases) !== root || basename(releases) !== "releases" || dirname(current) !== releases || !stableVersion.test(basename(current))) throw new Error("unsafe installation layout");
    for (const path of [root, releases, current]) {
      const info = await stat(path);
      if (!info.isDirectory() || !trustedOwner(info.uid) || (info.mode & 0o022) !== 0) throw new Error("unsafe installation directory");
    }
    return tool;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("legacy installation")) throw error;
    throw new Error("Cannot use this Hub installation: expected an executable release-owned hubctl and current -> releases/<version>. Run on the Hub host or select --install-dir; legacy installs require migration.", { cause: error });
  }
}

/** Returns the exact installed-tool exit code; the CLI caller preserves it. */
export async function hubUpdateCommand(args: string[], options: { home?: string; write?: (text: string) => void } = {}): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    (options.write ?? console.log)(HUB_UPDATE_HELP);
    return 0;
  }
  const parsed = parseArguments(args, options.home ?? homedir());
  const tool = await installationTool(parsed.installDir);
  const command = parsed.mode === "check" ? ["update-check", parsed.version] : ["upgrade", parsed.version, ...(parsed.mode === "dry-run" ? ["--dry-run"] : parsed.yes ? ["--yes"] : [])];
  try {
    const child = Bun.spawn([tool, ...command], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } catch {
    throw new Error("Could not start the installed Hub update tool; check local installation permissions and required tools.");
  }
}
