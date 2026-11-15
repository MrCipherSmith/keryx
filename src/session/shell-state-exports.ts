import { startCockpitBridge, type BridgeOptions } from "./cockpit-bridge";
import { startStateExport, type PublishResult, type StateExporter } from "./state-export";

/** Shell composition root: consumer failures never prevent other consumers refreshing. */
export function startShellStateExports(options: BridgeOptions): StateExporter {
  const env = options.env ?? process.env;
  const exporters = [startCockpitBridge({ ...options, env })];
  if (env.KERYX_STATE_EXPORT_FILE) exporters.push(startStateExport({
    file: env.KERYX_STATE_EXPORT_FILE, getSession: options.getSession,
    intervalMs: options.intervalMs, onError: options.onError,
  }));
  return {
    refresh: async (): Promise<PublishResult> => {
      const results = await Promise.all(exporters.map(e => e.refresh()));
      const errors = results.flatMap(r => r.ok ? [] : [r.error]);
      return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
    },
    stop: async () => { await Promise.all(exporters.map(e => e.stop())); },
  };
}
