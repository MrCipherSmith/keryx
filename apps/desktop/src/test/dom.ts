import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a DOM for one test file. Call in beforeAll, and import the modules under test
 * dynamically afterwards (DOMPurify and React read the globals at load time).
 */
export function registerDom(): void {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export async function unregisterDom(): Promise<void> {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
}
