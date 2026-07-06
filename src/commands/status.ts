import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

type ManifestModule = {
  enabled: boolean;
};

type Manifest = {
  paths?: {
    root?: string;
  };
  modules?: Record<string, ManifestModule>;
};

export async function statusCommand(): Promise<void> {
  const root = path.join(process.cwd(), ".metaproject");
  const manifestPath = path.join(root, "metaproject.json");

  if (!(await pathExists(root))) {
    console.log("Metaproject: not initialized");
    console.log("Run: gd-metapro init");
    return;
  }

  if (!(await pathExists(manifestPath))) {
    console.log("Metaproject: incomplete");
    console.log("Missing: .metaproject/metaproject.json");
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  console.log("Metaproject: ready");
  console.log(`Root: ${manifest.paths?.root ?? ".metaproject"}`);
  console.log("Modules:");

  for (const [name, moduleConfig] of Object.entries(manifest.modules ?? {})) {
    console.log(`  ${name}: ${moduleConfig.enabled ? "enabled" : "disabled"}`);
  }
}
