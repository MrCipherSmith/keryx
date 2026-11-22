import { ChannelsClient, type ChannelsClientOptions } from "./channels-client";
import { readEndpoint } from "./endpoint";
import { desktopServePortAvailable } from "../lib/desktop-serve-bootstrap";
import { isLoopbackAddress, loadServeConfig, serveConfigState } from "../lib/serve-config";
import { readServeCredential } from "../lib/serve-credential";

export interface DesktopServeStatus { state: "not_configured" | "stopped" | "running" | "blocked"; reason?: string; pid?: number; activeSessions?: number }

/** Probe only the configured listener and trust only a signed compatible response. */
export async function desktopServeStatus(
  dir?: string,
  probes: Pick<ChannelsClientOptions, "fetchImpl"> & { portAvailable?: typeof desktopServePortAvailable } = {},
): Promise<DesktopServeStatus> {
  const state = serveConfigState(dir);
  if (state === "absent") return { state: "not_configured" };
  const config = loadServeConfig(dir);
  if (config === null || !config.enabled || !isLoopbackAddress(config.bind.address)) return { state: "blocked", reason: "The serve configuration is invalid, disabled, or not loopback." };
  const endpoint = readEndpoint(dir);
  const configuredAddress = config.bind.address.toLowerCase().replace(/^\[|\]$/g, "");
  const endpointAddress = endpoint.ok ? endpoint.value.address.toLowerCase().replace(/^\[|\]$/g, "") : "";
  const sameAddress = configuredAddress === endpointAddress || (configuredAddress === "localhost" && isLoopbackAddress(endpointAddress));
  if (endpoint.ok && sameAddress && endpoint.value.port === config.bind.port) {
    const client = new ChannelsClient({
      dir,
      requestTimeoutMs: 1500,
      ...(probes.fetchImpl === undefined ? {} : { fetchImpl: probes.fetchImpl }),
    });
    const result = await client.status();
    if (result.ok) {
      const confirmed = readEndpoint(dir);
      if (!confirmed.ok || confirmed.value.pid !== endpoint.value.pid || confirmed.value.address !== endpoint.value.address || confirmed.value.port !== endpoint.value.port) {
        return { state: "blocked", reason: "The serve endpoint changed during verification; retry." };
      }
      const value = result.value;
      if (value.capabilities?.desktopTelegram !== 1) return { state: "blocked", reason: "The running serve is incompatible with Desktop Telegram. Update it before connecting." };
      const sessions = value.telegram.sessions;
      return { state: "running", pid: endpoint.value.pid, ...(Number.isSafeInteger(sessions) && sessions >= 0 ? { activeSessions: sessions } : {}) };
    }
  }
  if (!(await (probes.portAvailable ?? desktopServePortAvailable)(config.bind.address, config.bind.port))) return { state: "blocked", reason: "The configured serve port is occupied by an unverified process." };
  const credential = readServeCredential(dir);
  if (credential.status === "unreadable") return { state: "blocked", reason: "The local API credential is unreadable." };
  if (credential.status === "ok" && (config.credentialRef.store !== "auth-json" || config.credentialRef.id !== credential.record.id)) return { state: "blocked", reason: "The local API credential does not match the configuration." };
  return { state: "stopped" };
}
