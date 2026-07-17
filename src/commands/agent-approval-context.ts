// Context-aware approval helper for agent shell_exec (flow 041 / MP-6).
//
// `buildApprovalContext(port, command)` produces a SHORT, advisory context string
// shown before the `Run <cmd>? [y/N]` prompt, so the user approves a command with
// metaproject awareness: the blast radius of a file the command touches (via the
// code graph) and the single most relevant memory note (e.g. a known mistake).
//
// It is best-effort and NEVER throws — any port error or absent data yields an
// empty/partial string. It changes NO approval outcome: the default-deny gate
// still requires a typed `y`. The frozen harness policy engine is untouched.

import type { MetaprojectPort } from "../harness/tool/metaproject-port";

/**
 * Extract file-like tokens from a shell command: tokens with a path separator or a
 * `name.ext` shape. Deduped, order-preserving. Leading `./` is normalized off.
 */
export function fileTokens(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^\.\//, "");
    if (token.length === 0) {
      continue;
    }
    const looksLikeFile = token.includes("/") || /[\w-]+\.[A-Za-z0-9]+$/.test(token);
    if (looksLikeFile && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Build a short advisory metaproject context for a proposed command. Returns an
 * empty string when nothing relevant is found or a port call fails.
 */
export async function buildApprovalContext(port: MetaprojectPort, command: string): Promise<string> {
  const lines: string[] = [];

  // Blast radius of the first file token that has graph dependents.
  for (const file of fileTokens(command).slice(0, 3)) {
    try {
      const affected = await port.graphAffected({ target: file });
      if (affected.error === undefined && affected.affected.length > 0) {
        lines.push(`context: ${file} affects ${affected.affected.length} file(s) in the code graph`);
        break;
      }
    } catch {
      // best-effort: ignore and continue
    }
  }

  // The single most relevant memory note for this command.
  try {
    const memory = await port.memorySearch({ query: command, limit: 1 });
    const hit = memory.error === undefined ? memory.hits[0] : undefined;
    if (hit !== undefined) {
      lines.push(`memory: ${hit.title}`);
    }
  } catch {
    // best-effort: ignore
  }

  return lines.join("\n");
}
