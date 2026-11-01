/** Legacy binary artifacts/receipts remain durable; only invalidation/delta windows expire. */
export const legacyStorageLimits = {
    retainedEvents: 10000, retainedDocumentChanges: 5000, maxCollectionRecords: 100000,
    maxReplayRecords: 100000, maxMetadataBytes: 64 * 1024 * 1024,
    maxBlobBytes: 512 * 1024 * 1024, maxBlobs: 100000,
    maxRevisionPageSize: 50, maxRevisionResponseBytes: 32 * 1024 * 1024,
} as const;
