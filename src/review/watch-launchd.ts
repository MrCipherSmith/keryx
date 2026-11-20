import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath, rm, stat } from "node:fs/promises";
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
  const contents = await ownedContents(plist, label);
  return hasPinnedTools(contents) && (await programAvailable(loaded.program));
}

function hasPinnedTools(contents: string | null) {
  return !!contents?.includes("<key>KERYX_REVIEW_GIT_BIN</key>") && contents.includes("<key>KERYX_REVIEW_GH_BIN</key>");
}

/** A loaded pre-upgrade timer can outlive both Desktop and the plist on disk. */
export async function verifyWatcherTimerTools(project: string, key: WatcherKey, host: ScheduleHost) {
  if ((host.platform ?? process.platform) !== "darwin" || (process.env.KERYX_REVIEW_GIT_BIN && process.env.KERYX_REVIEW_GH_BIN)) return;
  if (!await watcherLoaded(project, key, host)) return;
  const { plist, label } = service(project, key, host);
  if (!hasPinnedTools(await ownedContents(plist, label)))
    throw new Error("configuration: Enable the watcher again to verify its executable paths.");
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

const systemDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const watcherTools = ["gh", "git", "rg"] as const;

async function watcherToolsPath(checkouts: string[]) {
  const outsideCheckouts = (candidate: string) => checkouts.every(root => {
    const relative = path.relative(root, candidate);
    return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
  });
  const found = new Map<string, string>();
  const dirs = new Set<string>();
  const verifiedSystemDirs = new Set<string>();
  const inherited = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of new Set([...inherited, ...systemDirs])) {
    if (!path.isAbsolute(entry) || !outsideCheckouts(path.resolve(entry))) continue;
    const dir = await realpath(entry).catch(() => undefined);
    if (!dir || !outsideCheckouts(dir)) continue;
    const targets = await Promise.all(watcherTools.map(async tool => {
      const file = path.join(dir, tool);
      try {
        await lstat(file);
      } catch (error) {
        return isNotFound(error) ? undefined : null;
      }
      // A dangling link also disqualifies the directory: a later checkout
      // update could create the missing target after the timer was installed.
      const target = await realpath(file).catch(() => undefined);
      if (!target || !outsideCheckouts(target)) return null;
      if (!(await stat(target)).isFile() || !Bun.which(tool, { PATH: dir })) return undefined;
      return { tool, target };
    }));
    // Even a directory selected only for rg could shadow gh or git on the next tick.
    if (targets.includes(null)) continue;
    if (systemDirs.includes(entry)) verifiedSystemDirs.add(dir);
    for (const item of targets) {
      if (!item || found.has(item.tool)) continue;
      found.set(item.tool, item.target);
      dirs.add(dir);
    }
  }
  for (const tool of ["gh", "git"]) {
    if (!found.has(tool)) throw new Error(`configuration: Install ${tool} outside the project's worktrees before enabling the watcher.`);
  }
  return {
    PATH: [...new Set([...dirs, ...verifiedSystemDirs])].join(path.delimiter),
    KERYX_REVIEW_GH_BIN: found.get("gh")!,
    KERYX_REVIEW_GIT_BIN: found.get("git")!,
  };
}

export async function watcherProgram(checkouts: string[], host: ScheduleHost) {
  const invocation = host.invocation ?? resolveKeryxInvocation();
  if (invocation.execPath.includes("/AppTranslocation/")) {
    throw new Error("configuration: Move Keryx to Applications and reopen it before enabling a watcher.");
  }
  await access(invocation.execPath, constants.X_OK);
  if (invocation.scriptPath) await access(invocation.scriptPath, constants.R_OK);
  const env: Record<string, string> = {
    ...await watcherToolsPath(checkouts),
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
