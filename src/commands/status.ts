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

// `args` exists so `--help` answers with help. It used to be dropped at the
// dispatch table, so `keryx status --help` ran the report instead of printing
// usage — harmless for a read-only command, and the wrong reflex to teach for
// the ones that are not.
export async function statusCommand(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

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

function printHelp(): void {
  console.log(`keryx status — whether this project has a .metaproject workspace, and which modules are on

Usage:
  keryx status

Reports the workspace root and one enabled/disabled line per module. Use
\`keryx modules\` to toggle a module, and \`keryx init\` to create the workspace.
`);
}
