// Host-status composite for the TUI shell's herdr-core side.
//
// herdr-core types a template's opening task as soon as the program's FIRST status
// report arrives, so `idle` must not be emitted while a provider/model/resume
// picker still owns the screen. Until `markReady()` this composite emits nothing
// (it only remembers the latest status); `markReady()` emits the remembered state
// (normally `idle`); afterwards every status maps straight through. `exit()` clears.

import {
  herdrCoreStateFor,
  type HerdrCoreAttention,
  type HerdrCoreReporter,
} from "./herdr-core-status";
import type { FleetWorkerStatus } from "./worker-fleet";

/** The main agent shares the worker fleet's status vocabulary (`setMainAgent` feeds both). */
export type MainAgentStatus = FleetWorkerStatus;

export interface AgentHostStatus {
  /** Record a main-agent status; emitted only once the composer is ready. */
  status(status: MainAgentStatus, attention?: HerdrCoreAttention): void;
  /** Typed input is accepted and no picker owns the screen: emit the current state. */
  markReady(): void;
  /** Remove the status (shell exit). Safe to call repeatedly and before ready. */
  exit(): void;
}

export function createAgentHostStatus(opts: { herdrCore: HerdrCoreReporter }): AgentHostStatus {
  let ready = false;
  let closed = false;
  let latest: { status: MainAgentStatus; attention?: HerdrCoreAttention } = { status: "queued" };

  const emit = (): void => {
    opts.herdrCore.report(herdrCoreStateFor(latest.status, latest.attention));
  };

  return {
    status(status, attention) {
      latest = attention !== undefined ? { status, attention } : { status };
      if (ready && !closed) emit();
    },
    markReady() {
      if (ready || closed) return;
      ready = true;
      emit();
    },
    exit() {
      closed = true;
      opts.herdrCore.clear();
    },
  };
}
