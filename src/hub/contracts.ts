import type { Server, WebSocketHandler } from "bun";
import type { RemoteSocketData } from "./remote-v2";
/** Team Hub v1 wire contract. IDs are opaque; digests are lowercase SHA256 hex. */
export type Principal = { id: string; kind: "human" | "agent"; role: "operator" | "reviewer" | "agent"; email?: string; issuer?: string; subject?: string; projectIds?: string[]; readOnly?: boolean };
export type HubError = { error: { code: string; message: string } };
export type Receipt = { id: string; actorId: string; createdAt: string };
export type Project = { id: string; name: string; version: number; lineRevisionId: string | null; lineVersion: number; contextRevision: number };
export type HubDocument = { id: string; projectId: string; path: string; kind: "wiki" | "spec"; content: string; contentDigest: string; version: number; approval: "unreviewed" | "accepted"; sourceRevision: string; acceptedBy?: string; acceptedAt?: string };
export type Proposal = { id: string; projectId: string; documentId: string; baseVersion: number; content: string; contentDigest: string; reason: string; sourceRevision?: string; status: "pending" | "accepted" | "rejected"; version: number; createdBy: string; reviewedBy?: string; reviewedAt?: string; receipt?: Receipt };
export type FlowStatus = "initializing" | "ready" | "in-progress" | "implemented" | "completing" | "done";
export type HubFlow = { id: string; projectId: string; title: string; specDocumentId: string; specContentDigest: string; criteria: string[]; status: FlowStatus; version: number; subjectRevisionId: string | null; frozenBy?: string; acceptedBy?: string; acceptedAt?: string; receipt?: Receipt };
export type Evidence = { id: string; projectId: string; flowId: string; subjectRevisionId: string; checkId: string; command: string; exitCode: number; output: string; actorId: string; provenance: "self-reported"; createdAt: string };
export type FileMode = "100644" | "100755";
export type RevisionChange = { path: string; contentBase64?: string; mode?: FileMode; deleted?: true };
export type RevisionFile = { path: string; contentBase64: string; mode: FileMode; contentDigest: string };
export type RevisionPurpose = "snapshot" | "review-bundle";
export type CodeRevision = { id: string; projectId: string; baseRevisionId: string | null; gitBaseSha: string; message: string; files: RevisionFile[]; createdBy: string; createdAt: string; treeDigest: string; purpose?: RevisionPurpose };
/** Metadata-only collection projection; immutable file bytes remain on single-revision reads. */
export type CodeRevisionSummary = Omit<CodeRevision, 'files'> & { fileCount: number };
export type Delivery = { id: string; projectId: string; revisionId: string; remoteUrl: string; baseBranch: string; status: "published" | "conflict" | "failed"; branch?: string; commitSha?: string; treeSha?: string; prUrl?: string; error?: string; receipt: Receipt };
export type HubEvent = { sequence: number; projectId: string; type: string; actorId: string; actorRole?: Principal["role"]; entityId: string; createdAt: string };
export type CreateProjectRequest = { name: string };
export type ImportRequest = { expectedVersion: number; sourceRevision: string; documents: { path: string; kind: "wiki" | "spec"; content: string }[] };
export type ImportResponse = { documents: HubDocument[]; proposals: Proposal[]; project: Project; receipt: Receipt };
export type ContextResponse = { revision: number; fullSnapshot: boolean; manifest: { id: string; path: string; kind: "wiki" | "spec"; version: number; contentDigest: string }[]; documents: HubDocument[]; deletedDocumentIds: string[] };
export type CreateProposalRequest = { documentId: string; baseVersion: number; content: string; reason: string; sourceRevision?: string };
export type ReviewProposalRequest = { decision: "accepted" | "rejected"; expectedVersion: number; contentDigest: string };
export type CreateFlowRequest = { title: string; specDocumentId: string; criteria: string[] };
export type FlowActionRequest = { expectedVersion: number; subjectRevisionId?: string; acknowledgeSelfReportedEvidence?: boolean };
export type CreateEvidenceRequest = { subjectRevisionId: string; checkId: string; command: string; exitCode: number; output: string };
export type CreateRevisionRequest = { baseRevisionId: string | null; gitBaseSha: string; message: string; changes: RevisionChange[]; purpose?: RevisionPurpose };
export type SelectLineRequest = { revisionId: string; expectedVersion: number };
export type CreateDeliveryRequest = { revisionId: string; remoteUrl: string; baseBranch: string; expectedLineVersion: number };
/** Adapter uses only managed Git workspaces; returns an actual remote receipt. */
export type GitDeliveryRequest = { dataDir: string; projectId: string; operationId: string; revision: CodeRevision; remoteUrl: string; baseBranch: string };
export type GitDeliveryResult = { status: "published"; branch: string; commitSha: string; treeSha: string; prUrl?: string } | { status: "conflict" | "failed"; error: string };
export type GitDeliveryAdapter = (request: GitDeliveryRequest) => Promise<GitDeliveryResult>;
export type HubConfig = { dataDir: string; operatorToken: string; agentToken: string; reviewerToken?: string; agentCredentialsFile?: string; host?: string; port?: number; gitDelivery?: GitDeliveryAdapter };
export type HubApplication = { fetch(request: Request): Promise<Response>; upgrade?(request: Request, server: Server<RemoteSocketData>): Promise<Response | undefined>; websocket?: WebSocketHandler<RemoteSocketData>; closeTransports?(): void; transportsClosed?(): boolean; settle?(): Promise<void>; close(): void };
