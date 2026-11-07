import type { ReviewAgentAdapter, ReviewAgentAdapterRequest } from "../../review/agents/types";
import {
  createExternalGeneralAdapter,
  createExternalGeneralBridge,
  type ExternalBridgeAuthorityRequest,
  type ExternalBridgeControllerPort,
  type ExternalBridgeGrantStore,
} from "../../review/agents/external-adapter";
import { startExternalBridgeSocketServer } from "../../review/agents/external-transport";
import { createKeryxExternalGeneralRunner } from "./keryx-general-runner";

export interface KeryxExternalGeneralHost {
  readonly adapter: ReviewAgentAdapter;
  readonly limitations: {
    readonly toolProfile: "bridge-only";
    readonly sourceRead: false;
    readonly authRefresh: false;
  };
  /** Call only after the controller has cancelled/waited all active dispatches. */
  readonly close: () => Promise<void>;
}

export interface KeryxProviderPreflightEvidence {
  readonly provider: string;
  readonly model: string;
  readonly authenticatedAt: string;
  /** Host refreshed/validated the selected credential before the read-only child starts. */
  readonly hostPreparedCredential: true;
}

/**
 * Production composition for the host/controller circularity. The bridge is
 * built against a lazy controller getter, but sandbox, canonical paths, socket,
 * provider/model selection and worker entry are all preflighted before the
 * adapter is returned. A failed preflight rejects and no adapter is advertised.
 */
export async function createKeryxExternalGeneralHost(options: {
  readonly runId: string;
  readonly runDir: string;
  readonly configDir: string;
  readonly provider: string;
  readonly model: string;
  readonly compileInstructions: (request: ReviewAgentAdapterRequest) => string | Promise<string>;
  readonly preflightProvider: (input: {
    readonly provider: string;
    readonly model: string;
    readonly configDir: string;
  }) => KeryxProviderPreflightEvidence | Promise<KeryxProviderPreflightEvidence>;
  readonly controller: () => ExternalBridgeControllerPort | undefined;
  readonly authorize: (request: ExternalBridgeAuthorityRequest) => boolean | Promise<boolean>;
  readonly grantTtlMs: number;
  /** Durable digest-only grant store; required so reconnect/restart never widens or loses scope. */
  readonly grantStore: ExternalBridgeGrantStore;
  readonly adapterId?: string;
}): Promise<KeryxExternalGeneralHost> {
  const preflight = await options.preflightProvider({
    provider: options.provider,
    model: options.model,
    configDir: options.configDir,
  });
  if (preflight.provider !== options.provider || preflight.model !== options.model ||
    preflight.hostPreparedCredential !== true || !Number.isFinite(Date.parse(preflight.authenticatedAt))) {
    throw new Error("external Keryx provider preflight did not return valid host-owned authentication evidence");
  }
  const controller = (): ExternalBridgeControllerPort => {
    const current = options.controller();
    if (current === undefined) throw new Error("Review agents controller is not bound to the external bridge");
    return current;
  };
  const controllerPort: ExternalBridgeControllerPort = {
    spawn: (parent, input) => controller().spawn(parent, input),
    isDescendant: (parent, dispatch) => controller().isDescendant(parent, dispatch),
    isTerminal: (dispatch) => controller().isTerminal(dispatch),
    status: (dispatch) => controller().status(dispatch),
    wait: (dispatch) => controller().wait(dispatch),
    result: (dispatch) => controller().result(dispatch),
    cancel: (dispatch, reason) => controller().cancel(dispatch, reason),
  };
  const bridge = createExternalGeneralBridge({
    runId: options.runId,
    controller: controllerPort,
    authorize: options.authorize,
    grantStore: options.grantStore,
  });
  const server = await startExternalBridgeSocketServer({ bridge, runDir: options.runDir });
  try {
    const runner = await createKeryxExternalGeneralRunner({
      runDir: options.runDir,
      configDir: options.configDir,
      bridgeServer: server,
      provider: options.provider,
      model: options.model,
      compileInstructions: options.compileInstructions,
    });
    const adapter = createExternalGeneralAdapter({
      id: options.adapterId ?? "keryx-external-general",
      bridge,
      runner,
      grantTtlMs: options.grantTtlMs,
    });
    return {
      adapter,
      limitations: { toolProfile: "bridge-only", sourceRead: false, authRefresh: false },
      close: server.close,
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
