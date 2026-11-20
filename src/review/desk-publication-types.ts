// Desktop wire contract for the draft a user can explicitly publish from Review.
export type PublicationOptionId = `option:${string}`;
export type PublicationAnswer = "uphold" | "dismiss" | PublicationOptionId;

export interface PublicationSettings {
  inline: boolean;
  general: boolean;
  keryxTemplate: boolean;
  overlay: boolean;
  verdict: "approve" | "suggestions" | "changes" | "comment";
  answers: Record<string, PublicationAnswer>;
}

export type PublicationRequest =
  | { kind: "preview"; id: string; settings?: PublicationSettings }
  | { kind: "save"; id: string; settings: PublicationSettings }
  | { kind: "submit"; id: string; settings: PublicationSettings; digest: string };

export interface PublicationState {
  version: 1;
  settings: PublicationSettings;
  body: string;
  inlineCount: number;
  questions: {
    id: string;
    text: string;
    recommendation?: PublicationAnswer;
    options?: { id: PublicationOptionId; label: string }[];
  }[];
  overlayAvailable: boolean;
  canSubmit: boolean;
  blockedReason?: string;
  digest: string;
  savedAt?: string;
  publishedUrl?: string;
}
