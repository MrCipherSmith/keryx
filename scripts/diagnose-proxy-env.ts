import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { agentTaskScratchParent, makeProxySocketDir } from "../src/commands/trigger-agent-task";
const root = await mkdtemp(path.join(tmpdir(), "kx-env-probe-"));
const long = path.join(root, "r".repeat(60), "r".repeat(60), "r".repeat(60));
await mkdir(long, { recursive: true });
const startup = { tmpPresent: process.env.TMPDIR !== undefined, runtimePresent: process.env.XDG_RUNTIME_DIR !== undefined };
process.env.TMPDIR = long;
process.env.XDG_RUNTIME_DIR = long;
const primary = agentTaskScratchParent();
await mkdir(primary, { recursive: true, mode: 0o700 });
async function probe(parent?: string) {
  try { const dir = await makeProxySocketDir(parent); await rm(dir.dir, { recursive: true, force: true }); return { refused: false }; }
  catch (error) { return { refused: true, reason: error instanceof Error ? error.message : String(error) }; }
}
try {
  console.log(JSON.stringify({ platform: process.platform, startup,
    tmpTracksAssignment: tmpdir() === long, tmpBytes: Buffer.byteLength(tmpdir()),
    primaryBytes: Buffer.byteLength(primary), jsTmpBytes: Buffer.byteLength(process.env.TMPDIR),
    primary: await probe(primary), fallback: await probe() }));
} finally { await rm(root, { recursive: true, force: true }); }
