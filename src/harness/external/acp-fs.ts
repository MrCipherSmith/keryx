// `fs/*` requests a foreign ACP agent makes of keryx, and the refusals for the
// methods keryx does not serve (flow 292, AC4/AC5).
//
// keryx is the client here, so when the agent asks to read or write a file,
// keryx's OWN code does it — and only inside the run's disposable worktree:
//
//   - every path is confined by REAL path (`confineToRoot`, which resolves a
//     not-yet-existing path through its nearest existing ancestor, so a symlinked
//     directory pointing outside cannot smuggle a new file out);
//   - agent credential files and managed flow-state files are refused outright;
//   - a write is refused unless `fs.writeTextFile` was advertised (a `--write`
//     run), and even then it goes through the permission bridge as risk `write`
//     — an unattended run therefore writes nothing;
//   - a write never follows a symlink at the target itself.
//
// `terminal/*` and `elicitation/create` are never advertised in this flow and
// are answered with a named JSON-RPC error. Every request — served or refused —
// lands in the run record.
//
// WHAT THIS DOES NOT CONTROL, stated so nobody reads more into it: an agent that
// writes through its own tools never calls these methods at all. Declining to
// advertise a capability is a request to the agent, not a boundary. The
// disposable worktree is the containment for that (D-08).

import { lstatSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { touchesAgentCredentials } from "../../lib/command-risk";
import { AcpError, JSON_RPC_ERROR_CODES } from "../../acp/jsonrpc";
import { ACP_CLIENT_METHODS } from "../../acp/protocol";
import { confineToRoot } from "../tool/builtin/interactive-tools";
import { isManagedFlowFile } from "../policy/engine";

/** Largest file `fs/read_text_file` returns. A bigger one is refused, never truncated silently. */
export const ACP_MAX_READ_BYTES = 4 * 1024 * 1024;

/** Largest content `fs/write_text_file` accepts. */
export const ACP_MAX_WRITE_BYTES = 4 * 1024 * 1024;

/** One `fs/*`, `terminal/*` or `elicitation/*` request, for the run record. */
export interface AcpFsRequestRecord {
  readonly method: string;
  readonly path?: string;
  readonly outcome: "served" | "refused";
  readonly reason?: string;
  readonly bytes?: number;
}

/** The methods keryx never serves in this flow, each with its sentence. */
export const ACP_REFUSED_CLIENT_METHODS: ReadonlyMap<string, string> = new Map([
  [ACP_CLIENT_METHODS.terminalCreate, "keryx does not advertise the terminal capability; run commands are not served over ACP"],
  [ACP_CLIENT_METHODS.terminalOutput, "keryx does not advertise the terminal capability"],
  [ACP_CLIENT_METHODS.terminalKill, "keryx does not advertise the terminal capability"],
  [ACP_CLIENT_METHODS.terminalRelease, "keryx does not advertise the terminal capability"],
  [ACP_CLIENT_METHODS.terminalWaitForExit, "keryx does not advertise the terminal capability"],
  [ACP_CLIENT_METHODS.elicitationCreate, "keryx does not advertise the elicitation capability"],
]);

/** The named error a refused method is answered with. */
export function refusedMethodError(method: string, reason: string): AcpError {
  return new AcpError(JSON_RPC_ERROR_CODES.methodNotFound, `${method} refused: ${reason}`, { reason });
}

/**
 * Confine an agent-supplied path to the worktree, or throw the named refusal.
 * Returns the real absolute path.
 */
export function confineAcpPath(worktree: string, method: string, requested: unknown): string {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new AcpError(JSON_RPC_ERROR_CODES.invalidParams, `${method} requires a non-empty "path"`);
  }
  const target = confineToRoot(worktree, requested);
  if (target === null) {
    throw new AcpError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `${method} refused: ${requested} resolves outside the disposable worktree`,
      { reason: "outside-worktree" },
    );
  }
  // Judged on the path INSIDE the worktree, so where the worktree itself lives
  // (a temp dir, a home directory) cannot trip or mask the check.
  const inside = path.relative(confineToRoot(worktree, ".") ?? worktree, target);
  if (touchesAgentCredentials(inside)) {
    throw new AcpError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `${method} refused: ${requested} is an agent permission/credential file`,
      { reason: "credentials" },
    );
  }
  if (isManagedFlowFile(inside)) {
    throw new AcpError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `${method} refused: ${requested} is managed flow state, changed only through \`keryx flow\``,
      { reason: "flow-file" },
    );
  }
  return target;
}

/** Serve `fs/read_text_file` from the worktree. `line` is 1-based, as ACP defines it. */
export async function readTextFileInWorktree(
  worktree: string,
  params: { readonly path?: unknown; readonly line?: unknown; readonly limit?: unknown },
): Promise<{ readonly content: string; readonly target: string }> {
  const method = ACP_CLIENT_METHODS.fsReadTextFile;
  const target = confineAcpPath(worktree, method, params.path);
  let size: number;
  try {
    const stats = statSync(target);
    if (!stats.isFile()) {
      throw new AcpError(JSON_RPC_ERROR_CODES.invalidParams, `${method} refused: ${String(params.path)} is not a file`);
    }
    size = stats.size;
  } catch (error) {
    if (error instanceof AcpError) throw error;
    throw new AcpError(JSON_RPC_ERROR_CODES.resourceNotFound, `${method}: ${String(params.path)} does not exist`);
  }
  if (size > ACP_MAX_READ_BYTES) {
    throw new AcpError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `${method} refused: ${String(params.path)} is ${size} bytes, over the ${ACP_MAX_READ_BYTES}-byte ceiling`,
    );
  }
  const text = await readFile(target, "utf8");
  const line = typeof params.line === "number" && params.line >= 1 ? Math.floor(params.line) : undefined;
  const limit = typeof params.limit === "number" && params.limit >= 0 ? Math.floor(params.limit) : undefined;
  if (line === undefined && limit === undefined) return { content: text, target };
  const lines = text.split("\n");
  const start = (line ?? 1) - 1;
  const end = limit === undefined ? lines.length : start + limit;
  return { content: lines.slice(start, end).join("\n"), target };
}

/**
 * Write `content` to a worktree path keryx already confined and the bridge
 * already approved. Refuses a symlink at the target itself — a write through it
 * lands wherever it points.
 */
export async function writeTextFileInWorktree(target: string, content: string, requested: string): Promise<void> {
  const method = ACP_CLIENT_METHODS.fsWriteTextFile;
  if (Buffer.byteLength(content, "utf8") > ACP_MAX_WRITE_BYTES) {
    throw new AcpError(JSON_RPC_ERROR_CODES.invalidParams, `${method} refused: content is over the ${ACP_MAX_WRITE_BYTES}-byte ceiling`);
  }
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new AcpError(JSON_RPC_ERROR_CODES.invalidParams, `${method} refused: ${requested} is a symbolic link`);
    }
  } catch (error) {
    if (error instanceof AcpError) throw error;
    // Absent: a new file, which is fine.
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
