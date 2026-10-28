import { loadHubConfig, startHub } from "./server";
if (import.meta.main) {
  try {
    const server = startHub(loadHubConfig());
    console.log(`Keryx Team Hub listening at ${server.url}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.stop(true); });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not start Team Hub");
    process.exitCode = 1;
  }
}
