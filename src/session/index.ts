// Public surface for per-project interactive sessions.

export {
  keryxDataDir,
  projectKeyFromPath,
  projectSessionsDir,
  resolveProjectRoot,
  sessionDir,
} from "./paths";

export { compactMessages, compactSession, indexOfKeepFrom, type CompactOptions, type CompactResult } from "./compact";

export {
  MAX_REMOTE_INTERVALS,
  REMOTE_MARK,
  SESSION_SCHEMA_VERSION,
  TranscriptUnreadableError,
  UnknownSessionError,
  createSession,
  describeRemote,
  exportSessionMarkdown,
  findSession,
  forkSession,
  isExternalRunSession,
  latestSession,
  listSessions,
  loadArchive,
  loadContext,
  loadTranscript,
  openSession,
  persistCompacted,
  persistHistory,
  recordRemoteOff,
  recordRemoteOn,
  renameSession,
  shortSessionId,
  titleFromPrompt,
  type OpenSessionOptions,
  type PersistMeta,
  type RemoteInterval,
  type SessionHandle,
  type SessionRemote,
  type SessionSummary,
} from "./store";
