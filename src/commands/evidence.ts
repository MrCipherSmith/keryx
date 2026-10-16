import { loadEvidenceRuntime } from "../evidence/runtime";
import type { PublicEvidenceSearchResult } from "../evidence/projection";
interface CommandRuntime {
  buildConfiguredFiles(signal?: AbortSignal, forceFull?: boolean): Promise<{ code: string }>;
  searchPublic(query: string, send: (result: PublicEvidenceSearchResult) => void): Promise<unknown>;
  status(): { code: string };
  clear(): Promise<{ code: string }>;
  maintenance(): Promise<{ code: string }>;
  close(): void;
}
export interface EvidenceCommandDeps {
  cwd?: string;
  loadRuntime?: (options: { projectRoot: string }) => Promise<
    { ok: true; runtime: CommandRuntime } | { ok: false; diagnostics: string[] }>;
}
const HELP = `keryx evidence index [--full] | search <query> [--json] | status [--json] | clear | maintenance
index: rebuild from configured roots only (mutation; requires approval in agent workflows).
search: explicit bounded read-only retrieval; excerpts are untrusted reference data.
status: metadata only, without excerpts or scanner work.
clear: delete derived artifacts only (mutation), preserve sources and revocation ledger.
maintenance: explicitly purge expired derived data and collect superseded generations (mutation).`;
export async function evidenceCommand(args: string[] = [], deps: EvidenceCommandDeps = {}): Promise<void> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(HELP); return; }
  const [sub, ...rest] = args;
  const valid = sub === "index" ? rest.length === 0 || (rest.length === 1 && rest[0] === "--full") :
    sub === "clear" || sub === "maintenance" ? rest.length === 0 :
    sub === "status" ? rest.length === 0 || (rest.length === 1 && rest[0] === "--json") :
    sub === "search" ? rest.length >= 1 && rest.length <= 2 && !!rest[0]?.trim() &&
      !rest[0]?.startsWith("--") && Buffer.byteLength(rest[0]!) <= 8192 &&
      (rest.length === 1 || rest[1] === "--json") : false;
  if (!valid) { console.error("Invalid evidence arguments. Use keryx evidence --help."); process.exitCode = 1; return; }
  const emit = (result: { code: string }) => {
    // Synchronous serialization is load-bearing: do not retain excerpts for later output.
    console.log(JSON.stringify(result));
    if (!["ok", "no-match", "disabled", "index-absent"].includes(result.code)) process.exitCode = 1;
  };
  let runtime: CommandRuntime | undefined;
  try {
    const loaded = await (deps.loadRuntime ?? loadEvidenceRuntime)({ projectRoot: deps.cwd ?? process.cwd() });
    if (!loaded.ok) { emit({ code: "invalid-config" }); return; }
    runtime = loaded.runtime;
    if (sub === "search") await runtime.searchPublic(rest[0]!, emit);
    else if (sub === "status") emit(runtime.status());
    else if (sub === "index") emit(await runtime.buildConfiguredFiles(undefined, rest[0] === "--full"));
    else if (sub === "maintenance") emit(await runtime.maintenance());
    else emit(await runtime.clear());
  } catch { console.error("Evidence operation failed."); process.exitCode = 1; }
  finally { runtime?.close(); }
}
