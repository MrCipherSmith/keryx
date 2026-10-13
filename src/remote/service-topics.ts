// Service topics of the serve-side hub (flow 389).
//
// A SERVICE topic is a forum topic that belongs to keryx itself, not to a shell
// session: the scheduled digest writes into the one named "Digest" when the
// project has no remote session. It must stay out of the session registry: the
// registry's sweep marks records unavailable and deletes orphan topics, and the
// router sends every inbound message in a registry topic to a session. A service
// topic has no session, so it has its own file, `<user-global dir>/remote/
// service-topics.json`, rewritten atomically, owner-only.
//
// One record per topic NAME (case-insensitive). The name -> `message_thread_id`
// binding survives a serve restart, so the digest keeps landing in the same topic.

import path from "node:path";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { nameKey } from "./naming";
import { ensureRemoteDir, SERVICE_TOPICS_FILE } from "./paths";

export interface ServiceTopicRecord {
  name: string;
  chatId: number;
  threadId: number;
}

const VERSION = 1;

function parse(value: unknown): ServiceTopicRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw["name"] !== "string" || typeof raw["chatId"] !== "number" || typeof raw["threadId"] !== "number") return undefined;
  if (!Number.isFinite(raw["chatId"]) || !Number.isFinite(raw["threadId"])) return undefined;
  return { name: raw["name"], chatId: raw["chatId"], threadId: raw["threadId"] };
}

export class ServiceTopics {
  private readonly file: string;
  private readonly byName = new Map<string, ServiceTopicRecord>();

  constructor(options: { dir?: string } = {}) {
    this.file = path.join(ensureRemoteDir(options.dir), SERVICE_TOPICS_FILE);
  }

  /** Read the file. A missing or unreadable one is an empty set (the topic is simply created again). */
  load(): void {
    this.byName.clear();
    const read = readConfigFile(this.file);
    if (!read.ok) return;
    try {
      const records = (JSON.parse(read.text) as { records?: unknown } | null)?.records;
      if (!Array.isArray(records)) return;
      for (const candidate of records) {
        const record = parse(candidate);
        if (record !== undefined) this.byName.set(nameKey(record.name), record);
      }
    } catch {
      // keep it empty
    }
  }

  private save(): void {
    writeOwnerOnlyFileAtomic(this.file, `${JSON.stringify({ version: VERSION, records: [...this.byName.values()] }, null, 2)}\n`);
  }

  get(name: string, chatId: number): ServiceTopicRecord | undefined {
    const record = this.byName.get(nameKey(name));
    return record !== undefined && record.chatId === chatId ? record : undefined;
  }

  put(record: ServiceTopicRecord): void {
    this.byName.set(nameKey(record.name), record);
    this.save();
  }

  /** Forget a topic that Telegram no longer has, so the next send creates it again. */
  remove(name: string): void {
    if (this.byName.delete(nameKey(name))) this.save();
  }

  /** True when a thread belongs to a service topic (the router must not hand it to a session). */
  owns(chatId: number, threadId: number): boolean {
    for (const record of this.byName.values()) {
      if (record.chatId === chatId && record.threadId === threadId) return true;
    }
    return false;
  }

  /** The service topic that owns a thread, if any. */
  byThread(chatId: number, threadId: number): ServiceTopicRecord | undefined {
    for (const record of this.byName.values()) {
      if (record.chatId === chatId && record.threadId === threadId) return record;
    }
    return undefined;
  }

  records(): ServiceTopicRecord[] {
    return [...this.byName.values()];
  }
}
