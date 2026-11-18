// `keryx app install|update|build|status` — the desktop app's install and
// update channel while it has no Developer ID (decision D-15 in
// docs/requirements/keryx-desktop-client/decisions.md).
//
// install/update: the newest `desktop-v*` GitHub release → the
// `Keryx_<version>_<arch>.app.tar.gz` asset for this machine → SHA-256 checked
// against the release's `SHA256SUMS` → unpacked next to the target → swapped
// into place by rename, with the old app restored if the swap fails. A file
// fetched here carries no quarantine attribute, so the ad-hoc signed app opens.
//
// build: development only — runs `scripts/desktop/build.sh` in a keryx checkout.
// status: what is installed, what is released, and whether this keryx needs a
// newer app. The desktop app reads `status --json` for its update banner.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { MIN_DESKTOP_VERSION } from "../acp/profile";

export const APP_USAGE = `Usage:
  keryx app status [--json] [--pre] [--dir <folder>]
  keryx app install [--pre] [--dir <folder>] [--force] [--wait-pid <pid>] [--relaunch]
  keryx app update  [--pre] [--dir <folder>] [--wait-pid <pid>] [--relaunch]
  keryx app build

  status    Installed Keryx.app version, newest desktop release, and whether this keryx needs a newer app
  install   Download the newest desktop release and install it as <folder>/Keryx.app (default /Applications)
  update    Same as install, but only when the release is newer than the installed app
  build     Build the app from this keryx repository checkout (scripts/desktop/build.sh), for development

  --pre             Include pre-releases
  --dir <folder>    Install folder instead of /Applications
  --force           install: reinstall even when the same version is installed
  --wait-pid <pid>  Wait for that process (the running app) to exit before replacing it
  --relaunch        Open the app afterwards (also after a failed update, so the old app comes back)`;

export const APP_NAME = "Keryx.app";
export const DEFAULT_RELEASES_API = "https://api.github.com/repos/MrCipherSmith/keryx";
const TAG_PREFIX = "desktop-v";
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const WAIT_PID_TIMEOUT_MS = 60_000;

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size?: number;
}

export interface DesktopRelease {
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly htmlUrl?: string;
  readonly assets: readonly ReleaseAsset[];
}

export interface AppCommandDeps {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Releases API base (the repository URL); `KERYX_APP_RELEASES_API` overrides the default. */
  readonly releasesApi?: string;
  readonly arch?: string;
  readonly platform?: string;
  readonly keryxVersion?: string;
  readonly cwd?: string;
  /** Is any process running from inside this app bundle? */
  readonly isAppRunning?: (appPath: string) => boolean;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly openApp?: (appPath: string) => void;
  readonly runBuild?: (script: string, cwd: string) => Promise<number>;
  readonly untar?: (archive: string, into: string) => void;
  readonly waitPidTimeoutMs?: number;
}

interface Flags {
  json: boolean;
  pre: boolean;
  force: boolean;
  relaunch: boolean;
  dir?: string;
  waitPid?: number;
}

class AppCommandError extends Error {}

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = { json: false, pre: false, force: false, relaunch: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--json": flags.json = true; break;
      case "--pre": flags.pre = true; break;
      case "--force": flags.force = true; break;
      case "--relaunch": flags.relaunch = true; break;
      case "--dir": {
        const value = args[i + 1];
        if (!value) throw new AppCommandError("--dir needs a folder");
        flags.dir = path.resolve(value);
        i += 1;
        break;
      }
      case "--wait-pid": {
        const value = Number(args[i + 1]);
        if (!Number.isInteger(value) || value <= 0) throw new AppCommandError("--wait-pid needs a process id");
        flags.waitPid = value;
        i += 1;
        break;
      }
      default:
        throw new AppCommandError(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

export function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a.replace(/^v/, ""), b.replace(/^v/, ""));
}

/** The asset arch labels Tauri uses, most specific first. */
export function archLabels(arch: string): readonly string[] {
  if (arch === "arm64") return ["aarch64", "universal"];
  if (arch === "x64") return ["x64", "universal"];
  return ["universal"];
}

