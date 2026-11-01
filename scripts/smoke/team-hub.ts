/** Real isolated HTTP/process smoke; never contacts an external service.
 * bun scripts/smoke/team-hub.ts [--server /absolute/compiled-server]
 */
import type { CodeRevision, HubFlow, ImportResponse, Project, Proposal } from "../../src/hub/contracts";
import { remotePackageSmoke } from "./team-hub-remote";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--server")) throw new Error("Usage: bun scripts/smoke/team-hub.ts [--server /absolute/compiled-server]");
const directory = await mkdtemp(join(tmpdir(), "team-hub-release-smoke-"));
const operator = randomBytes(32).toString("hex");
const agent = randomBytes(32).toString("hex");
const command = args[1] ? [resolve(args[1])] : [process.execPath, "run", "src/hub/main.ts"];
const child = Bun.spawn(command, { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, KERYX_HUB_DATA_DIR: directory, KERYX_HUB_WORK_ENABLED: "true", KERYX_HUB_PORT: "0", KERYX_HUB_HOST: "127.0.0.1", KERYX_HUB_PUBLIC_ORIGIN: "", KERYX_HUB_REVIEWER_TOKEN: "", KERYX_HUB_OPERATOR_TOKEN: operator, KERYX_HUB_AGENT_TOKEN: agent }, stdout: "pipe", stderr: "inherit" });
const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
try {
  const reader = child.stdout.getReader();
  let startup = "";
  let origin = "";
  while (!origin) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Server exited before announcing its URL");
    startup += new TextDecoder().decode(chunk.value);
    const match = startup.match(/http:\/\/[^\s]+/);
    if (match) origin = new URL(match[0]).origin;
  }
  let cookie = "";
  async function api(path: string, method = "GET", body?: unknown, bearer?: string, key: string = randomUUID()) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10_000), headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(bearer ? { Authorization: "Bearer " + bearer } : cookie ? { Cookie: cookie, Origin: origin } : {}), ...(method === "GET" ? {} : { "Idempotency-Key": key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response;
  }
  async function json<T = unknown>(path: string, method = "GET", body?: unknown, bearer?: string, key?: string): Promise<T> {
    const response = await api(path, method, body, bearer, key);
    if (!response.ok) throw new Error(path + " failed: " + response.status + " " + await response.text());
    return response.json() as Promise<T>;
  }
  for (const route of ["/healthz", "/"]) {
    const response = await api(route); if (!response.ok) throw new Error(route + " failed");
    if (route === "/") {
      const html = await response.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css|svg))"/g)].map(match => match[1]!);
      if (!assets.some(path => path.endsWith(".js")) || !assets.some(path => path.endsWith(".css"))) throw new Error("Frontend module/style assets missing");
      for (const asset of assets) {
        const result = await api(asset);
        const expected = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "image/svg+xml";
        if (!result.ok || !result.headers.get("content-type")?.startsWith(expected)) throw new Error("Frontend asset MIME or status invalid");
      }
      const csp = response.headers.get("content-security-policy") ?? "";
      if (csp.includes("unsafe-inline") || csp.includes("unsafe-eval")) throw new Error("Frontend relaxed CSP");
    }
  }
  const login = await api("/hub/v1/session", "POST", { token: operator });
  if (!login.ok) throw new Error("Human login failed");
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie) throw new Error("Missing session cookie");
  const key = randomUUID();
  const project = await json<Project>("/hub/v1/projects", "POST", { name: "Release smoke" }, undefined, key);
  const replay = await json<Project>("/hub/v1/projects", "POST", { name: "Release smoke" }, undefined, key);
  if (replay.id !== project.id) throw new Error("Idempotency replay duplicated project");
  const base = "/hub/v1/projects/" + project.id;
  const imported = await json<ImportResponse>(base + "/import", "POST", { expectedVersion: project.version, sourceRevision: "release-smoke", documents: [{ path: "openspec/specs/smoke/spec.md", kind: "spec", content: "# Smoke\nHuman approves the exact revision." }] }, agent);
  const spec = imported.documents[0];
  if (!spec) throw new Error("Missing imported specification");
  let flow = await json<HubFlow>(base + "/flows", "POST", { title: "Release smoke", specDocumentId: spec.id, criteria: ["Real HTTP and human-only gates work"] }, agent);
  const flowPath = base + "/flows/" + flow.id;
  if ((await api(flowPath + "/freeze", "POST", { expectedVersion: flow.version }, agent)).status !== 403) throw new Error("Agent bypassed freeze guard");
  flow = await json<HubFlow>(flowPath + "/freeze", "POST", { expectedVersion: flow.version });
  flow = await json<HubFlow>(flowPath + "/start", "POST", { expectedVersion: flow.version }, agent);
  const revision = await json<CodeRevision>(base + "/revisions", "POST", { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Smoke revision", changes: [{ path: "README.md", contentBase64: Buffer.from("Smoke\n").toString("base64"), mode: "100644" }] }, agent);
  await json(flowPath + "/evidence", "POST", { subjectRevisionId: revision.id, checkId: "release-smoke", command: "bun scripts/smoke/team-hub.ts", exitCode: 0, output: "Self-reported fixture for lifecycle smoke only; not an independent test claim." }, agent);
  flow = await json<HubFlow>(flowPath + "/submit-for-review", "POST", { expectedVersion: flow.version, subjectRevisionId: revision.id }, agent);
  if ((await api(flowPath + "/accept", "POST", { expectedVersion: flow.version, subjectRevisionId: revision.id, acknowledgeSelfReportedEvidence: true }, agent)).status !== 403) throw new Error("Agent bypassed acceptance guard");
  flow = await json<HubFlow>(flowPath + "/accept", "POST", { expectedVersion: flow.version, subjectRevisionId: revision.id, acknowledgeSelfReportedEvidence: true });
  if (flow.status !== "done" || !flow.receipt) throw new Error("Human acceptance did not complete Flow");
  const proposal = await json<Proposal>(base + "/proposals", "POST", { documentId: spec.id, baseVersion: spec.version, content: spec.content + "\nReviewed.", reason: "Smoke exact approval" }, agent);
  await json(base + "/proposals/" + proposal.id + "/review", "POST", { decision: "accepted", expectedVersion: proposal.version, contentDigest: proposal.contentDigest });
  await json(base + "/line", "POST", { revisionId: revision.id, expectedVersion: 0 });
  const events = await json<{ events: unknown[] }>(base + "/events");
  if (!events.events.length) throw new Error("Missing audit events");
  const workBase = "/hub/work/v1/projects/" + project.id;
  const capabilities = await json<{enabled:boolean;allowedCommands:string[]}>(workBase + "/capabilities", "GET", undefined, agent);
  if(!capabilities.enabled || !capabilities.allowedCommands.includes("flow.create"))throw new Error("Managed work runtime is unavailable");
  const workOperation = randomUUID();
  const workInput = {operationId:workOperation,expectedVersions:{},command:"flow.create",payload:{title:"Managed release smoke",problem:"Validate packaged runtime",expectedOutcome:"Standalone managed metadata",scope:"Package only",outOfScope:"External execution",ownerId:null,specification:null,criteria:[{criterionId:"packaging",text:"Source package runs without repository dependencies",waivable:false}]}};
  const managed = await json<{operationId:string;receiptId:string;eventCursor:string;entities:{kind:string;id:string}[]}>(workBase + "/commands", "POST", workInput, agent, workOperation);
  const managedFlow = managed.entities.find(entity=>entity.kind==="flow");
  if(!managedFlow || !managed.receiptId || typeof managed.eventCursor!=="string")throw new Error("Packaged managed work mutation failed");
  const managedReplay = await json<typeof managed>(workBase + "/commands", "POST", workInput, agent, workOperation);
  if(JSON.stringify(managedReplay)!==JSON.stringify(managed))throw new Error("Managed work replay changed its committed receipt");
  const {Client} = await import("@modelcontextprotocol/sdk/client/index.js");
  const {StreamableHTTPClientTransport} = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const mcp = new Client({name:"hub-package-smoke",version:"1"});
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", origin),{requestInit:{headers:{Authorization:"Bearer "+agent}}});
  const link:Omit<typeof transport,"sessionId"> = transport;
  try{
    await mcp.connect(link);
    const tools = await mcp.listTools();
    if(!tools.tools.some(tool=>tool.name==="hub_work_get_document_version"))throw new Error("Packaged immutable context MCP read is missing");
    const read = await mcp.callTool({name:"hub_work_get_flow",arguments:{projectId:project.id,flowId:managedFlow.id}});
    const first=Array.isArray(read.content)?read.content[0]:undefined;
    if(read.isError||!first||first.type!=="text")throw new Error("Packaged authenticated work MCP read failed");
    const projection=JSON.parse(String(first.text)) as {records:{id:string}[]};
    if(!projection.records.some(record=>record.id===managedFlow.id))throw new Error("Packaged MCP returned unrelated managed work");
  }finally{await mcp.close();}
  console.log("PASS: managed work metadata and authenticated MCP from the packaged runtime");
  await remotePackageSmoke(origin, cookie, agent, project.id);
  const logout = await api("/hub/v1/session", "DELETE"); if (!logout.ok) throw new Error("Logout failed");
  console.log("PASS: real server process, assets, cookie session, project replay, spec import, protected Flow/evidence/acceptance, exact proposal review, integration selection, events, logout");
  console.log("No external remote, model execution or trusted-CI claim was used.");
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  // Bun 1.3.14 can retain upgraded socket handles after stop; bound cleanup.
  const forced = setTimeout(() => child.kill("SIGKILL"), 2000);
  await child.exited; clearTimeout(forced);
  await rm(directory, { recursive: true, force: true });
}
