# Hub context watch usage and recovery
Version: 0.1.2

Status: implemented and verified in the candidate checkout and packaged client; not a published npm release. Use the verified candidate checkout or packaged client.

## Start and stop

From an explicitly connected checkout, with its agent credential available to the process:

```bash
keryx hub sync --watch
keryx hub sync --watch --interval 30 --token-env KERYX_HUB_TOKEN
```

The source client has the same behavior without the hub prefix:

```bash
bun --no-env-file --config=/dev/null /absolute/path/to/keryx/src/hub/client-main.ts sync --watch --interval 30
```

Keep the process running in a terminal; Ctrl-C stops it. Closing it stops synchronization. No system service, automatic startup or Telegram serve integration is installed. One-shot sync remains available. An interval must be an integer between 5 and 3600 seconds; the default is 15. --interval requires --watch.

## What changes

Only shared canonical context cache and the invoking checkout's managed index routing block are maintained. Existing wiki/OpenSpec source files, application code and Git state are left alone. Explicitly connected clones/worktrees for the same server/project share the cache but retain distinct checkout IDs. There is no implicit enrollment by matching a Git remote or copying a hint file.

Events are bounded JSON lines: updated/unchanged indicate a successful cycle; retrying means cached data may be stale; busy means another process owns the cache transaction. The revision, when present, is the last successfully committed cache cursor. No document content or credential belongs in output.

## Offline and authorization failures

Network failure, timeout, 408, 429 and server errors keep last good context and retry with bounded backoff. Restore connectivity and leave watch running; success resumes incremental synchronization. HTTP 401/403 stop the process: restore or replace the credential in its actual launch environment, verify the intended binding, then restart. Revoking access cannot erase data already downloaded onto a machine.

Malformed remote data, corrupt existing cache and filesystem/index errors stop visibly. Preserve the affected files for diagnosis. A cache commit followed by an index failure is a partial outcome: the emitted revision may already be newer, while the index is unchanged. Do not treat that as a fully successful sync.

## Lock recovery

Ordinary contention is not corruption; let the active transaction finish. A killed process may leave an owned lock. Never delete a lock based only on its age or PID reuse. Stop all sync/watch processes sharing that cache, confirm no transaction remains, retain a copy of the lock ownership metadata and inspect the actual reported cache location before removing only that abandoned lock. The lock is context.json.lock in the reported cache directory, with JSON owner (a random nonce) and pid fields. Release compares ownership metadata; no automatic lock-stealing or recovery command is provided. The executed recovery checks will be recorded in the implementation report.

After diagnosis, a deliberate operator repair may preserve a copy of context.json outside the active cache before removing the corrupt file and running a full one-shot sync. The watcher itself must not silently reset corrupt data. Never remove the entire cache/config tree or checkout binding as a generic recovery step.
