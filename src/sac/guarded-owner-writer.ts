import { createHash } from "node:crypto";

/** The source-of-truth owned by the guarded writer, never by SAC. */
export type KnowledgeOwner = "wiki" | "memory" | "skill";
export type ReviewerAuthority = "owner" | "editor";

export type OwnerWriteIntent = Readonly<{
  intentRef: string;
  proposalId: string;
  proposalRevision: string;
  workspaceId: string;
  correlationId: string;
  idempotencyKey: string;
  reviewerSubject: string;
  reviewerAuthority: ReviewerAuthority;
  policyRevision: string;
}>;

export type TargetWriteReceipt = Readonly<{
  receiptRef: string;
  targetRef: string;
  completedAt: string;
  binding: OwnerWriteIntent & { owner: KnowledgeOwner; bindingHash: string };
}>;

export type OwnerWriteResult =
  | Readonly<{ ok: true; owner: KnowledgeOwner; receipt: TargetWriteReceipt }>
  | Readonly<{ ok: false; code: string }>;

export type GuardedOwnerWriter = Readonly<{
  owner: KnowledgeOwner;
  write(input: OwnerWriteIntent): Promise<OwnerWriteResult>;
}>;

export type OwnerReceipt = Readonly<{ receiptRef: string; targetRef: string; completedAt: string }>;

/**
 * Creates the one operation that may cross into Wiki, Memory, or Skills.
 * The supplied `persist` belongs to that subsystem: SAC only supplies a
 * verified decision envelope and checks the returned receipt binding.
 */
export function createGuardedOwnerWriter(input: {
  owner: KnowledgeOwner;
  authorize: (intent: OwnerWriteIntent) => Promise<boolean>;
  /**
   * Owner-owned durable lookup. It must consult the owner's transaction/receipt
   * store by intentRef/idempotencyKey before any new mutation is attempted.
   */
  recover?: (intent: OwnerWriteIntent & { owner: KnowledgeOwner }) => Promise<OwnerReceipt | undefined>;
  persist: (intent: OwnerWriteIntent & { owner: KnowledgeOwner }) => Promise<OwnerReceipt | { ok: false; code: string }>;
}): GuardedOwnerWriter {
  return Object.freeze({
    owner: input.owner,
    async write(intent: OwnerWriteIntent): Promise<OwnerWriteResult> {
      if (!await input.authorize(intent)) return { ok: false, code: "owner_write_denied" };
      const boundIntent = { ...intent, owner: input.owner } as const;
      // Recovery is deliberately owned by Wiki/Memory/Skills, rather than a
      // SAC write-result cache. A crash after owner commit is therefore safe:
      // the retry obtains the original owner receipt and never invokes mutate.
      const recovered = await input.recover?.(boundIntent);
      const persisted = recovered ?? await input.persist(boundIntent);
      if ("ok" in persisted && persisted.ok === false) return persisted;
      const receipt = persisted as OwnerReceipt;
      const binding = Object.freeze({ ...intent, owner: input.owner, bindingHash: bindingHash(input.owner, intent) });
      return Object.freeze({ ok: true, owner: input.owner, receipt: Object.freeze({ ...receipt, binding }) });
    },
  });
}

/** Rejects a substituted receipt before SAC can append an accepted transition. */
export function receiptMatchesIntent(input: { owner: KnowledgeOwner; receipt: TargetWriteReceipt; intent: OwnerWriteIntent }): boolean {
  const binding = input.receipt.binding;
  return binding.owner === input.owner
    && binding.bindingHash === bindingHash(input.owner, input.intent)
    && binding.intentRef === input.intent.intentRef
    && binding.proposalId === input.intent.proposalId
    && binding.proposalRevision === input.intent.proposalRevision
    && binding.workspaceId === input.intent.workspaceId
    && binding.correlationId === input.intent.correlationId
    && binding.idempotencyKey === input.intent.idempotencyKey
    && binding.reviewerSubject === input.intent.reviewerSubject
    && binding.reviewerAuthority === input.intent.reviewerAuthority
    && binding.policyRevision === input.intent.policyRevision;
}

export function bindingHash(owner: KnowledgeOwner, intent: OwnerWriteIntent): string {
  return createHash("sha256").update(JSON.stringify({ owner, ...intent })).digest("hex");
}
