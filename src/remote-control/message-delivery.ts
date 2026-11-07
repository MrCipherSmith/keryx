/** Sender-only Hub read model for messages that do not yet have native transcript rows. */
export type MessageDelivery = {
  operationId: string;
  submittedAt: string;
  afterCursor: number;
  text: string;
  runId: string | null;
  turnId: string | null;
  status: "hub-accepted" | "machine-started" | "machine-rejected" | "not-delivered" | "unconfirmed" | "queue-removed";
  queued: boolean;
  reason: string | null;
};
export type MessageDeliveries = { deliveries: MessageDelivery[] };
