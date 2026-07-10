import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { CtxRuntime, Settings } from "./runtimes";

// Opt-in, merge-safe installer for the gdctx routing guard across harnesses.
// The per-runtime merge/strip lives in runtimes.ts; this module only owns the
// generic read/write of a JSON settings file and the install/uninstall loop.
// Never clobbers user config: managed entries carry the `ctx-agent-hooks`
// sentinel, so uninstall targets ONLY our entry and re-install is idempotent.

async function readSettings(file: string): Promise<Settings> {
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Settings;
    }
    return {};
  } catch {
    throw new Error(`Cannot parse ${file}: file is not valid JSON`);
  }
}

async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// Install the guard for one runtime; returns { path, errors } ([] errors = ok).
// JSON runtimes go through merge + on-disk validate; runtimes that own a
// non-JSON artifact (OpenCode plugin) delegate to customInstall.
export async function installRuntimeHook(
  projectRoot: string,
  runtime: CtxRuntime,
): Promise<{ path: string; errors: string[] }> {
  const file = runtime.locate(projectRoot);
  if (runtime.customInstall) {
    const errors = await runtime.customInstall(projectRoot);
    return { path: file, errors };
  }
  const merge = runtime.merge;
  const validate = runtime.validate;
  if (!merge || !validate) {
    return { path: file, errors: [`${runtime.id}: no installer defined`] };
  }
  const settings = await readSettings(file);
  await writeSettings(file, merge(settings));
  const errors = validate(await readSettings(file));
  return { path: file, errors };
}

// Remove ONLY the managed guard for one runtime; false if nothing was present.
export async function uninstallRuntimeHook(
  projectRoot: string,
  runtime: CtxRuntime,
): Promise<boolean> {
  if (runtime.customUninstall) {
    return runtime.customUninstall(projectRoot);
  }
  const file = runtime.locate(projectRoot);
  if (!(await pathExists(file))) {
    return false;
  }
  const strip = runtime.strip;
  if (!strip) {
    return false;
  }
  const settings = await readSettings(file);
  await writeSettings(file, strip(settings));
  return true;
}
