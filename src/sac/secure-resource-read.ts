import path from "node:path";
import { DEFAULT_CONTAINED_READ_MAX_BYTES } from "../lib/contained-read";
import { readDescriptorChain } from "../lib/descriptor-read";

/**
 * SAC's strict source reader. It preserves the original workspace-relative
 * validation and O_NOFOLLOW descriptor semantics: SAC references are
 * canonicalized before this function and symlink components are refused.
 */
export function readWorkspaceFileNoFollow(workspaceRoot: string, absolutePath: string): Buffer {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  const components = relativePath.split(path.sep);
  if (!relativePath || path.isAbsolute(relativePath) || components.some((component) => !component || component === "." || component === "..")) {
    throw new Error("safe source path is not workspace-relative");
  }
  return readDescriptorChain(workspaceRoot, absolutePath, {
    maxBytes: DEFAULT_CONTAINED_READ_MAX_BYTES,
    requireRegularFile: true,
  });
}
