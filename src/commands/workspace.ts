import { optionValue } from "../lib/args";
import { randomUUID } from "node:crypto";
import { localWorkspaceAuthorizationServer, newWorkspaceId, WorkspaceService, type WorkspaceResource } from "../sac/workspace-service";
import { createLocalFwkReadService, normalizeFwkResult } from "../sac/fwk-service";

function service(): WorkspaceService {
  return new WorkspaceService({
    workspaceRoot: process.cwd(),
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
}

export async function workspaceCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) return printHelp();
  try {
    if (subcommand === "create") {
      rejectUnknownOptions(args.slice(1), new Set(["--title", "--component"]));
      const title = optionValue(args, "--title");
      const component = optionValue(args, "--component");
      if (!title) throw new Error("Usage: keryx workspace create --title <title> [--component <workspace-relative-ref>]");
      const workspace = await service().create({ request: undefined, requestCorrelationId: randomUUID(), id: newWorkspaceId(), title, ...(component ? { component: { kind: "component" as const, uri: component } } : {}) });
      console.log(JSON.stringify(workspace, null, 2)); return;
    }
    if (subcommand === "list") { rejectUnknownOptions(args.slice(1), new Set()); console.log(JSON.stringify(await service().list({ request: undefined, requestCorrelationId: randomUUID() }), null, 2)); return; }
    if (subcommand === "show") {
      rejectUnknownOptions(args.slice(2), new Set());
      const id = args[1]; if (!id) throw new Error("Usage: keryx workspace show <workspace-id>");
      console.log(JSON.stringify(await service().show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: id }), null, 2)); return;
    }
    if (subcommand === "add-resource") {
      rejectUnknownOptions(args.slice(2), new Set(["--kind", "--uri", "--revision"]));
      const workspaceId = args[1]; const kind = optionValue(args, "--kind") as WorkspaceResource["kind"] | undefined; const uri = optionValue(args, "--uri"); const revision = optionValue(args, "--revision");
      if (!workspaceId || !kind || !uri) throw new Error("Usage: keryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]");
      console.log(JSON.stringify(await service().addResource({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, resource: { kind, uri, ...(revision ? { revision } : {}) } }), null, 2)); return;
    }
    if (subcommand === "overview" || subcommand === "read") {
      rejectUnknownOptions(args.slice(2), new Set(["--max-items", "--max-tokens"]));
      const workspaceId = args[1]; if (!workspaceId) throw new Error("Usage: keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N]");
      const maxItems = Number(optionValue(args, "--max-items") ?? "32"); const maxTokens = Number(optionValue(args, "--max-tokens") ?? "4096");
      if (!Number.isInteger(maxItems) || !Number.isInteger(maxTokens) || maxItems < 0 || maxTokens < 0) throw new Error("--max-items and --max-tokens must be non-negative integers");
      const result = await createLocalFwkReadService(process.cwd()).overview({ workspaceId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } });
      console.log(JSON.stringify(normalizeFwkResult(result), null, 2)); return;
    }
    throw new Error(`Unknown workspace command: ${subcommand}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}

function rejectUnknownOptions(args: string[], allowed: Set<string>): void {
  for (const argument of args) {
    if (!argument.startsWith("--")) continue;
    const name = argument.split("=", 1)[0]!;
    if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
  }
}

function printHelp(): void {
  console.log("keryx workspace create --title <title> [--component <workspace-relative-ref>]\nkeryx workspace list\nkeryx workspace show <workspace-id>\nkeryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]\nkeryx workspace overview|read <workspace-id> [--max-items N] [--max-tokens N]");
}
