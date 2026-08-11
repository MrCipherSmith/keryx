import { readSearchCredential } from "../../lib/search-config";
import { SandboxedWebTransport } from "../web/sandboxed-web-transport";
import { createSystemWebWorkerRunner } from "../web/web-worker-runner";
import { SearchProviderController } from "./controller";
import { createSearchProviderRegistry } from "./registry";

/** Trusted composition root for the agent search tool; no adapter sees process.env. */
export function createDefaultSearchProviderController(configDir?: string): SearchProviderController {
  const transport = new SandboxedWebTransport({ runner: createSystemWebWorkerRunner() });
  const registry = createSearchProviderRegistry(transport, (providerId) => readSearchCredential(providerId, configDir));
  return new SearchProviderController(registry, configDir);
}
