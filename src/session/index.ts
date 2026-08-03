// Public surface for per-project interactive sessions.

export {
  keryxDataDir,
  projectKeyFromPath,
  projectSessionsDir,
  resolveProjectRoot,
  sessionDir,
} from "./paths";

export { compactMessages, indexOfKeepFrom, type CompactOptions, type CompactResult } from "./compact";

export {
  SESSION_SCHEMA_VERSION,
  TranscriptUnreadableError,
  compactSession,
  createSession,
  exportSessionMarkdown,
  findSession,
  latestSession,
  listSessions,
  loadArchive,
  loadContext,
  loadTranscript,
  openSession,
  persistHistory,
  renameSession,
  shortSessionId,
  titleFromPrompt,
  type OpenSessionOptions,
  type PersistMeta,
  type SessionHandle,
  type SessionSummary,
} from "./store";
