// `keryx app install|update|build|status` (decision D-15) against a local fake
// GitHub releases server. Never contacts GitHub, never touches /Applications.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIN_DESKTOP_VERSION } from "../acp/profile";
import {
  appCommand,
  type AppCommandDeps,
  archLabels,
  parseChecksums,
  pickAsset,
  readBundleVersion,
  swapInto,
} from "./app";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleName</key>
  <string>Keryx</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>
`;
}

function makeApp(parent: string, version: string): string {
  const app = path.join(parent, "Keryx.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(app, "Contents", "Info.plist"), plist(version));
  writeFileSync(path.join(app, "Contents", "MacOS", "Keryx"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return app;
}

/** `Keryx_<v>_<arch>.app.tar.gz` holding Keryx.app at its root, as the release workflow packs it. */
function makeArchive(version: string, arch: string): { name: string; bytes: Uint8Array<ArrayBuffer> } {
  const work = tempDir("keryx-app-src-");
  makeApp(work, version);
  const name = `Keryx_${version}_${arch}.app.tar.gz`;
  const out = path.join(work, name);
  const result = spawnSync("tar", ["-czf", out, "-C", work, "Keryx.app"]);
  expect(result.status).toBe(0);
  return { name, bytes: new Uint8Array(readFileSync(out)) };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface FakeRelease {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  files: Record<string, Uint8Array<ArrayBuffer> | string>;
}

let server: ReturnType<typeof Bun.serve>;
let releases: FakeRelease[] = [];
let requests: string[] = [];

function base(): string {
  return `http://127.0.0.1:${server.port}`;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (url.pathname === "/repo/releases") {
        return Response.json(
          releases.map((r) => ({
            tag_name: r.tag,
            draft: r.draft ?? false,
            prerelease: r.prerelease ?? false,
            html_url: `${base()}/html/${r.tag}`,
            assets: Object.entries(r.files).map(([name, body]) => ({
              name,
              browser_download_url: `${base()}/download/${r.tag}/${name}`,
              size: typeof body === "string" ? body.length : body.byteLength,
            })),
          })),
        );
      }
      const match = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
      const body = match ? releases.find((r) => r.tag === match[1])?.files[decodeURIComponent(match[2] ?? "")] : undefined;
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    },
  });
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  process.exitCode = 0;
  releases = [];
  requests = [];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A desktop release with a universal archive and a correct SHA256SUMS. */
function desktopRelease(version: string, extra: Partial<FakeRelease> = {}): FakeRelease {
  const archive = makeArchive(version, "universal");
  return {
    tag: `desktop-v${version}`,
    files: {
      [archive.name]: archive.bytes,
      [`Keryx_${version}_universal.dmg`]: "dmg",
      SHA256SUMS: `${sha256(archive.bytes)}  ${archive.name}\n${"0".repeat(64)}  Keryx_${version}_universal.dmg\n`,
    },
    ...extra,
  };
}

function capture(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => out.push(a.map(String).join(" "));
  return { out, restore: () => { console.log = log; console.error = error; } };
}

function deps(over: Partial<AppCommandDeps> = {}): AppCommandDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    releasesApi: `${base()}/repo`,
    platform: "darwin",
    arch: "arm64",
    keryxVersion: "9.9.9",
    isAppRunning: () => false,
    openApp: (p) => opened.push(p),
    opened,
    ...over,
  };
}

async function run(args: string[], d: AppCommandDeps): Promise<{ out: string; code: number }> {
  const c = capture();
  try {
    await appCommand(args, d);
  } finally {
    c.restore();
  }
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = 0;
  return { out: c.out.join("\n"), code };
}

