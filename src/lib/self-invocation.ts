// How keryx re-invokes ITSELF — one rule, shared by every place that does it
// (`keryxSelfCommand` in `src/harness/tool/builtin/metaproject-tools.ts`, and
// `resolveKeryxInvocation` in `src/trigger/schedule.ts`, which the TUI's
// run-now and the printed cron/systemd lines both use).
//
// A `bun build --compile` binary reports its entry module from bun's embedded
// filesystem: `/$bunfs/root/<name>` on POSIX, `<drive>:\~BUN\root\<name>` on
// Windows. That path exists only inside the binary; the executable itself IS
// keryx. Handing it back as a script argument gives `keryx /$bunfs/root/keryx
// trigger run X` — every argument shifted by one (flow 300 review F2).

/** True when `entry` is a compiled binary's embedded entry module, not a real file. */
export function isCompiledBinaryEntry(entry: string): boolean {
  return entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry);
}
