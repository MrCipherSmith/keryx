import type { AcpClientRequestOutcome } from "./client-requests";
import type { AcpPermissionOption, AcpRequestPermissionResponse } from "./protocol";
import type { PressedApproval } from "../remote/client";
import { ProjectedDecision } from "./telegram-decision";

/** Race projections of the same host-vetted, one-shot permission request. */
export async function raceTelegramApproval(options: {
  desktop: () => Promise<AcpClientRequestOutcome>;
  cancelDesktop: () => void;
  project: (signal: AbortSignal, claim: (answer: PressedApproval) => boolean) => boolean;
  current: (source: "desktop" | "telegram") => boolean;
  turnSignal: AbortSignal;
  choices: readonly AcpPermissionOption[];
  timeoutMs: number;
  now?: () => number;
}): Promise<AcpRequestPermissionResponse | undefined> {
  if (options.turnSignal.aborted) return undefined;
  const projection = new AbortController();
  const isResponse = (value: unknown): value is AcpRequestPermissionResponse => {
    if (typeof value !== "object" || value === null) return false;
    const outcome = (value as { outcome?: unknown }).outcome;
    if (typeof outcome !== "object" || outcome === null) return false;
    const candidate = outcome as { outcome?: unknown; optionId?: unknown };
    return candidate.outcome === "cancelled" || (candidate.outcome === "selected" && options.choices.some((choice) => choice.optionId === candidate.optionId));
  };
  const now = options.now ?? Date.now;
  const decision = new ProjectedDecision<AcpRequestPermissionResponse>({
    deadline: now() + options.timeoutMs,
    now,
    current: options.current,
    validate: isResponse,
    onSettled: (outcome) => {
      if (outcome.kind !== "answered" || outcome.source !== "telegram") {
        projection.abort(outcome.kind === "answered" && outcome.source === "desktop" ? "shell" : "cancelled");
      }
      if (outcome.kind !== "answered" || outcome.source !== "desktop") options.cancelDesktop();
    },
  });
  const abort = (): void => decision.cancel();
  options.turnSignal.addEventListener("abort", abort, { once: true });
  if (options.turnSignal.aborted) {
    decision.cancel();
    options.turnSignal.removeEventListener("abort", abort);
    return undefined;
  }
  const desktop = options.desktop();
  void desktop.then((outcome) => {
    if (outcome.kind !== "result" || !decision.claim("desktop", outcome.result)) decision.cancel();
  }, () => decision.cancel());
  options.project(projection.signal, (answer) => {
    if (!Number.isSafeInteger(answer.fromId) || (answer.fromId ?? 0) <= 0 || (answer.decision !== "allow" && answer.decision !== "deny")) return false;
    const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
    const choice = options.choices.find((item) => item.kind === kind);
    return choice !== undefined && decision.claim("telegram", { outcome: { outcome: "selected", optionId: choice.optionId } });
  });
  const result = await decision.result;
  options.turnSignal.removeEventListener("abort", abort);
  return result.kind === "answered" ? result.value : undefined;
}
