import path from "node:path";

/** The gdgraph data directory (holds `storage/` and `artifacts/`): the project's own unless a caller names another. */
export function gdgraphDataDir(projectRoot: string, dataDir?: string): string {
  return dataDir ?? path.join(projectRoot, ".metaproject", "data", "gdgraph");
}

export function gdgraphStorageDir(projectRoot: string, dataDir?: string): string {
  return path.join(gdgraphDataDir(projectRoot, dataDir), "storage");
}

export function gdgraphArtifactsDir(projectRoot: string, dataDir?: string): string {
  return path.join(gdgraphDataDir(projectRoot, dataDir), "artifacts");
}
