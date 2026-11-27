// Desktop wire contract for the draft a user can explicitly publish from Review.
export type PublicationOptionId = `option:${string}`;
export type PublicationAnswer = "uphold" | "dismiss" | PublicationOptionId;
export type PublicationVerdict = "approve" | "suggestions" | "changes" | "comment";
export const PUBLICATION_REQUEST_LIMIT = 1024 * 1024;

export interface PublicationSettings {
  inline: boolean;
  general: boolean;
  keryxTemplate: boolean;
  overlay: boolean;
  verdict: PublicationVerdict;
  verdictOverride?: PublicationVerdict | null;
  answers: Record<string, PublicationAnswer>;
}

export type PublicationRequest =
  | { kind: "skip"; id: string; settings?: never }
  | { kind: "preview"; id: string; settings?: PublicationSettings; refresh?: boolean }
  | { kind: "save"; id: string; settings: PublicationSettings }
  | { kind: "submit"; id: string; settings: PublicationSettings; digest: string };

export interface PublicationState {
  version: 1;
  settings: PublicationSettings;
  body: string;
  inlineCount: number;
  inlineComments?: { path: string; line: number; body: string }[];
  questions: {
    id: string;
    text: string;
    recommendation?: PublicationAnswer;
    options?: { id: PublicationOptionId; label: string }[];
  }[];
  overlayAvailable: boolean;
  overlayRequiresApproval?: true;
  overlayWarning?: string;
  canSubmit: boolean;
  blockedReason?: string;
  digest: string;
  savedAt?: string;
  publishedUrl?: string;
  skipped?: true;
  /** Present when the pull request moved past the reviewed commit on the same base: this draft is
   * the as-is variant, a Comment for the reviewed commit only. */
  headMoved?: { reviewedHead: string; currentHead: string };
}

export type PublicationOutcome = "pending" | "published" | "skipped";
export const PUBLICATION_RECEIPT = "publication-receipt.json";
/** Desktop's saved publication settings for one attempt (written by desk-publication). */
export const PUBLICATION_DRAFT = "publication-draft.json";

/** The GitHub review event a publication posted; the receipt keeps it so the board can show the verdict. */
export type PublishedEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
export const isPublicationVerdict = (value: unknown): value is PublicationVerdict =>
  value === "approve" || value === "suggestions" || value === "changes" || value === "comment";
const EVENT_VERDICT: Readonly<Record<PublishedEvent, PublicationVerdict>> = { APPROVE: "approve", REQUEST_CHANGES: "changes", COMMENT: "comment" };

/**
 * The verdict a confirmed receipt records: Desktop's own verdict when it posted, else the GitHub event any publisher
 * posted (`keryx review publish` included). Undefined for a receipt written before the event was kept.
 */
export function receiptVerdict(receipt: unknown): PublicationVerdict | undefined {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const record = receipt as Record<string, unknown>;
  if (isPublicationVerdict(record.verdict)) return record.verdict;
  return typeof record.event === "string" && Object.hasOwn(EVENT_VERDICT, record.event)
    ? EVENT_VERDICT[record.event as PublishedEvent] : undefined;
}
export const PUBLICATION_SKIPPED = "publication-skipped.json";
