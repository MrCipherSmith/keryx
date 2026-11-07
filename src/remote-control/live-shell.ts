/** The live shell remains the owner. The Hub holds a bounded, temporary projection. */
export const liveShellLimits = {
  sessions: 32,
  operations: 1024,
  messages: 100,
  messageBytes: 32 * 1024,
  historyBytes: 256 * 1024,
  updateBytes: 512 * 1024,
  titleBytes: 200,
  heartbeatMs: 15_000,
  controlMs: 30_000,
  deliveryMs: 15_000,
} as const;

export type LiveShellMessage = { role: "user" | "assistant"; text: string };
export type LiveShellCommand =
  | { id: string; kind: "message"; text: string }
  | { id: string; kind: "stop"; turnId: string };
export type LiveShellUpdate = {
  projectId: string;
  checkoutId: string;
  title: string;
  busy: boolean;
  turnId?: string;
  messages?: LiveShellMessage[];
  ack?: { id: string; status: "applied" | "rejected" };
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
};
export type LiveShellDetail = {
  shell: LiveShellSummary;
  messages: LiveShellMessage[];
  controllerHeld: boolean;
  delivery: LiveShellDelivery | null;
};
