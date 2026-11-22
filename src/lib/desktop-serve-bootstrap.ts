import { createServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureKeryxConfigDir, keryxConfigDir } from "./config-dir";
import { withFileLock } from "./fs";
import { defaultServeConfig, isLoopbackAddress, loadServeConfig, saveServeConfig, serveConfigState } from "./serve-config";
import { issueServeToken, readServeCredential } from "./serve-credential";

export type DesktopBootstrapResult = { state: "ready" | "needs_setup" | "blocked"; reason?: string };

export async function desktopServePortAvailable(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: address.replace(/^\[|\]$/g, ""), port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** Idempotent, quiet setup; caller must independently supervise the listener. */
export async function bootstrapDesktopServe(options: {
  dir?: string;
  completeSetup?: boolean;
  portAvailable?: (address: string, port: number) => Promise<boolean>;
} = {}): Promise<DesktopBootstrapResult> {
  try {
    ensureKeryxConfigDir(options.dir);
    return await withFileLock(path.join(keryxConfigDir(options.dir), "desktop-serve-bootstrap.lock"), async () => {
      const state = serveConfigState(options.dir);
      if (state !== "absent" && state !== "valid") return { state: "blocked", reason: "The serve configuration is invalid or unreadable. Repair it before starting." };
      const existing = loadServeConfig(options.dir);
      if (existing && (!existing.enabled || !isLoopbackAddress(existing.bind.address))) return { state: "blocked", reason: "The serve configuration is disabled or is not loopback. Update it explicitly before starting." };
      const credential = readServeCredential(options.dir);
      if (credential.status === "unreadable") return { state: "blocked", reason: "The serve credential is unreadable. Repair it before starting." };
      if (existing && credential.status === "ok" && (existing.credentialRef.store !== "auth-json" || existing.credentialRef.id !== credential.record.id)) return { state: "blocked", reason: "The serve credential does not match the configuration." };
      if (existing && credential.status === "absent" && !options.completeSetup) return { state: "needs_setup", reason: "Complete setup to issue a local API credential." };
      const id = existing?.credentialRef.id ?? (credential.status === "ok" ? credential.record.id : randomUUID());
      const config = existing ?? defaultServeConfig(id);
      if (!(await (options.portAvailable ?? desktopServePortAvailable)(config.bind.address, config.bind.port))) return { state: "blocked", reason: "The configured serve port is occupied." };
      if (existing && credential.status === "absent" && existing.credentialRef.store !== "auth-json") return { state: "blocked", reason: "The configured credential store is unsupported." };
      if (credential.status === "absent") {
        const issued = issueServeToken(options.dir, undefined, undefined, id);
        if (!issued.ok) return { state: "blocked", reason: "Could not issue the local API credential." };
      }
      if (!existing && !saveServeConfig(config, options.dir)) return { state: "blocked", reason: "Could not save the serve configuration; retry setup." };
      return { state: "ready" };
    });
  } catch {
    return { state: "blocked", reason: "Could not lock or access the local serve configuration." };
  }
}