export function pickAsset(release: DesktopRelease, arch: string): ReleaseAsset | undefined {
  for (const label of archLabels(arch)) {
    const want = `Keryx_${release.version}_${label}.app.tar.gz`;
    const found = release.assets.find((a) => a.name === want);
    if (found) return found;
  }
  return undefined;
}

/** `SHA256SUMS` in `shasum -a 256` form: `<hex>  <name>` (a `*` before the name marks binary mode). */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2]) sums.set(path.basename(match[2]), match[1].toLowerCase());
  }
  return sums;
}

/** `CFBundleShortVersionString` from an XML Info.plist. */
export function readBundleVersion(appPath: string): string | undefined {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(plist)) return undefined;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
  return match?.[1]?.trim();
}

function releasesApi(deps: AppCommandDeps): string {
  return (deps.releasesApi ?? process.env.KERYX_APP_RELEASES_API ?? DEFAULT_RELEASES_API).replace(/\/+$/, "");
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>;
}

export async function fetchLatestRelease(deps: AppCommandDeps, includePre: boolean): Promise<DesktopRelease | undefined> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = `${releasesApi(deps)}/releases?per_page=100`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "keryx-cli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AppCommandError(`GitHub releases request failed: HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new AppCommandError("GitHub releases response is not a list");
  const releases: DesktopRelease[] = [];
  for (const raw of body as GithubRelease[]) {
    if (typeof raw.tag_name !== "string" || !raw.tag_name.startsWith(TAG_PREFIX)) continue;
    if (raw.draft === true) continue;
    const prerelease = raw.prerelease === true;
    if (prerelease && !includePre) continue;
    const version = raw.tag_name.slice(TAG_PREFIX.length);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) continue;
    releases.push({
      tag: raw.tag_name,
      version,
      prerelease,
      ...(typeof raw.html_url === "string" ? { htmlUrl: raw.html_url } : {}),
      assets: (raw.assets ?? []).flatMap((a) =>
        typeof a.name === "string" && typeof a.browser_download_url === "string"
          ? [{ name: a.name, url: a.browser_download_url, ...(typeof a.size === "number" ? { size: a.size } : {}) }]
          : [],
      ),
    });
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return releases[0];
}

