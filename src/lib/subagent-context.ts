/** Total bytes of `context_files` the host will inline into one child's task. */
export const SUBAGENT_CONTEXT_FILES_MAX_BYTES = 400_000;
export const SUBAGENT_CONTEXT_FILES_MAX_COUNT = 40;
/** Credential files and VCS internals are never copied into a child prompt. */
export const CONTEXT_FILE_DENYLIST =
  /(^|\/)(\.env[^/]*|\.npmrc|\.netrc|id_[^/]*|[^/]*\.(pem|key|p12|pfx)|\.git(\/.*)?)$/i;
