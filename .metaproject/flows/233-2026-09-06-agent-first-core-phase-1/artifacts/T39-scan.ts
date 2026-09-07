// T39 probe C — what an unreadable / mistyped config does on the CLI check path,
// and what §14 self-protection then persists. Read-only; mkdtemp fixtures.
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecurityService } from "../../../../src/security/service";
import { loadSecurityConfig } from "../../../../src/security/config";
import { exitCodeFor } from "../../../../src/commands/security";

const out = (row: Record<string, unknown>) => console.log(JSON.stringify(row));

async function ws(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t39-scan-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  await writeFile(path.join(root, ".metaproject", "security.config.json"), config, "utf8");
  return root;
}

for (const [label, config] of [
  ["C1 config unreadable (null)", "null"],
  ["C2 config advisory", '{"mode":"advisory"}'],
  ["C3 config mode typo ENFORCED", '{"mode":"ENFORCED"}'],
  ["C4 config ci", '{"mode":"ci"}'],
] as const) {
  const root = await ws(config);
  try {
    const cfg = await loadSecurityConfig(root);
    const decision = await createSecurityService(root).check({
      content: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      source: "generated",
      target: "memory",
    });
    let state: unknown = "NO STATE FILE";
    try {
      state = JSON.parse(
        await readFile(path.join(root, ".metaproject", "data", "security", "raw", "state.json"), "utf8"),
      );
    } catch { /* left as NO STATE FILE */ }
    out({
      label,
      loadedMode: cfg.mode,
      configUnreadable: (cfg as { configUnreadable?: boolean }).configUnreadable ?? null,
      gate: decision.gate,
      findings: decision.findings.length,
      cliExitCode: exitCodeFor(decision, root, cfg.mode),
      persistedStateMode: (state as { mode?: unknown })?.mode ?? state,
    });
  } catch (e) {
    out({ label, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
