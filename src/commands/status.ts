import {
  readMetaprojectManifest,
  readMetaprojectState,
} from "../lib/metaproject-state";

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

  // The vocabulary AND the detection live in `lib/metaproject-state` — the same module
  // that decides whether `keryx shell` offers its index tools. Two answers to one question
  // is how a shell came to be handed index tools in a project this report itself called
  // "incomplete": the report read the manifest, the roster only checked the directory.
  const cwd = process.cwd();
  const state = readMetaprojectState(cwd);

  if (state.state === "absent") {
    console.log("Metaproject: not initialized");
    console.log("Run: keryx init");
    return;
  }

  if (state.state === "incomplete") {
    console.log("Metaproject: incomplete");
    console.log(
      state.reason === "missing-manifest"
        ? "Missing: .metaproject/metaproject.json"
        : "Invalid: .metaproject/metaproject.json",
    );
    if (state.reason === "unreadable-manifest") {
      console.log(state.detail);
    }
    return;
  }

  const manifest = readMetaprojectManifest<Manifest>(cwd);
  console.log("Metaproject: ready");
  console.log(`Root: ${manifest?.paths?.root ?? ".metaproject"}`);
  console.log("Modules:");

  for (const [name, moduleConfig] of Object.entries(manifest?.modules ?? {})) {
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
