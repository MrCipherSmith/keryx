import { createWorkHttp, validateWorkRepositories, type WorkRepositoryConfig } from "./work/http";
import {remoteBudgets,remoteBudgetsFromEnv} from './remote-v2/budgets';
import { createRemoteControl, type RemoteSocketData } from "./remote-v2";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { HubApplication, HubConfig, Principal } from "./contracts";
import { createAccessVerifier, readAccessRoles, validateAccessConfig, type AccessDependencies, type CloudflareAccessConfig, type VerifiedAccessIdentity } from "./cloudflare-access";
import { completeGitDelivery, prepareGitDelivery, fail, HubFailure, hubMutate, hubRead, object, sha256, text } from "./domain";
import { deliverRevision } from "./git-delivery";
import { openHubStore } from "./store";
import { webAssets } from "./web";
import { authorizeAgentRequest, resolveNamedAgent, validateAgentCredentialsConfiguration } from "./agent-credentials";
export type HubServerConfig = HubConfig & { workManagement?: { enabled: boolean; repositories?:WorkRepositoryConfig[]; observerFetch?:(request:Request)=>Promise<Response> }; publicOrigin?: string; cloudflareAccess?: CloudflareAccessConfig; accessDependencies?: AccessDependencies; observeRemoteTransport?:(observation:import("./remote-v2").RemoteTransportObservation)=>void; remoteBudgets?:Partial<import('./remote-v2/budgets').RemoteBudgets> };
const MAX_BODY = 32 * 1024 * 1024;
function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers); h.set("Content-Type", "application/json; charset=utf-8"); h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff"); return new Response(JSON.stringify(value), { status, headers: h });
}
function sameToken(a: string, b: string) { return timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex")); }
function principalForToken(token: string, config: HubConfig): Principal | undefined {
  if (sameToken(token, config.operatorToken)) return { id: "human:operator", kind: "human", role: "operator" };
  if (config.reviewerToken && sameToken(token, config.reviewerToken)) return { id: "human:reviewer", kind: "human", role: "reviewer" };
  const named = resolveNamedAgent(token, config);
  if (named) return named;
  if (sameToken(token, config.agentToken)) return { id: "agent:connector", kind: "agent", role: "agent" };
}
function credentialFor(actor: Principal, config: HubConfig): string { return actor.role === "operator" ? config.operatorToken : actor.role === "reviewer" ? config.reviewerToken ?? "" : config.agentToken; }
async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail(400, "json-required", "Expected application/json");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY) fail(413, "quota-exceeded", "Request exceeds quota");
  if (!request.body) fail(400, "invalid-json", "JSON body required");
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); fail(413, "quota-exceeded", "Request exceeds quota"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; } catch { fail(400, "invalid-json", "Invalid JSON body"); }
}
function validateConfig(config: HubServerConfig) {
  remoteBudgets(config.remoteBudgets);
  if(config.workManagement?.repositories!==undefined)validateWorkRepositories(config.workManagement.repositories);
  const tokens = [config.operatorToken, config.agentToken, ...(config.reviewerToken ? [config.reviewerToken] : [])];
  if (tokens.some((t) => typeof t !== "string" || t.length < 32) || new Set(tokens).size !== tokens.length) throw new Error("Hub requires distinct bootstrap tokens of at least 32 characters");
  if (!config.dataDir) throw new Error("Hub dataDir is required");
  validateAgentCredentialsConfiguration(config);
  if (config.publicOrigin && !/^https?:\/\//.test(config.publicOrigin)) throw new Error("Hub public origin must be an HTTP(S) origin");
  if (config.publicOrigin && new URL(config.publicOrigin).origin !== config.publicOrigin) throw new Error("Hub public origin must not include path or trailing slash");
  if (config.cloudflareAccess) {
    validateAccessConfig(config.cloudflareAccess);
    if (!config.publicOrigin?.startsWith("https://")) throw new Error("Cloudflare Access requires an HTTPS public origin");
    readAccessRoles(config.cloudflareAccess.rolesFile);
  }
}
export function createHubApplication(config: HubServerConfig): HubApplication {
  validateConfig(config); const store = openHubStore(config.dataDir,config.remoteBudgets); let closed = false;
  store.deliveries.markInterrupted();
  const access = config.cloudflareAccess ? createAccessVerifier(config.cloudflareAccess, config.accessDependencies) : undefined;
  const now = config.accessDependencies?.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation); queue = result.catch(() => undefined); return result;
  }
  const inFlightDeliveries = new Set<string>();
  const deliverySettlers = new Set<() => void>();
  const cookieName = "keryx_hub_session";
  function sessionKey(request: Request): string | undefined {
    return request.headers.get("cookie")?.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }
  function bearerIdentity(request: Request): Principal {
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const actor = token && principalForToken(token, config); if (!actor) fail(401, "unauthorized", "Invalid credentials");
    return actor;
  }
  function accessPrincipal(identity: VerifiedAccessIdentity): Principal {
    if (!config.cloudflareAccess) fail(401, "unauthorized", "Authentication required");
    let roles;
    try { roles = readAccessRoles(config.cloudflareAccess.rolesFile); }
    catch { fail(503, "access-unavailable", "Cloudflare Access role mapping is unavailable"); }
    const role = roles.get(identity.email);
    if (!role) fail(403, "access-denied", "Your Cloudflare identity is not authorized for Hub");
    return { id: `cloudflare:${sha256(JSON.stringify([identity.issuer, identity.subject]))}`, kind: "human", role, email: identity.email, issuer: identity.issuer, subject: identity.subject };
  }
  async function authenticate(request: Request): Promise<{ actor: Principal; cookie: boolean }> {
    if (request.headers.has("authorization")) return { actor: bearerIdentity(request), cookie: false };
    const key = sessionKey(request); const session = key ? store.session(sha256(key)) : undefined;
    if (!session || session.expiresAt <= now()) fail(401, "unauthorized", "Authentication required");
    if (session.accessIdentity) {
      if (!access) fail(401, "unauthorized", "Authentication required");
      const current = await access.verify(request.headers.get("cf-access-jwt-assertion"));
      if (current.issuer !== session.accessIdentity.issuer || current.subject !== session.accessIdentity.subject || current.email !== session.accessIdentity.email) fail(401, "unauthorized", "Session identity does not match");
      return { actor: accessPrincipal(current), cookie: true };
    }
    if (access && request.headers.has("cf-access-jwt-assertion")) fail(401, "sso-required", "Use Cloudflare Access to establish a Hub session");
    if (session.credentialDigest !== sha256(credentialFor(session.principal, config))) fail(401, "unauthorized", "Authentication required");
    return { actor: session.principal, cookie: true };
  }
  function checkOrigin(request: Request) {
    if (request.headers.get("origin") !== (config.publicOrigin ?? new URL(request.url).origin)) fail(403, "origin-denied", "Mutation origin does not match Hub origin");
  }
  function cookie(value: string, request: Request, maxAge = 43200) {
    const secure = new URL(config.publicOrigin ?? request.url).protocol === "https:" ? "; Secure" : "";
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }
  const remote = createRemoteControl({ store, serialized, checkOrigin,workManagementEnabled:config.workManagement?.enabled===true,...(config.observeRemoteTransport?{observeTransport:config.observeRemoteTransport}:{}),
    transportAllowed(request) { const origin = new URL(config.publicOrigin ?? request.url); return origin.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]", "::1"].includes(origin.hostname); },
    async human(request) { const identity = await authenticate(request); if (!identity.cookie || identity.actor.kind !== "human") fail(403, "human-session-required", "Current human browser session required"); const key = sessionKey(request); if (!key) fail(401, "unauthorized", "Session required"); return { actor: identity.actor, sessionDigest: sha256(key) }; },
    authorityValid(auth, projectId, readOnly = false) {
      const stored = store.session(auth.sessionDigest);
      if (!stored || stored.expiresAt <= now() || stored.principal.id !== auth.actor.id) return false;
      const inScope = (principal: Principal) => projectId === undefined || !principal.projectIds || principal.projectIds.includes(projectId);
      if (stored.accessIdentity) {
        try { const current = accessPrincipal(stored.accessIdentity); return (current.role === "operator" || (readOnly && current.role === "reviewer")) && inScope(current); }
        catch { return false; }
      }
      return stored.principal.kind === "human" && (stored.principal.role === "operator" || (readOnly && stored.principal.role === "reviewer")) && inScope(stored.principal)
        && stored.credentialDigest === sha256(credentialFor(stored.principal, config));
    },
  });
  const work = createWorkHttp({store, enabled: config.workManagement?.enabled === true, repositories:config.workManagement?.repositories??[], ...(config.workManagement?.observerFetch?{observerFetch:config.workManagement.observerFetch}:{}), protectedValues:(request)=>[config.operatorToken,config.agentToken,config.reviewerToken??"",...(config.workManagement?.repositories??[]).map(r=>r.github?.token??""),request.headers.get("authorization")?.replace(/^Bearer /,"")??"",sessionKey(request)??""], authenticate, checkOrigin, serialized, now});
  async function externalDelivery(request: Request, path: string[], url: URL, body: unknown, key: string, bodyDigest: string): Promise<Response> {
    const prepared = await serialized(async () => {
      const identity = await authenticate(request);
      authorizeAgentRequest(identity.actor, path, request.method);
      const replayKey = sha256(JSON.stringify([identity.actor.id, request.method, url.pathname, key]));
      return store.workTransaction(() => {
        const state = store.load(), replay = state.replays[replayKey];
        if (replay) {
          if (replay.digest !== bodyDigest) fail(409,'idempotency-conflict','Idempotency key was already used for another payload');
          return { response: json(replay.body,replay.status) };
        }
        const id = 'delivery-' + replayKey.slice(0,32), existing = store.deliveries.get(id);
        if (existing) {
          if (existing.actorId !== identity.actor.id || existing.requestDigest !== bodyDigest) fail(409,'idempotency-conflict','Delivery operation payload changed');
          if (existing.status === 'completed') return { response: json(existing.response,existing.httpStatus ?? 200) };
          if (existing.status === 'pending' || existing.status === 'uncertain') {
            if (inFlightDeliveries.has(id)) return { response: json({operationId:id,status:'pending'},202,{'Retry-After':'1'}) };
            existing.status = 'uncertain'; store.deliveries.save(existing);
            return { response: json({error:{code:'delivery-uncertain',message:'Delivery may have affected Git before interruption; inspect the managed branch and recorded operation before starting another'}},409) };
          }
          const revision = state.revisions.find(revision => revision.projectId === existing.projectId && revision.id === existing.revisionId);
          if (!revision) fail(409,'delivery-revision-unavailable','Reserved immutable revision is unavailable');
          return { job: existing, deliveryRequest: { dataDir: config.dataDir, projectId: existing.projectId, operationId: existing.id, revision, remoteUrl: existing.remoteUrl, baseBranch: existing.baseBranch } };
        }
        const deliveryRequest = prepareGitDelivery(state,identity.actor,path[1]!,body,config.dataDir,id);
        const job: import('./delivery-jobs').DeliveryJob = { id, replayKey, actorId: identity.actor.id, projectId: path[1]!, requestDigest: bodyDigest, expectedLineVersion: Number(object(body).expectedLineVersion), revisionId: deliveryRequest.revision.id, remoteUrl: deliveryRequest.remoteUrl, baseBranch: deliveryRequest.baseBranch, status: 'pending' };
        store.deliveries.reserve(job); inFlightDeliveries.add(id);
        return { job, deliveryRequest };
      });
    });
    if ('response' in prepared && prepared.response) return prepared.response;
    if (!prepared.job || !prepared.deliveryRequest) fail(503,'delivery-unavailable','Delivery reservation unavailable');
    const { job, deliveryRequest } = prepared;
    try {
      if (!job.result) {
        try { job.result = await (config.gitDelivery ?? deliverRevision)(deliveryRequest); }
        catch { job.result = {status:'failed',error:'Git delivery failed; inspect managed repository state before retry'}; }
        job.status = 'result';
        store.workTransaction(() => store.deliveries.save(job));
      }
      return await serialized(async () => {
        const identity = await authenticate(request);
        authorizeAgentRequest(identity.actor,path,request.method);
        if (identity.actor.id !== job.actorId) fail(403,'identity-changed','Current delivery authority changed');
        return store.writeTransaction(state => {
          const replay = state.replays[job.replayKey];
          if (replay) return json(replay.body,replay.status);
          let response: unknown, status = 200;
          try { response = completeGitDelivery(state,identity.actor,deliveryRequest,job.result!,job.expectedLineVersion); }
          catch (error) {
            if (!(error instanceof HubFailure)) throw error;
            status = error.status; response = {error:{code:error.code,message:error.message}};
          }
          job.status='completed'; job.response=response; job.httpStatus=status; store.deliveries.save(job);
          state.replays[job.replayKey]={digest:job.requestDigest,body:response,status};
          return json(response,status);
        });
      });
    } finally {
      inFlightDeliveries.delete(job.id);
      if (!inFlightDeliveries.size) { for (const resolve of deliverySettlers) resolve(); deliverySettlers.clear(); }
    }
  }
  async function handle(request: Request): Promise<Response> {
    if (closed) fail(503, "closed", "Hub is closed");
    const url = new URL(request.url);
    const workResponse = await work.handle(request); if (workResponse) return workResponse;
    const remoteResponse = await remote.handle(request); if (remoteResponse) return remoteResponse;
    if (url.pathname === "/mcp") {
      const actor = bearerIdentity(request);
      if (actor.kind !== "agent") fail(403, "agent-required", "MCP requires agent credentials");
      if (request.headers.has("origin")) checkOrigin(request);
      const { handleHubMcp } = await import("./mcp");
      return handleHubMcp(request, { actor, apiFetch: application.fetch });
    }
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });
    if (!url.pathname.startsWith("/hub/v1/")) {
      if (request.method !== "GET") fail(404, "not-found", "Route not found");
      const asset = webAssets[url.pathname]; if (!asset) fail(404, "not-found", "Route not found");
      return new Response(asset.body, { headers: { "Content-Type": asset.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'", "Referrer-Policy": "no-referrer" } });
    }
    let path: string[];
    try { path = url.pathname.slice("/hub/v1/".length).split("/").map(decodeURIComponent); } catch { fail(400, "invalid-path", "Malformed URL path"); }
    if (path.some((v) => !v || v.includes("/") || v.includes("\\"))) fail(404, "not-found", "Route not found");
    if (path.length === 2 && path[0] === "auth" && path[1] === "config" && request.method === "GET") return json({ cloudflareAccessEnabled: !!access });
    if (path.length === 2 && path[0] === "session" && path[1] === "cloudflare" && request.method === "POST") {
      if (request.headers.has("authorization")) { bearerIdentity(request); fail(403, "browser-required", "Bearer authentication cannot establish a Cloudflare browser session"); }
      if (!access) fail(404, "not-found", "Cloudflare Access sign-in is disabled");
      checkOrigin(request);
      const accessIdentity = await access.verify(request.headers.get("cf-access-jwt-assertion"));
      return serialized(async () => {
        const actor = accessPrincipal(accessIdentity);
        const expiresAt = Math.min(accessIdentity.expiresAt, now() + 43200 * 1000);
        if (expiresAt <= now()) fail(401, "access-invalid", "Cloudflare Access identity expired");
        const state = store.load(); const key = randomBytes(32).toString("base64url");
        for (const [key, session] of Object.entries(state.sessions)) if (session.expiresAt <= now()) delete state.sessions[key];
        state.sessions[sha256(key)] = { principal: actor, accessIdentity, expiresAt }; store.save(state);
        return json({ principal: actor }, 200, { "Set-Cookie": cookie(key, request, Math.max(0, Math.floor((expiresAt - now()) / 1000))) });
      });
    }
    if (path.length === 1 && path[0] === "session" && request.method === "POST") {
      const bearer = request.headers.has("authorization") ? bearerIdentity(request) : undefined;
      if (bearer?.kind === "agent") fail(403, "human-required", "Browser sessions require human credentials");
      if (access && request.headers.has("cf-access-jwt-assertion")) fail(403, "local-recovery-only", "Token recovery is available only through the local SSH access path");
      const origin = request.headers.get("origin"); if (origin) checkOrigin(request);
      const body = object(await readJson(request)); const token = text(body.token, "token"); const actor = principalForToken(token, config);
      if (!actor) fail(401, "unauthorized", "Invalid credentials");
      if (bearer && bearer.id !== actor.id) fail(403, "identity-conflict", "Browser credentials do not match the authenticated principal");
      if (actor.kind !== "human") fail(403, "human-required", "Browser sessions require a human token");
      return serialized(async () => {
        const state = store.load(); const key = randomBytes(32).toString("base64url");
        for (const [key, session] of Object.entries(state.sessions)) if (session.expiresAt <= now()) delete state.sessions[key];
        state.sessions[sha256(key)] = { principal: actor, credentialDigest: sha256(token), expiresAt: now() + 43200 * 1000 }; store.save(state);
        return json({ principal: actor }, 200, { "Set-Cookie": cookie(key, request) });
      });
    }
    // Logout is a same-origin revocation, including when its session has expired
    // or its role was removed. It never grants access or recreates a session.
    if (path.length === 1 && path[0] === "session" && request.method === "DELETE" && !request.headers.has("authorization")) {
      checkOrigin(request);
      return serialized(async () => {
        const state = store.load(); const key = sessionKey(request);
        const session = key ? state.sessions[sha256(key)] : undefined;
        if (key) delete state.sessions[sha256(key)]; store.save(state);
        const logoutUrl = session?.accessIdentity && access ? `${config.publicOrigin}/cdn-cgi/access/logout` : undefined;
        return json({ ok: true, ...(logoutUrl ? { logoutUrl } : {}) }, 200, { "Set-Cookie": cookie("", request, 0) });
      });
    }
    const machineResponse = remote.machineRead(request, path, url); if (machineResponse) return machineResponse;
    const identity = await authenticate(request);
    if (request.method !== "GET" && identity.cookie) checkOrigin(request);
    if (path.length === 1 && path[0] === "session") {
      if (request.method === "GET") return json({ principal: identity.actor });
      if (request.method === "DELETE") return serialized(async () => {
        // Bearer authentication does not confer ownership of an unrelated
        // browser cookie that happens to accompany the API request.
        return json({ ok: true });
      });
      fail(405, "method-not-allowed", "Unsupported method");
    }
    authorizeAgentRequest(identity.actor, path, request.method);
    if (request.method === "GET") {
      const state = store.load();
      const projectIds = identity.actor.projectIds;
      if (projectIds !== undefined && path.length === 1 && path[0] === "projects") return json({ projects: state.projects.filter((p) => projectIds.includes(p.id)) });
      return json(hubRead(state, path, url));
    }
    if (request.method !== "POST") fail(405, "method-not-allowed", "Unsupported method");
    const key = request.headers.get("idempotency-key");
    if (!key || key.length > 200 || [...key].some((c) => c.charCodeAt(0) < 32)) fail(400, "idempotency-key-required", "A bounded Idempotency-Key is required");
    const body = await readJson(request);
    // Replay identity is the original payload, not its credential-redacted projection.
    // Only the digest and sanitized body/receipt are persisted.
    const bodyDigest = sha256(JSON.stringify(body));
    const incomingToken = request.headers.get("authorization")?.slice(7);
    if (incomingToken && path[2] === "flows" && path[4] === "evidence" && typeof body === "object" && body !== null && !Array.isArray(body)) {
      const evidenceBody = object(body);
      for (const field of ["command", "output"] as const) {
        const value = evidenceBody[field];
        if (typeof value === "string") evidenceBody[field] = value.replaceAll(incomingToken, "[REDACTED]");
      }
    }
    if (path.length === 3 && path[2] === 'deliveries') return externalDelivery(request,path,url,body,key,bodyDigest);
    return serialized(async () => {
      const currentIdentity = await authenticate(request);
      authorizeAgentRequest(currentIdentity.actor, path, request.method);
      const replayKey = sha256(JSON.stringify([currentIdentity.actor.id, request.method, url.pathname, key]));
      const state = store.load(); const replay = state.replays[replayKey];
      if (replay) { if (replay.digest !== bodyDigest) fail(409, "idempotency-conflict", "Idempotency key was already used for another payload"); return json(replay.body, replay.status); }
      const result = await hubMutate(state, currentIdentity.actor, path, body, config, config.gitDelivery ?? deliverRevision, `delivery-${replayKey.slice(0, 32)}`);
      state.replays[replayKey] = { digest: bodyDigest, body: result, status: 200 }; store.save(state); return json(result);
    });
  }
  const application: HubApplication = {
    async fetch(request: Request) {
      try { return await handle(request); } catch (error) {
        if (error instanceof HubFailure) return json({ error: { code: error.code, message: error.message } }, error.status);
        console.error("Hub request failed", error instanceof Error ? error.name : "UnknownError");
        return json({ error: { code: "internal-error", message: "Hub request failed" } }, 500);
      }
    },
    async upgrade(request, server) { try { return await remote.upgrade(request, server); } catch (error) { if (error instanceof HubFailure) return json({ error: { code: error.code, message: error.message } }, error.status); return json({ error: { code: "internal-error", message: "Hub upgrade failed" } }, 500); } },
    websocket: remote.websocket,
    closeTransports() { remote.close(); },
    transportsClosed() { return remote.transportsClosed(); },
    async settle() { await queue; if (inFlightDeliveries.size) await new Promise<void>(resolve => deliverySettlers.add(resolve)); await queue; },
    close() { if (!closed) { closed = true; work.close(); remote.close(); store.close(); } },
  };
  return application;
}
export function loadHubConfig(env: Record<string, string | undefined> = process.env): HubServerConfig {
  const port = Number(env.KERYX_HUB_PORT ?? "8787"); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid KERYX_HUB_PORT");
  const config: HubServerConfig = { dataDir: resolve(env.KERYX_HUB_DATA_DIR ?? ".keryx-hub"), operatorToken: env.KERYX_HUB_OPERATOR_TOKEN ?? "", agentToken: env.KERYX_HUB_AGENT_TOKEN ?? "", host: env.KERYX_HUB_HOST ?? "127.0.0.1", port, ...(env.KERYX_HUB_REVIEWER_TOKEN ? { reviewerToken: env.KERYX_HUB_REVIEWER_TOKEN } : {}), ...(env.KERYX_HUB_AGENT_CREDENTIALS_FILE !== undefined ? { agentCredentialsFile: env.KERYX_HUB_AGENT_CREDENTIALS_FILE ? resolve(env.KERYX_HUB_AGENT_CREDENTIALS_FILE) : "" } : {}), ...(env.KERYX_HUB_PUBLIC_ORIGIN ? { publicOrigin: env.KERYX_HUB_PUBLIC_ORIGIN } : {}) };
  if (env.KERYX_HUB_WORK_ENABLED !== undefined && !["true", "false"].includes(env.KERYX_HUB_WORK_ENABLED)) throw new Error("Invalid KERYX_HUB_WORK_ENABLED; expected true or false");
  config.workManagement = { enabled: env.KERYX_HUB_WORK_ENABLED === "true" };
  if(env.KERYX_HUB_WORK_REPOSITORIES!==undefined){
    if(Buffer.byteLength(env.KERYX_HUB_WORK_REPOSITORIES)>64*1024)throw new TypeError('Work repository registry exceeds quota');
    let repositories:unknown;try{repositories=JSON.parse(env.KERYX_HUB_WORK_REPOSITORIES);}catch{throw new TypeError('Invalid work repository registry JSON');}
    config.workManagement.repositories=validateWorkRepositories(repositories);
  }
  const budgets=remoteBudgetsFromEnv(env);if(budgets)config.remoteBudgets=budgets;
  if (env.KERYX_HUB_ACCESS_ENABLED !== undefined && env.KERYX_HUB_ACCESS_ENABLED !== "true" && env.KERYX_HUB_ACCESS_ENABLED !== "false") throw new Error("Invalid KERYX_HUB_ACCESS_ENABLED; expected true or false");
  if (env.KERYX_HUB_ACCESS_ENABLED === "true") config.cloudflareAccess = { issuer: env.KERYX_HUB_ACCESS_ISSUER ?? "", audience: env.KERYX_HUB_ACCESS_AUDIENCE ?? "", rolesFile: env.KERYX_HUB_ACCESS_ROLES_FILE ?? "" };
  validateConfig(config); return config;
}
export function startHub(config: HubServerConfig = loadHubConfig()) {
  const app = createHubApplication(config);
  try {
    const server = Bun.serve<RemoteSocketData>({ websocket: app.websocket!, hostname: config.host ?? "127.0.0.1", port: config.port ?? 8787, maxRequestBodySize: MAX_BODY, fetch: (request, server) => new URL(request.url).pathname.endsWith("/socket") && app.upgrade ? app.upgrade(request, server) : app.fetch(request) });
    const stop = server.stop.bind(server);
    let stopCompletion: Promise<void> | undefined;
    server.stop = (...args: Parameters<typeof stop>) => stopCompletion ??= (async () => {
      app.closeTransports?.();
      const nativeStop = stop(...args);
      if (Bun.version === "1.3.14" && args[0] === true) {
        // Bun 1.3.14 can retain a phantom pendingWebSockets counter after its close callback.
        // Complete only after the actual tracked transports are CLOSED and all authority work is drained.
        const quiescent = async () => {
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline) {
            if (server.pendingRequests === 0 && app.transportsClosed?.()) { await app.settle?.(); return; }
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("Hub shutdown could not establish transport and authority quiescence");
        };
        void nativeStop.catch((error: unknown) => console.error("Hub native shutdown failed", error instanceof Error ? error.name : "UnknownError"));
        await Promise.race([nativeStop, quiescent()]);
      } else await nativeStop;
      await app.settle?.(); app.close();
    })();
    return server;
  } catch (error) { app.close(); throw error; }
}
