import { createApprovalBroker } from "../lib/serve-approvals-broker";
import { answerApproval, reconcileApprovals, resolveApproval, type ApprovalView, type ResolvedState } from "../lib/serve-approvals-store";
import type { ApprovalResponse } from "../commands/agent";
import { createHash } from "node:crypto";
import { redactSensitiveText } from "../security/service";

/** The native engine's opaque canonical action key may contain private tool input.
 * Only its SHA-256 digest crosses the machine protocol. Always hash, even a hex-looking key. */
export function wireApprovalFingerprint(localFingerprint: string): string { return createHash("sha256").update(localFingerprint).digest("hex"); }

function reviewableAction(toolName: string, input: string): string | undefined {
  if (Buffer.byteLength(input, "utf8") > 8192 || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(toolName)) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    let sensitive = false;
    const encoded = JSON.stringify(parsed, (key, value: unknown) => {
      if (/^(?:env|environment|authorization|cookie|password|secret|token|apiKey|api_key|credential)$/i.test(key)) sensitive = true;
      return value;
    }, 2);
    const summary = `${toolName}\n${encoded}`;
    // Never silently clip an action into a blind permission card, or expose a secret
    // in either approval ledger. Large actions can be split into reviewable calls.
    if (sensitive || Buffer.byteLength(summary, "utf8") > 8192 || redactSensitiveText(summary) !== summary) return undefined;
    return summary;
  } catch { return undefined; }
}

export interface SessionApprovalRequest {
  runId: string; turnId: string; policyDigest: string; toolName: string; input: string; fingerprint: string; signal?: AbortSignal;
}
export interface SessionApprovalQuestion extends SessionApprovalRequest { approvalId: string; expiresAt: string; summary: string }
export interface SessionApprovalAnswer {
  approvalId: string; runId: string; turnId: string; actorId: string; policyDigest: string; fingerprint: string; decision: "allow-once" | "deny";
}
export interface SessionApprovalOutcome { approvalId: string; runId: string; turnId: string; decision: "allow-once" | "deny"; application: "applied" | "not-applied" }
export type AppliedApprovalAnswer = { status: "applied" | "rejected" | "not-pending"; reason: string };

/** Adapts the durable native broker; only live waiters can consume an answer after a restart. */
export function createSessionApprovalService(options: { dir: string; sessionId: string; connected(): boolean; deliver(question: SessionApprovalQuestion): void; expirySeconds?: number; onOutcome?: (outcome: SessionApprovalOutcome) => void }) {
  const pending = new Map<string, { request: SessionApprovalRequest; applied: Promise<ResolvedState>; answer?: SessionApprovalAnswer; finish(state: ResolvedState): void }>();
  // Each host supplies a separate owner-only approval root, so reconciliation cannot deny another host's waiters.
  reconcileApprovals(options.dir, { isTurnLive: () => false });
  const broker = createApprovalBroker({ dir: options.dir, expirySeconds: options.expirySeconds ?? 120, maxPending: 32,
    requireConsumer: true, hasConsumer: options.connected, pollMs: 10, summaryMaxBytes: 8192 });
  const service = {
    async request(request: SessionApprovalRequest): Promise<ApprovalResponse> {
      if (!options.connected() || request.signal?.aborted) return { approved: false, fingerprint: request.fingerprint };
      const summary = reviewableAction(request.toolName, request.input);
      if (summary === undefined) return { approved: false, fingerprint: request.fingerprint };
      let approvalId: string | undefined;
      const deny = () => { if (approvalId !== undefined) { resolveApproval(approvalId, { state: "denied", reason: "turn-aborted" }, options.dir); broker.wake(); } };
      request.signal?.addEventListener("abort", deny, { once: true });
      try {
        const outcome = await broker.request({ turnId: request.turnId, sessionId: options.sessionId, toolName: request.toolName,
          risk: "write", callFingerprint: wireApprovalFingerprint(request.fingerprint), actionSummary: summary, floors: ["local-policy", request.policyDigest],
          deliver(view: ApprovalView) {
            approvalId = view.approvalId;
            let finish!: (state: ResolvedState) => void; const applied = new Promise<ResolvedState>((resolve) => { finish = resolve; });
            pending.set(view.approvalId, { request, applied, finish });
            options.deliver({ ...request, input: summary, fingerprint: wireApprovalFingerprint(request.fingerprint), approvalId: view.approvalId, expiresAt: view.expiresAt, summary: view.summary });
            if (request.signal?.aborted) deny();
          },
          resolved(id, state) {
            const entry = pending.get(id); if (entry === undefined) return;
            const decision = entry.answer?.decision ?? "deny";
            const application = state === (decision === "allow-once" ? "allowed" : "denied") ? "applied" : "not-applied";
            // Broker calls this only after its durable resolution, before request() resumes the native tool.
            options.onOutcome?.({ approvalId: id, runId: entry.request.runId, turnId: entry.request.turnId, decision, application });
            pending.delete(id); entry.finish(state);
          },
        });
        return { approved: outcome.approved, fingerprint: request.fingerprint };
      } finally { request.signal?.removeEventListener("abort", deny); }
    },
    async answer(answer: SessionApprovalAnswer): Promise<AppliedApprovalAnswer> {
      const entry = pending.get(answer.approvalId);
      if (entry === undefined) return { status: "not-pending", reason: "no-live-waiter" };
      const request = entry.request;
      if (!options.connected() || request.signal?.aborted || request.runId !== answer.runId || request.turnId !== answer.turnId
        || wireApprovalFingerprint(request.fingerprint) !== answer.fingerprint || request.policyDigest !== answer.policyDigest || answer.actorId.length === 0) return { status: "rejected", reason: "action-mismatch" };
      const recorded = answerApproval(answer.approvalId, answer.decision === "allow-once" ? "allow" : "deny", answer.actorId, options.dir);
      if (recorded.kind !== "applied") return { status: "rejected", reason: "answer-not-recorded" };
      entry.answer = answer;
      broker.wake();
      const resolution = await entry.applied;
      const matched = resolution === (answer.decision === "allow-once" ? "allowed" : "denied");
      return { status: matched ? "applied" : "rejected", reason: matched ? "live-waiter-resolved" : "waiter-not-applied" };
    },
    denyAll(reason: string) {
      for (const id of pending.keys()) resolveApproval(id, { state: "denied", reason }, options.dir);
      broker.wake();
    },
    pending: () => [...pending].map(([approvalId, entry]) => ({ approvalId, runId: entry.request.runId, turnId: entry.request.turnId, fingerprint: wireApprovalFingerprint(entry.request.fingerprint), policyDigest: entry.request.policyDigest })),
  };
  return service;
}