async function download(deps: AppCommandDeps, asset: ReleaseAsset, to: string): Promise<string> {
  if (asset.size !== undefined && asset.size > MAX_ASSET_BYTES) {
    throw new AppCommandError(`${asset.name} is larger than ${MAX_ASSET_BYTES} bytes`);
  }
  const fetchImpl = deps.fetch ?? fetch;
  const response = await fetchImpl(asset.url, {
    headers: { accept: "application/octet-stream", "user-agent": "keryx-cli" },
    redirect: "follow",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok) throw new AppCommandError(`Download of ${asset.name} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new AppCommandError(`${asset.name} is larger than ${MAX_ASSET_BYTES} bytes`);
  await writeFile(to, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultIsAppRunning(appPath: string): boolean {
  // `pgrep -f` matches the full command line; every process of the app runs
  // from inside the bundle (the main binary and the keryx sidecar).
  // This keryx may itself be the bundled sidecar; it does not count.
  const result = spawnSync("pgrep", ["-f", `${appPath}/Contents/MacOS/`], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout
    .split(/\s+/)
    .some((pid) => pid !== "" && Number(pid) !== process.pid);
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultOpenApp(appPath: string): void {
  const child = spawn("open", [appPath], { detached: true, stdio: "ignore" });
  child.unref();
}

function defaultUntar(archive: string, into: string): void {
  const result = spawnSync("tar", ["-xzf", archive, "-C", into], { encoding: "utf8" });
  if (result.status !== 0) throw new AppCommandError(`Unpacking failed: ${result.stderr.trim() || `tar exited ${result.status}`}`);
}

async function defaultRunBuild(script: string, cwd: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForExit(deps: AppCommandDeps, pid: number): Promise<void> {
  const alive = deps.isPidAlive ?? defaultIsPidAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.waitPidTimeoutMs ?? WAIT_PID_TIMEOUT_MS);
  while (alive(pid)) {
    if (Date.now() > deadline) throw new AppCommandError(`Process ${pid} did not exit; the app was not replaced.`);
    await sleep(200);
  }
}

export interface AppStatus {
  readonly appPath: string;
  readonly installedVersion: string | null;
  readonly latest: { readonly version: string; readonly tag: string; readonly url: string | null; readonly prerelease: boolean } | null;
  readonly updateAvailable: boolean;
  readonly keryxVersion: string;
  readonly minDesktopVersion: string;
  /** The installed app is older than this keryx supports. */
  readonly appTooOld: boolean;
  readonly error: string | null;
}

export async function appStatus(deps: AppCommandDeps, flags: Pick<Flags, "pre" | "dir">): Promise<AppStatus> {
  const appPath = path.join(flags.dir ?? "/Applications", APP_NAME);
  const installedVersion = readBundleVersion(appPath) ?? null;
  let latest: DesktopRelease | undefined;
  let error: string | null = null;
  try {
    latest = await fetchLatestRelease(deps, flags.pre);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    appPath,
    installedVersion,
    latest: latest
      ? { version: latest.version, tag: latest.tag, url: latest.htmlUrl ?? null, prerelease: latest.prerelease }
      : null,
    updateAvailable: latest !== undefined && (installedVersion === null || compareVersions(latest.version, installedVersion) > 0),
    keryxVersion: deps.keryxVersion ?? packageJson.version,
    minDesktopVersion: MIN_DESKTOP_VERSION,
    appTooOld: installedVersion !== null && compareVersions(installedVersion, MIN_DESKTOP_VERSION) < 0,
    error,
  };
}

/** Replace `target` with `staged`: old → backup, staged → target, backup removed; restore on failure. */
export async function swapInto(staged: string, target: string): Promise<void> {
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.old-${process.pid}`);
  const hadOld = existsSync(target);
  if (hadOld) await rename(target, backup);
  try {
    await rename(staged, target);
  } catch (error) {
    if (hadOld) await rename(backup, target);
    throw error;
  }
  if (hadOld) await rm(backup, { recursive: true, force: true });
}

async function installRelease(deps: AppCommandDeps, flags: Flags, onlyIfNewer: boolean): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") throw new AppCommandError("The Keryx desktop app is macOS only.");
  const dir = flags.dir ?? "/Applications";
  const target = path.join(dir, APP_NAME);
  const release = await fetchLatestRelease(deps, flags.pre);
  if (!release) throw new AppCommandError(`No ${TAG_PREFIX}* release was found${flags.pre ? "" : " (pre-releases need --pre)"}.`);
  const installed = readBundleVersion(target);
  if (installed && compareVersions(release.version, installed) <= 0 && (onlyIfNewer || !flags.force)) {
    console.log(`Keryx.app ${installed} is up to date (newest release ${release.version}).`);
    return;
  }
  const arch = deps.arch ?? process.arch;
  const asset = pickAsset(release, arch);
  if (!asset) throw new AppCommandError(`Release ${release.tag} has no app archive for ${arch} (looked for ${archLabels(arch).join(", ")}).`);
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) throw new AppCommandError(`Release ${release.tag} has no SHA256SUMS; refusing to install an unverified archive.`);

  const work = await mkdtemp(path.join(tmpdir(), "keryx-app-"));
  let staging: string | undefined;
  try {
    const sumsResponse = await (deps.fetch ?? fetch)(sumsAsset.url, { headers: { "user-agent": "keryx-cli" }, redirect: "follow" });
    if (!sumsResponse.ok) throw new AppCommandError(`Download of SHA256SUMS failed: HTTP ${sumsResponse.status}`);
    const expected = parseChecksums(await sumsResponse.text()).get(asset.name);
    if (!expected) throw new AppCommandError(`SHA256SUMS does not list ${asset.name}.`);

    console.log(`Downloading ${asset.name} …`);
    const archive = path.join(work, asset.name);
    const actual = await download(deps, asset, archive);
    if (actual !== expected) throw new AppCommandError(`Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}.`);

    // Stage next to the target so the final rename never crosses a filesystem.
    staging = path.join(dir, `.${APP_NAME}.staging-${process.pid}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    (deps.untar ?? defaultUntar)(archive, staging);
    const staged = path.join(staging, APP_NAME);
    const entries = await readdir(staging);
    if (!entries.includes(APP_NAME) || !(await stat(staged)).isDirectory()) {
      throw new AppCommandError(`The archive does not hold ${APP_NAME} at its root.`);
    }
    const stagedVersion = readBundleVersion(staged);
    if (stagedVersion !== release.version) {
      throw new AppCommandError(`The archive holds version ${stagedVersion ?? "unknown"}, not ${release.version}.`);
    }

    if (flags.waitPid !== undefined) await waitForExit(deps, flags.waitPid);
    if ((deps.isAppRunning ?? defaultIsAppRunning)(target)) {
      throw new AppCommandError("Keryx.app is running. Quit it first (or use the app's Update button).");
    }
    await swapInto(staged, target);
    console.log(`Installed Keryx.app ${release.version} at ${target}${installed ? ` (was ${installed})` : ""}.`);
  } finally {
    await rm(work, { recursive: true, force: true });
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** The keryx repository checkout holding `cwd`, or undefined. */
export function findKeryxCheckout(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  if (!existsSync(path.join(root, "scripts", "desktop", "build.sh"))) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === packageJson.name ? root : undefined;
  } catch {
    return undefined;
  }
}

async function buildApp(deps: AppCommandDeps): Promise<void> {
  const root = findKeryxCheckout(deps.cwd ?? process.cwd());
  if (!root) {
    throw new AppCommandError(
      "keryx app build works only inside a keryx repository checkout (it runs scripts/desktop/build.sh). Use `keryx app install` for the released app.",
    );
  }
  const code = await (deps.runBuild ?? defaultRunBuild)(path.join(root, "scripts", "desktop", "build.sh"), root);
  if (code !== 0) throw new AppCommandError(`scripts/desktop/build.sh exited ${code}.`);
}

function printStatus(status: AppStatus): void {
  console.log(`Keryx.app: ${status.installedVersion ?? "not installed"} (${status.appPath})`);
  if (status.latest) {
    console.log(`Newest release: ${status.latest.version}${status.latest.prerelease ? " (pre-release)" : ""}`);
  } else {
    console.log(`Newest release: unknown${status.error ? ` (${status.error})` : ""}`);
  }
  console.log(`keryx ${status.keryxVersion} needs Keryx.app ${status.minDesktopVersion} or newer.`);
  if (status.appTooOld) console.log("The installed app is too old for this keryx: run `keryx app update`.");
  else if (status.updateAvailable) console.log(`Update available: run \`keryx app ${status.installedVersion ? "update" : "install"}\`.`);
}

export async function appCommand(args: string[], deps: AppCommandDeps = {}): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(APP_USAGE);
    return;
  }
  let flags: Flags | undefined;
  try {
    flags = parseFlags(rest);
    switch (sub) {
      case "status": {
        const status = await appStatus(deps, flags);
        if (flags.json) console.log(JSON.stringify(status));
        else printStatus(status);
        return;
      }
      case "install":
        await installRelease(deps, flags, false);
        break;
      case "update":
        await installRelease(deps, flags, true);
        break;
      case "build":
        if (rest.length > 0) throw new AppCommandError("keryx app build takes no arguments");
        await buildApp(deps);
        return;
      default:
        console.error(`Unknown subcommand: keryx app ${sub}\n\n${APP_USAGE}`);
        process.exitCode = 1;
        return;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  // Relaunch after install/update, also after a failure: the app quit itself
  // to be replaced, and the user must get an app back either way.
  if (flags?.relaunch) {
    const target = path.join(flags.dir ?? "/Applications", APP_NAME);
    if (existsSync(target)) (deps.openApp ?? defaultOpenApp)(target);
  }
}
