import type { DeskRevision, DeskRunKey } from "../review/desk-run-types";

export const SESSION_REVIEWS_METHOD = "_keryx/session_reviews";
export const SESSION_REVIEW_REQUEST_METHOD = "_keryx/session_review_request";
export const SESSION_REVIEW_REQUEST_LIMIT = 2000;

export interface SessionReviewSummary {
  id: string;
  sessionId: string;
  prompt?: string;
  key: DeskRunKey;
  revision: DeskRevision;
}
