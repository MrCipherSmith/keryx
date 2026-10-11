// One line to Telegram when an autonomous review starts and one when it ends. Best effort: a run
// with no `keryx serve`, no paired bot or a slow network is never held up or failed by its note.

import { RemoteClient, type RemoteClientOptions } from "../remote/client";
import type { AutonomousSummary } from "./autonomous-summary";
import type { AutonomousTarget } from "./autonomous-profile";

export interface RunNotifier {
  started(line: string): Promise<void>;
  finished(line: string): Promise<void>;
  close(): Promise<void>;
}

export const NO_NOTIFIER: RunNotifier = {
  started: async () => undefined,
  finished: async () => undefined,
  close: async () => undefined,
};

export function startLine(target: AutonomousTarget, attempt: number): string {
  return `Autonomous review started: ${target.repository} PR #${target.number}${attempt > 1 ? ` (attempt ${attempt}, resuming)` : ""}.`;
}

export function endLine(summary: AutonomousSummary): string {
  const { findings } = summary;
  const found = `${findings.blocker} blocker, ${findings.major} major, ${findings.minor} minor`;
  return `Autonomous review ${summary.status} (exit ${summary.exitCode}): ${summary.target.repository} PR #${summary.target.number}, ${found}, ${summary.tokens} tokens, ${summary.durationSeconds} s. ${summary.reason}`;
}

interface ClientLike {
  start(): Promise<{ ok: boolean }>;
  reply(text: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface TelegramNotifierOptions {
  project: string;
  target: AutonomousTarget;
  makeClient?: ((options: RemoteClientOptions) => ClientLike) | undefined;
  timeoutMs?: number | undefined;
  dir?: string | undefined;
}

export function createTelegramNotifier(options: TelegramNotifierOptions): RunNotifier {
  const timeoutMs = options.timeoutMs ?? 8000;
  let client: ClientLike | undefined;
  let usable: Promise<boolean> | undefined;

  const withTimeout = async <T>(work: Promise<T>, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const open = (): Promise<boolean> => {
    usable ??= withTimeout(
      (async () => {
        const clientOptions: RemoteClientOptions = {
          sessionId: `review-autonomous-${options.target.repository.replace("/", "-")}-pr${options.target.number}-${process.pid}`,
          project: options.project,
          name: `review-pr${options.target.number}`,
          onLine: () => undefined,
          ...(options.dir === undefined ? {} : { dir: options.dir }),
        };
        const made = options.makeClient !== undefined ? options.makeClient(clientOptions) : new RemoteClient(clientOptions);
        client = made;
        const result = await made.start();
        return result.ok;
      })(),
      false,
    );
    return usable;
  };

  const send = async (line: string): Promise<void> => {
    if (!(await open())) return;
    await withTimeout(client?.reply(line) ?? Promise.resolve(false), false);
  };

  return {
    started: send,
    finished: send,
    close: async () => {
      if (client === undefined) return;
      await withTimeout(client.close(), undefined);
    },
  };
}
