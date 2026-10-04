// Flow 403: the composition root that lets `keryx serve` take work in from GitHub.
//
// The poll, the cards and the decisions live in `src/intake/`; this file connects them to serve the way
// `serve-digest.ts` connects the digest: the project roots to look in, serve's own Telegram hub as the delivery
// path (never a second bot client), and the press handler registered on that hub.
//
// OFF BY DEFAULT. The stored defaults of intake say `enabled: true` (so `keryx intake poll` works on a bare
// project), but a serve that polled GitHub and wrote to a topic for every project of the machine because nobody said
// no would be a surprise. A project takes part in the serve tick only when it HAS an intake config file and that
// file is enabled: a person opted in.

import { access } from "node:fs/promises";
import path from "node:path";
import { createDefaultIntakeAssessor } from "../intake/assess";
import { createIntakeCardSink } from "../intake/card";
import { intakeConfigPath, readIntakeConfig } from "../intake/config";
import { recoverIntakeTaking, type IntakeActionDeps } from "../intake/actions";
import { runIntakeTick, type IntakeDeps } from "../intake/poll";
import { createIntakePressHandler, type IntakePressHub } from "../intake/press";
import type { IntakeAssessor, IntakeCardSink } from "../intake/types";
import type { IntakeCallbackHandler } from "../remote/hub";
import { installRealIntakePorts } from "./intake-ports";
import { serveDigestRoots } from "./serve-digest";

/** What serve needs of the hub; `RemoteHub` fits it. */
export interface ServeIntakeHub extends IntakePressHub {
  registerIntakeCallbackHandler(handler: IntakeCallbackHandler | undefined): void;
}

export interface ServeIntakeOptions {
  /** The hub of the running serve; `undefined` while Telegram is not connected. */
  readonly hub: () => ServeIntakeHub | undefined;
  readonly cwd?: string;
  readonly onNotice?: (message: string) => void;
  /** Test seams. Defaults: the real roots, the real model, the real flow and ci-triage ports. */
  readonly roots?: () => readonly string[];
  readonly assessor?: (root: string) => IntakeAssessor;
  readonly sink?: (hub: ServeIntakeHub, topic: string) => IntakeCardSink;
  readonly actionDeps?: IntakeActionDeps;
  readonly pollDeps?: IntakeDeps;
  readonly now?: () => Date;
  readonly everyMs?: number;
  readonly arm?: (tick: () => void, everyMs: number) => () => void;
}

export interface ServeIntake {
  /** One pass over every opted-in project. Resolves when it is done. */
  tick(): Promise<void>;
  start(): void;
  /** Stop ticking, wait for a tick in progress and take the press handler off the hub. */
  stop(): Promise<void>;
}

export const SERVE_INTAKE_EVERY_MS = 30_000;

/** True when the project opted in: an intake config file exists and is enabled. */
export async function intakeOptedIn(root: string): Promise<boolean> {
  try {
    await access(intakeConfigPath(root));
  } catch {
    return false;
  }
  return (await readIntakeConfig(root)).enabled;
}

export function createServeIntake(options: ServeIntakeOptions): ServeIntake {
  const everyMs = options.everyMs ?? SERVE_INTAKE_EVERY_MS;
  const rootsNow = (): string[] => [...new Set((options.roots?.() ?? serveDigestRoots(options.cwd)).map((r) => path.resolve(r)))];
  const recovered = new Set<string>();
  let registeredOn: ServeIntakeHub | undefined;
  let stopTimer: (() => void) | undefined;
  let running: Promise<void> | undefined;

  const notice = (message: string): void => options.onNotice?.(message);

  async function runTick(): Promise<void> {
    const hub = options.hub();
    const optedIn: string[] = [];
    for (const root of rootsNow()) {
      try {
        if (await intakeOptedIn(root)) optedIn.push(root);
      } catch (error) {
        notice(`intake config of ${root} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (hub === undefined || optedIn.length === 0) return;

    if (registeredOn !== hub) {
      hub.registerIntakeCallbackHandler(
        createIntakePressHandler({ hub, roots: rootsNow, ...(options.actionDeps !== undefined ? { actionDeps: options.actionDeps } : {}), ...(options.now !== undefined ? { now: options.now } : {}) }),
      );
      registeredOn = hub;
    }

    for (const root of optedIn) {
      try {
        // A press that was accepted before a restart is never repeated: it is adopted or marked for review, once.
        if (!recovered.has(root)) {
          recovered.add(root);
          const n = await recoverIntakeTaking(root, { ...(options.actionDeps !== undefined ? { deps: options.actionDeps } : {}), ...(options.now !== undefined ? { now: options.now } : {}) });
          if (n > 0) notice(`intake: ${n} card(s) were mid-action at the last stop; check them in the Intake tab`);
        }
        const config = await readIntakeConfig(root);
        const sink = options.sink?.(hub, config.topic) ?? createIntakeCardSink(hub, config.topic);
        await runIntakeTick(root, { ...options.pollDeps, config, sink, assess: options.assessor?.(root) ?? createDefaultIntakeAssessor(root) });
      } catch (error) {
        notice(`intake of ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const intake: ServeIntake = {
    tick(): Promise<void> {
      // One tick at a time: a slow poll must not be started twice by the next interval.
      if (running !== undefined) return running;
      const current = runTick().finally(() => {
        running = undefined;
      });
      running = current;
      return current;
    },
    start(): void {
      if (stopTimer !== undefined) return;
      if (options.actionDeps === undefined) installRealIntakePorts();
      const tick = (): void => {
        void intake.tick();
      };
      stopTimer =
        options.arm?.(tick, everyMs) ??
        ((): (() => void) => {
          const timer = setInterval(tick, everyMs);
          timer.unref?.();
          return () => clearInterval(timer);
        })();
      tick();
    },
    async stop(): Promise<void> {
      stopTimer?.();
      stopTimer = undefined;
      if (running !== undefined) await running.catch(() => undefined);
      registeredOn?.registerIntakeCallbackHandler(undefined);
      registeredOn = undefined;
    },
  };
  return intake;
}
