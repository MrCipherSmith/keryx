export interface ReviewMessage {
  id: string;
  body: string;
  author: string;
  own: boolean;
  createdAt: string;
  url: string;
}

export interface SubmittedReview extends ReviewMessage {
  state: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  messages: ReviewMessage[];
}

export interface ReviewCheck {
  id: string;
  name: string;
  status: string;
  url: string | null;
}

export interface LinkedFlowContext {
  id: string;
  title: string;
  status: string;
  directory: string;
  checkout: string;
  documents: Record<string, string>;
}

export interface ReviewDetailSnapshot {
  projectContext?: { flows: LinkedFlowContext[]; totalFlows: number };
  version: 1;
  viewer: string;
  repositoryId: string;
  number: number;
  fetchedAt: string;
  headSha: string;
  comments: ReviewMessage[];
  reviews: SubmittedReview[];
  threads: ReviewThread[];
  checks: ReviewCheck[];
  warnings: string[];
}
