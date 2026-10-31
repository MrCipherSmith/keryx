import type { RewindEffectInput } from "./rewind";
import type { Control } from "../../remote-control/protocol";
import type { NormalizedUsage } from "../../harness/provider/types";
import type { NativeAnalysisPort, NativeAnalysisReadPort } from "./analysis";

export interface SessionCommandEffect {
  runId: string;
  turnId: string;
  association: Control["FlowAssociation"];
  snapshot: Control["ConfigSnapshot"];
  signal: AbortSignal;
  analysis?: NativeAnalysisPort;
  beforeAction(action: { kind: "model" | "tool"; toolName?: string; signal?: AbortSignal }): Promise<void>;
  rewind?<T>(input: RewindEffectInput, write: () => Promise<T>): Promise<T>;
  /** One owned workspace effect over exactly these paths: an analysis cache output, or a tracked project record (the project config, one local Flow's record). */
  mutate<T>(kind: "analysis-cache" | "project-record", relativePaths: readonly string[], write: () => Promise<T>): Promise<T>;
  policy: {
    profileId: string;
    fingerprint: string;
    allowedTools: readonly string[];
    maxRounds: number;
    maxToolCalls: number;
  };
  progress(text: string): void;
  usage(usage: NormalizedUsage): void;
}

export interface SessionCommandInspection {
  signal: AbortSignal;
  /** Flow-free bounded reads under the current inspection authority. Admitted, consented Jev runs use `SessionCommandEffect.analysis`. */
  analysisRead?: NativeAnalysisReadPort;
  beforeAction(toolName: string): Promise<void>;
}

/** Canonical remote project reads are scoped by the authenticated machine bridge.
 * The optional local-native mode is explicit and may use existing Metaproject loaders. */
export interface SessionProjectReadPort {
  source: "hub-canonical";
  listFlows(): Promise<unknown>;
  readFlow(flowId: string): Promise<unknown>;
  readContext?(documentId?: string): Promise<unknown>;
}