describe("helpers", () => {
  test("arch labels prefer the exact arch, then universal", () => {
    expect(archLabels("arm64")).toEqual(["aarch64", "universal"]);
    expect(archLabels("x64")).toEqual(["x64", "universal"]);
    expect(archLabels("ppc")).toEqual(["universal"]);
    const release = {
      tag: "desktop-v1.0.0",
      version: "1.0.0",
      prerelease: false,
      assets: [
        { name: "Keryx_1.0.0_universal.app.tar.gz", url: "u" },
        { name: "Keryx_1.0.0_aarch64.app.tar.gz", url: "a" },
      ],
    };
    expect(pickAsset(release, "arm64")?.url).toBe("a");
    expect(pickAsset(release, "x64")?.url).toBe("u");
  });

  test("SHA256SUMS parses text and binary-mode lines and skips junk", () => {
    const h = "a".repeat(64);
    const sums = parseChecksums(`${h}  one.tar.gz\n${"B".repeat(64)} *dir/two.dmg\nnot a line\n`);
    expect(sums.get("one.tar.gz")).toBe(h);
    expect(sums.get("two.dmg")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  test("swapInto restores the old app when the new one cannot be moved in", async () => {
    const dir = tempDir("keryx-app-swap-");
    const target = makeApp(dir, "1.0.0");
    await expect(swapInto(path.join(dir, "missing.app"), target)).rejects.toThrow();
    expect(readBundleVersion(target)).toBe("1.0.0");
    expect(readdirSync(dir)).toEqual(["Keryx.app"]);
  });
});

describe("keryx app status", () => {
  test("--json: newest desktop-v* release, ignoring v* tags, drafts and pre-releases", async () => {
    const dir = tempDir("keryx-app-status-");
    makeApp(dir, "0.1.0");
    releases = [
      { tag: "v9.0.0", files: {} },
      desktopRelease("0.3.0", { draft: true }),
      desktopRelease("0.4.0-beta.1", { prerelease: true }),
      desktopRelease("0.2.0"),
      desktopRelease("0.1.0"),
    ];
    const { out, code } = await run(["status", "--json", "--dir", dir], deps());
    expect(code).toBe(0);
    const status = JSON.parse(out);
    expect(status).toMatchObject({
      appPath: path.join(dir, "Keryx.app"),
      installedVersion: "0.1.0",
      latest: { version: "0.2.0", tag: "desktop-v0.2.0", prerelease: false },
      updateAvailable: true,
      keryxVersion: "9.9.9",
      minDesktopVersion: MIN_DESKTOP_VERSION,
      appTooOld: false,
      error: null,
    });

    const pre = JSON.parse((await run(["status", "--json", "--pre", "--dir", dir], deps())).out);
    expect(pre.latest.version).toBe("0.4.0-beta.1");
  });

  test("an unreachable release server is reported, not thrown", async () => {
    const dir = tempDir("keryx-app-status-");
    const { out, code } = await run(["status", "--json", "--dir", dir], deps({ releasesApi: `${base()}/nope` }));
    expect(code).toBe(0);
    const status = JSON.parse(out);
    expect(status.installedVersion).toBeNull();
    expect(status.latest).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("HTTP 404");
  });

  test("an installed app below minDesktopVersion is too old", async () => {
    const dir = tempDir("keryx-app-status-");
    makeApp(dir, "0.0.1");
    releases = [desktopRelease("0.1.0")];
    const status = JSON.parse((await run(["status", "--json", "--dir", dir], deps())).out);
    expect(status.appTooOld).toBe(true);
  });
});

describe("keryx app install / update", () => {
  test("install downloads, verifies and installs the newest release", async () => {
    const dir = tempDir("keryx-app-install-");
    releases = [desktopRelease("0.2.0")];
    const d = deps();
    const { out, code } = await run(["install", "--dir", dir], d);
    expect(code).toBe(0);
    expect(out).toContain("Installed Keryx.app 0.2.0");
    expect(readBundleVersion(path.join(dir, "Keryx.app"))).toBe("0.2.0");
    // No staging or backup folder is left behind.
    expect(readdirSync(dir)).toEqual(["Keryx.app"]);
    expect(requests).toContain("/download/desktop-v0.2.0/SHA256SUMS");
    expect(d.opened).toEqual([]);
  });

  test("update replaces an older app and relaunches it", async () => {
    const dir = tempDir("keryx-app-update-");
    makeApp(dir, "0.1.0");
    releases = [desktopRelease("0.2.0")];
    const d = deps();
    const { code } = await run(["update", "--dir", dir, "--relaunch"], d);
    expect(code).toBe(0);
    expect(readBundleVersion(path.join(dir, "Keryx.app"))).toBe("0.2.0");
    expect(d.opened).toEqual([path.join(dir, "Keryx.app")]);
    expect(readdirSync(dir)).toEqual(["Keryx.app"]);
  });

  test("update is a no-op when the installed app is the newest; install --force reinstalls", async () => {
    const dir = tempDir("keryx-app-update-");
    makeApp(dir, "0.2.0");
    releases = [desktopRelease("0.2.0")];
    const noop = await run(["update", "--dir", dir], deps());
    expect(noop.code).toBe(0);
    expect(noop.out).toContain("up to date");
    expect(requests.some((r) => r.startsWith("/download/"))).toBe(false);
    const forced = await run(["install", "--force", "--dir", dir], deps());
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("Installed Keryx.app 0.2.0");
  });

  test("a checksum mismatch installs nothing and keeps the old app", async () => {
    const dir = tempDir("keryx-app-bad-");
    makeApp(dir, "0.1.0");
    const release = desktopRelease("0.2.0");
    release.files.SHA256SUMS = `${"f".repeat(64)}  Keryx_0.2.0_universal.app.tar.gz\n`;
    releases = [release];
    const d = deps();
    const { out, code } = await run(["update", "--dir", dir, "--relaunch"], d);
    expect(code).toBe(1);
    expect(out).toContain("Checksum mismatch");
    expect(readBundleVersion(path.join(dir, "Keryx.app"))).toBe("0.1.0");
    expect(readdirSync(dir)).toEqual(["Keryx.app"]);
    // --relaunch brings the old app back after a failed update.
    expect(d.opened).toEqual([path.join(dir, "Keryx.app")]);
  });

  test("a release without SHA256SUMS, or without an archive for this arch, is refused", async () => {
    const dir = tempDir("keryx-app-refuse-");
    const release = desktopRelease("0.2.0");
    delete release.files.SHA256SUMS;
    releases = [release];
    expect((await run(["install", "--dir", dir], deps())).out).toContain("no SHA256SUMS");
    releases = [{ tag: "desktop-v0.3.0", files: { "Keryx_0.3.0_x64.app.tar.gz": "x" } }];
    expect((await run(["install", "--dir", dir], deps())).out).toContain("no app archive for arm64");
    expect(existsSync(path.join(dir, "Keryx.app"))).toBe(false);
  });

  test("an archive holding another version is refused", async () => {
    const dir = tempDir("keryx-app-mismatch-");
    const wrong = makeArchive("0.1.0", "universal");
    releases = [
      {
        tag: "desktop-v0.2.0",
        files: { "Keryx_0.2.0_universal.app.tar.gz": wrong.bytes, SHA256SUMS: `${sha256(wrong.bytes)}  Keryx_0.2.0_universal.app.tar.gz\n` },
      },
    ];
    const { out, code } = await run(["install", "--dir", dir], deps());
    expect(code).toBe(1);
    expect(out).toContain("holds version 0.1.0, not 0.2.0");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses while the app runs; --wait-pid waits for the app to quit first", async () => {
    const dir = tempDir("keryx-app-running-");
    makeApp(dir, "0.1.0");
    releases = [desktopRelease("0.2.0")];
    const refused = await run(["update", "--dir", dir], deps({ isAppRunning: () => true }));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Keryx.app is running");
    expect(readBundleVersion(path.join(dir, "Keryx.app"))).toBe("0.1.0");

    let polls = 0;
    let running = true;
    const waited = await run(
      ["update", "--dir", dir, "--wait-pid", "4242"],
      deps({
        isPidAlive: (pid) => {
          expect(pid).toBe(4242);
          polls += 1;
          if (polls >= 3) running = false;
          return running;
        },
        isAppRunning: () => running,
        sleep: async () => {},
      }),
    );
    expect(waited.code).toBe(0);
    expect(polls).toBe(3);
    expect(readBundleVersion(path.join(dir, "Keryx.app"))).toBe("0.2.0");
  });

  test("--wait-pid gives up on a process that never exits", async () => {
    const dir = tempDir("keryx-app-stuck-");
    makeApp(dir, "0.1.0");
    releases = [desktopRelease("0.2.0")];
    const { out, code } = await run(
      ["update", "--dir", dir, "--wait-pid", "7"],
      deps({ isPidAlive: () => true, sleep: async () => {}, waitPidTimeoutMs: -1 }),
    );
    expect(code).toBe(1);
    expect(out).toContain("did not exit");
    expect(readBundleVersion(path.join(dir, "Keryx.app"))).toBe("0.1.0");
  });

  test("other platforms and bad flags are refused", async () => {
    expect((await run(["install"], deps({ platform: "linux" }))).out).toContain("macOS only");
    expect((await run(["install", "--wait-pid", "x"], deps())).code).toBe(1);
    expect((await run(["install", "--bogus"], deps())).out).toContain("Unknown argument: --bogus");
    expect((await run(["frobnicate"], deps())).code).toBe(1);
    expect((await run(["--help"], deps())).out).toContain("keryx app install");
  });
});

describe("keryx app build", () => {
  test("refuses outside a keryx checkout", async () => {
    const dir = tempDir("keryx-app-build-");
    let ran = false;
    const { out, code } = await run(["build"], deps({ cwd: dir, runBuild: async () => { ran = true; return 0; } }));
    expect(code).toBe(1);
    expect(out).toContain("only inside a keryx repository checkout");
    expect(ran).toBe(false);
  });

  test("runs scripts/desktop/build.sh from the checkout root and reports its failure", async () => {
    const calls: Array<[string, string]> = [];
    const ok = await run(["build"], deps({ cwd: path.join(REPO_ROOT, "src"), runBuild: async (s, c) => { calls.push([s, c]); return 0; } }));
    expect(ok.code).toBe(0);
    expect(calls).toEqual([[path.join(REPO_ROOT, "scripts", "desktop", "build.sh"), REPO_ROOT]]);
    const failed = await run(["build"], deps({ cwd: REPO_ROOT, runBuild: async () => 3 }));
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("exited 3");
  });
});
