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
}

export type PublicationOutcome = "pending" | "published" | "skipped";
export const PUBLICATION_RECEIPT = "publication-receipt.json";
export const PUBLICATION_SKIPPED = "publication-skipped.json";
