import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFile } from "../lib/json";

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
    console.log("Run: keryx init");
    return;
  }

  if (!(await pathExists(manifestPath))) {
    console.log("Metaproject: incomplete");
    console.log("Missing: .metaproject/metaproject.json");
    return;
  }

  let manifest: Manifest;
  try {
    manifest = await readJsonFile<Manifest>(manifestPath);
  } catch (error) {
    console.log("Metaproject: incomplete");
    console.log("Invalid: .metaproject/metaproject.json");
    console.log(error instanceof Error ? error.message : String(error));
    return;
  }
  console.log("Metaproject: ready");
  console.log(`Root: ${manifest.paths?.root ?? ".metaproject"}`);
  console.log("Modules:");

  for (const [name, moduleConfig] of Object.entries(manifest.modules ?? {})) {
    console.log(`  ${name}: ${moduleConfig.enabled ? "enabled" : "disabled"}`);
  }
}
