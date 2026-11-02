const config = JSON.parse(await Bun.stdin.text());
const hub = config.services?.hub;
if (!hub || typeof hub.environment !== "object") throw new Error("Missing Hub trial configuration");
const env = hub.environment;
const authentication = new Set(["KERYX_HUB_OPERATOR_TOKEN", "KERYX_HUB_AGENT_TOKEN", "KERYX_HUB_REVIEWER_TOKEN", "KERYX_HUB_AGENT_CREDENTIALS_FILE"]);
for (const key of Object.keys(env).sort()) {
  if (!key.startsWith("KERYX_HUB_") || authentication.has(key)) continue;
  if (env[key] === undefined || env[key] === null) continue;
  const value = String(env[key]);
  if (/[\r\n]/.test(value)) throw new Error("Multiline Hub trial settings are unsupported");
  console.log("E|" + key + "=" + value);
}
if (String(env.KERYX_HUB_ACCESS_ENABLED) === "true") {
  const file = env.KERYX_HUB_ACCESS_ROLES_FILE;
  const mounts = Array.isArray(hub.volumes) ? hub.volumes : [];
  const mount = mounts.find(v => v.type === "bind" && typeof v.target === "string" && typeof file === "string" && (file === v.target || file.startsWith(v.target + "/")));
  if (!mount || !/^\/[A-Za-z0-9._/-]+$/.test(mount.source) || !/^\/[A-Za-z0-9._/-]+$/.test(mount.target)) throw new Error("Unsupported Access role mount in trial configuration");
  console.log("M|" + mount.source + "|" + mount.target);
}
