import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ResultSubject } from "./model";
import { observeGitSubject, assertGitSubjectAcceptable, parseGitRepositoryConfig, type GitRepositoryConfig } from "./git-observer";

const oid = "a".repeat(40), tree = "b".repeat(40), drift = "c".repeat(40);
const subject: ResultSubject = { id: "subject1", projectId: "p1", createdBy: "agent:one", createdAt: "2026-11-01T00:00:00Z", kind: "subject", attemptId: "a1", report: "Exact result", contentDigest: "d".repeat(64), artifacts: [{ kind: "git", repositoryId: "repo1", commitOid: oid, treeOid: tree, pullRequest: { number: 12, observedHeadOid: oid }, verification: "claimed", observedAt: null }] };
let server: ReturnType<typeof Bun.serve>;
let configs: GitRepositoryConfig[];
let respond: (request: Request) => Response | Promise<Response>;
const requests: { url: string; method: string; authorized: boolean }[] = [];
function provider(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/repos/org/repo") return Response.json({ id: 99, full_name: "org/repo" });
    if (path.includes("/git/commits/")) return Response.json({ sha: oid, tree: { sha: tree } });
    if (path.endsWith("/pulls/12")) return Response.json({ number: 12, base: { repo: { id: 99 } }, head: { sha: oid, repo: { id: 99 } }, state: "open", updated_at: "2026-11-01T00:00:00Z" });
    if (path.endsWith("/actions/runs")) return Response.json({ total_count: 1, workflow_runs: [{ id: 100, run_number: 5, run_attempt: 1, workflow_id: 7, path: ".github/workflows/test.yml", head_sha: oid, repository: { id: 99 }, head_repository: { id: 99 }, event: "push", status: "completed", conclusion: "success", updated_at: "2026-11-01T00:00:00Z" }] });
    return Response.json({}, { status: 404 });
}
beforeEach(() => {
    requests.length = 0; respond = provider;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => { requests.push({ url: request.url, method: request.method, authorized: request.headers.get("authorization") === "Bearer observer-private-token" }); return respond(request); } });
    configs = [{ projectId: "p1", id: "repo1", objectFormat: "sha1", github: { apiOrigin: server.url.origin, owner: "org", repository: "repo", repositoryId: 99, token: "observer-private-token", trustedWorkflows: [{ workflowId: 7, path: ".github/workflows/test.yml", events: ["push"] }], requireCi: true, maxAgeSeconds: 300 } }];
});
afterEach(async () => { await server.stop(true); });
const options = (generation = 1) => ({ id: `observation${generation}`, actorId: "human:one", generation, now: () => Date.parse("2026-11-01T00:00:10Z") });
test("observes configured exact repository, commit, PR and workflow SHA without accepting or leaking credentials", async () => {
    const before = JSON.stringify(subject); const result = await observeGitSubject(subject, configs, options());
    expect(result.artifacts[0]?.availability).toBe("available");
    expect(result.artifacts[0]?.pullRequest?.headOid).toBe(oid);
    expect(result.artifacts[0]?.ci.runs[0]?.trusted).toBe(true);
    expect(() => assertGitSubjectAcceptable("p1", subject, [result], configs, options().now())).not.toThrow();
    expect(JSON.stringify(subject)).toBe(before); expect(JSON.stringify(result)).not.toContain("observer-private-token");
    expect(requests.every(request => request.method === "GET" && request.authorized)).toBe(true);
    expect(requests.find(request => new URL(request.url).pathname.endsWith("/actions/runs"))?.url).toContain(`head_sha=${oid}`);
});
test("wrong repository, commit or tree never becomes available", async () => {
    for (const mismatch of ["repo", "commit", "tree"]) {
        respond = request => { const path = new URL(request.url).pathname; return mismatch === "repo" && path === "/repos/org/repo" ? Response.json({ id: 1000, full_name: "org/repo" }) : path.includes("/git/commits/") ? Response.json({ sha: mismatch === "commit" ? drift : oid, tree: { sha: mismatch === "tree" ? drift : tree } }) : provider(request); };
        const result = await observeGitSubject(subject, configs, options());
        expect(result.artifacts[0]?.availability).toBe("identity-mismatch");
        expect(() => assertGitSubjectAcceptable("p1", subject, [result], configs, options().now())).toThrow();
    }
});
test("changed PR head blocks current PR acceptance and preserves immutable historical commit", async () => {
    respond = request => new URL(request.url).pathname.endsWith("/pulls/12") ? Response.json({ number: 12, base: { repo: { id: 99 } }, head: { sha: drift, repo: { id: 99 } }, state: "open", updated_at: "2026-11-01T00:00:09Z" }) : provider(request);
    const result = await observeGitSubject(subject, configs, options());
    expect(result.artifacts[0]?.pullRequest?.headOid).toBe(drift);
    expect(() => assertGitSubjectAcceptable("p1", subject, [result], configs, options().now())).toThrow();
    const historical = structuredClone(subject); if (historical.artifacts[0]?.kind === "git") historical.artifacts[0].pullRequest = null;
    expect(() => assertGitSubjectAcceptable("p1", historical, [], configs, options().now())).not.toThrow();
});
test("CI success from another SHA, repository or workflow is never trusted", async () => {
    for (const override of [{ head_sha: drift }, { repository: { id: 1000 } }, { head_repository: { id: 1000 } }, { workflow_id: 777 }, { path: ".github/workflows/untrusted.yml" }, { event: "pull_request_target" }]) {
        respond = request => { const response = provider(request); if (!new URL(request.url).pathname.endsWith("/actions/runs")) return response; return response.json().then(value => Response.json({ ...value, workflow_runs: [{ ...value.workflow_runs[0], ...override }] })); };
        const result = await observeGitSubject(subject, configs, options());
        expect(result.artifacts[0]?.ci.runs[0]?.trusted).toBe(false);
        expect(() => assertGitSubjectAcceptable("p1", subject, [result], configs, options().now())).toThrow();
    }
});
test("provider timeout, oversized response and redirect remain unavailable", async () => {
    for (const mode of ["timeout", "large", "redirect"]) {
        respond = async () => { if (mode === "timeout") { await new Promise(resolve => setTimeout(resolve, 50)); return Response.json({}); } if (mode === "large") return new Response("x".repeat(2048)); return Response.redirect("https://not-contacted.invalid", 302); };
        const result = await observeGitSubject(subject, configs, { ...options(), timeoutMs: 10, maxResponseBytes: 1024 });
        expect(result.artifacts[0]?.availability).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain("not-contacted");
    }
});
test("out-of-order observations cannot restore an older head and stale proof expires", async () => {
    const old = await observeGitSubject(subject, configs, options(1));
    const newer = structuredClone(old); newer.id = "newer"; newer.generation = 2; newer.artifacts[0]!.pullRequest!.headOid = drift;
    expect(() => assertGitSubjectAcceptable("p1", subject, [newer, old], configs, options().now())).toThrow();
    expect(() => assertGitSubjectAcceptable("p1", subject, [old], configs, options().now() + 301000)).toThrow();
});
test("provider-reflected credentials never enter persisted observation fields", async () => {
    respond = request => { const response = provider(request); if (!new URL(request.url).pathname.endsWith("/actions/runs")) return response; return response.json().then(value => Response.json({ ...value, workflow_runs: [{ ...value.workflow_runs[0], path: ".github/workflows/observer-private-token.yml" }] })); };
    const result = await observeGitSubject(subject, configs, options());
    expect(JSON.stringify(result)).not.toContain("observer-private-token");
    expect(result.artifacts[0]?.ci.availability).toBe("unavailable");
});
test("closed administrator config rejects unknown fields and unsafe origins before provider calls", () => {
    for (const value of [{ ...configs[0], arbitrary: true }, { ...configs[0], github: { ...configs[0]!.github, apiOrigin: "https://user:pass@api.example" } }, { ...configs[0], github: { ...configs[0]!.github, apiOrigin: "http://not-loopback.invalid" } }, { ...configs[0], github: { ...configs[0]!.github, repository: "../other" } }, { ...configs[0], github: { ...configs[0]!.github, trustedWorkflows: [{ workflowId: 7, path: ".github/workflows/test.yml", events: ["push"], trusted: true }] } }]) expect(() => parseGitRepositoryConfig(value)).toThrow();
    expect(requests).toHaveLength(0);
});
test("official workflow path@ref shape requires an explicit exact trusted ref policy", async () => {
    respond = request => { const response = provider(request); if (!new URL(request.url).pathname.endsWith("/actions/runs")) return response; return response.json().then(value => Response.json({ ...value, workflow_runs: [{ ...value.workflow_runs[0], path: ".github/workflows/test.yml@main" }] })); };
    const withoutRef = await observeGitSubject(subject, configs, options());
    expect(withoutRef.artifacts[0]?.ci.runs[0]?.trusted).toBe(false);
    configs[0]!.github!.trustedWorkflows![0]!.ref = "main";
    const exact = await observeGitSubject(subject, configs, options(2));
    expect(exact.artifacts[0]?.ci.runs[0]?.trusted).toBe(true); expect(exact.artifacts[0]?.ci.runs[0]?.workflowRef).toBe("main");
    configs[0]!.github!.trustedWorkflows![0]!.ref = "other";
    const wrong = await observeGitSubject(subject, configs, options(3));
    expect(wrong.artifacts[0]?.ci.runs[0]?.trusted).toBe(false);
});
test("changed administrator repository or workflow policy invalidates an earlier observation", async () => {
    const observed = await observeGitSubject(subject, configs, options());
    configs[0]!.github!.repositoryId = 888;
    expect(() => assertGitSubjectAcceptable("p1", subject, [observed], configs, options().now())).toThrow();
    configs[0]!.github!.repositoryId = 99;
    configs[0]!.github!.trustedWorkflows![0]!.events = ["pull_request"];
    expect(() => assertGitSubjectAcceptable("p1", subject, [observed], configs, options().now())).toThrow();
});
