import { createHash } from "node:crypto";

/** Opaque identifiers form filenames only after hashing. */
export const issueDigest = (key: string): string => createHash("sha256").update(key).digest("hex");
