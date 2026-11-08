/** The live shell remains the owner. The Hub holds a bounded, temporary projection. */
export const liveShellLimits = {
  sessions: 32,
  operations: 1024,
  messages: 100,
  messageBytes: 32 * 1024,
  historyBytes: 256 * 1024,
  updateBytes: 512 * 1024,
  titleBytes: 200,
  descriptionBytes: 256,
  commandCount: 40,
  terminalCommandCount: 128,
  candidateCount: 40,
  approvalSummaryBytes: 4096,
  questionOptions: 6,
  questionAnswerBytes: 4096,
  outputBytes: 4096,
  outputCount: 24,
  heartbeatMs: 15_000,
  controlMs: 30_000,
  deliveryMs: 15_000,
} as const;

/** A successful machine poll advertises support before the shell sends context. */
export const liveShellContextHeader = "Keryx-Live-Shell-Context";
export const liveShellStreamHeader = "Keryx-Live-Shell-Stream";
export const liveShellChatHeader = "Keryx-Live-Shell-Chat";

/** Invisible direction/formatting characters and CR can disguise a command in a preview. */
export function canShowExactApproval(preview: string): boolean {
  return !!preview.trim() && !/[\p{Cf}\r]/u.test(preview);
}

export type LiveShellMessage = { role: "user" | "assistant"; text: string };
export type LiveShellDecision = "allow" | "deny";
export type LiveShellQuestion = {
  id: string;
  text: string;
  options: Array<{ label: string; description: string }>;
  canAnswer: boolean;
};
export type LiveShellQuestionAnswer = { option: number } | { text: string };

export function validLiveShellQuestionAnswer(value: unknown): value is LiveShellQuestionAnswer {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  if ("option" in value) {
    return typeof value.option === "number" && Number.isInteger(value.option) &&
      value.option >= 0 && value.option < liveShellLimits.questionOptions;
  }
  return "text" in value && typeof value.text === "string" && !!value.text.trim() &&
    new TextEncoder().encode(value.text).length <= liveShellLimits.questionAnswerBytes;
}
export type LiveShellUsage = {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  activeMs: number;
};
export type LiveShellContext = {
  model?: { currentId: string; candidates: Array<{ id: string; label: string }> };
  commands?: Array<{ name: string; description: string }>;
  terminalCommands?: Array<{ name: string; description: string }>;
  usage?: { turn: LiveShellUsage; session: LiveShellUsage };
  approval?: {
    id: string;
    tool: string;
    summary: string;
    reason: string;
    canAnswer: boolean;
  };
  question?: LiveShellQuestion;
  phase?: "thinking" | "working" | "waiting-input";
};
export type LiveShellCommand =
  | { id: string; kind: "message"; text: string }
  | { id: string; kind: "stop"; turnId: string }
  | { id: string; kind: "invoke"; name: string }
  | { id: string; kind: "select-model"; candidateId: string }
  | { id: string; kind: "answer-question"; questionId: string; answer: LiveShellQuestionAnswer }
  | { id: string; kind: "answer-approval"; approvalId: string; decision: LiveShellDecision };
export type LiveShellUpdate = {
  projectId: string;
  checkoutId: string;
  title: string;
  busy: boolean;
  turnId?: string;
  /** Replacement snapshot for the current turn. Omission clears it. */
  preview?: string;
  messages?: LiveShellMessage[];
  context?: LiveShellContext;
  ack?: { id: string; status: "applied" | "rejected"; output?: string };
};
export type LiveShellReply = { command: LiveShellCommand | null };
export type LiveShellSummary = {
  id: string;
  machineName: string;
  checkoutId: string;
  title: string;
  busy: boolean;
  stopTurnId: string | null;
};
export type LiveShellDelivery = {
  id: string;
  kind: LiveShellCommand["kind"];
  status: "pending" | "applied" | "rejected" | "unconfirmed";
  output?: string;
};
export type LiveShellDetail = {
  shell: LiveShellSummary;
  messages: LiveShellMessage[];
  controllerHeld: boolean;
  delivery: LiveShellDelivery | null;
  context?: LiveShellContext;
  preview?: string;
};
