import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { isNotFound, writeFileAtomic } from "../lib/fs";
import { keryxDataDir, readConfigFile } from "../lib/config-dir";
import { launchAgentsDir, runner, xml, type ScheduleHost } from "../trigger/install";
import { invocationArgv, resolveKeryxInvocation } from "../trigger/schedule";
import type { WatcherKey } from "./watcher-types";

export function watcherLabel(project: string, key: WatcherKey): string {
  const identity = JSON.stringify([project, key.repositoryId, key.viewer.toLowerCase()]);
  return "com.keryx.review-watch." + createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function service(project: string, key: WatcherKey, host: ScheduleHost) {
  const label = watcherLabel(project, key);
  const domain = `gui/${host.uid ?? process.getuid!()}`;
  return {
    label,
    domain,
    name: domain + "/" + label,
    plist: path.join(launchAgentsDir(host), label + ".plist"),
  };
}

async function watcherLoaded(project: string, key: WatcherKey, host: ScheduleHost) {
  if ((host.platform ?? process.platform) !== "darwin") return null;
  const { name, plist } = service(project, key, host);
  const result = await runner(host)("/bin/launchctl", ["print", name]);
  if (result.code === 0) {
    const loadedPath = /^\s*path = (.+)$/m.exec(result.stdout)?.[1]?.trim();
    if (loadedPath !== plist)
      throw new Error("configuration: Another LaunchAgent owns this watcher's service name.");
    return { program: /^\s*program = (.+)$/m.exec(result.stdout)?.[1]?.trim() };
  }
  if (result.code === 113 || /could not find service|could not find specified service/i.test(result.stderr))
    return null;
  throw new Error(
    "unavailable: Cannot inspect the local launchd service. Sign in to a macOS desktop session.",
  );
}

async function programAvailable(program: string | undefined): Promise<boolean> {
  // Older launchctl versions omit this field. The managed plist is still checked separately.
  if (!program) return true;
  try {
    await access(program, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function watcherInstalled(
  project: string,
  key: WatcherKey,
  host: ScheduleHost,
): Promise<boolean> {
  const loaded = await watcherLoaded(project, key, host);
  if (!loaded) return false;
  const { plist, label } = service(project, key, host);
  // A loaded job with a deleted plist still fires in this login session, but won't survive the next login.
  return (await ownedContents(plist, label)) !== null && (await programAvailable(loaded.program));
}

function marked(label: string) {
  return `<!-- managed by Keryx: ${label} -->`;
}

async function ownedContents(plist: string, label: string) {
  try {
    if (!(await lstat(plist)).isFile()) throw new Error("configuration: Expected a regular LaunchAgent file.");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const result = readConfigFile(plist);
  if (!result.ok) throw new Error("configuration: Cannot read the watcher LaunchAgent file.");
  const contents = result.text;
  if (!contents.includes(marked(label))) {
    throw new Error(
      "configuration: The watcher's LaunchAgent path contains a file managed by another application.",
    );
  }
  return contents;
}

export async function watcherProgram(project: string, host: ScheduleHost) {
  const invocation = host.invocation ?? resolveKeryxInvocation();
  if (invocation.execPath.includes("/AppTranslocation/")) {
    throw new Error("configuration: Move Keryx to Applications and reopen it before enabling a watcher.");
  }
  await access(invocation.execPath, constants.X_OK);
  if (invocation.scriptPath) await access(invocation.scriptPath, constants.R_OK);
  await access(project, constants.X_OK);

  // launchd has no login-shell PATH. Pin the directories for the tools we checked,
  // leaving out relative paths and project-local executables.
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((p) => path.isAbsolute(p) && p !== project && !p.startsWith(project + path.sep));
  const find = (file: string) => {
    const executable = Bun.which(file, { PATH: dirs.join(path.delimiter) || "/usr/bin:/bin" });
    if (!executable) throw new Error(`configuration: Install ${file} on PATH before enabling the watcher.`);
    return path.dirname(executable);
  };
  const toolDirs = [find("gh"), find("git")];
  const env: Record<string, string> = {
    PATH: [
      ...new Set([
        ...dirs.filter((dir) => toolDirs.includes(dir)),
        ...toolDirs,
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]),
    ].join(":"),
    KERYX_DATA_DIR: path.resolve(keryxDataDir()),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    if (process.env[name]) env[name] = path.resolve(process.env[name]!);
  }
  return { argv: invocationArgv(invocation), env };
}

export async function reconcileWatcherTimer(
  project: string,
  key: WatcherKey,
  host: ScheduleHost,
  active?: { minutes: number; program: Awaited<ReturnType<typeof watcherProgram>> },
): Promise<boolean> {
  if ((host.platform ?? process.platform) !== "darwin") {
    if (!active) return false;
    throw new Error("configuration: A local Review watcher requires macOS launchd.");
  }
  const { label, name, domain, plist } = service(project, key, host);
  const run = runner(host);
  const previous = await ownedContents(plist, label);
  const installed = await watcherLoaded(project, key, host);

  let contents: string | undefined;
  if (active) {
    const args = [
      ...active.program.argv,
      "review",
      "watch",
      "tick",
      "--repo",
      key.repo,
      "--repository-id",
      key.repositoryId,
      "--viewer",
      key.viewer,
      "--json",
    ];
    const pairs = Object.entries(active.program.env);
    // XML 1.0 cannot encode these characters even as entities.
    if (
      [...args, ...pairs.map(([, value]) => value), project].some((v) =>
        // eslint-disable-next-line no-control-regex -- validate filesystem strings before plist serialization
        /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v),
      )
    ) {
      throw new Error("configuration: A watcher path contains an unsupported control character.");
    }
    contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marked(label)}
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>EnvironmentVariables</key><dict>${pairs.map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>StartInterval</key><integer>${active.minutes * 60}</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
    if (contents === previous && installed && (await programAvailable(installed.program))) return true;
  }
  if (installed) {
    const stop = await run("/bin/launchctl", ["bootout", name]);
    if (stop.code !== 0 && (await watcherLoaded(project, key, host)))
      throw new Error("unavailable: Could not stop the launchd watcher. Retry Pause.");
  }
  if (!contents) {
    if (previous) await rm(plist, { force: true });
    return false;
  }
  await writeFileAtomic(plist, contents, { mode: 0o600 });
  const start = await run("/bin/launchctl", ["bootstrap", domain, plist]);
  if (start.code !== 0) {
    throw new Error(
      "unavailable: launchd could not install the watcher. Check your macOS login session and enable it again.",
    );
  }
  return true;
}
