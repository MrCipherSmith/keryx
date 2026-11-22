import type { BotApi } from "./types";

/** A stable BotApi reference; each call is bound to the current implementation. */
export class ForwardingBotApi {
  private target: BotApi;
  private blocked = false;
  private gate: Promise<boolean> | undefined;
  private releaseGate: ((allow: boolean) => void) | undefined;
  readonly api: BotApi;

  constructor(initial: BotApi) {
    this.target = initial;
    this.api = new Proxy(initial, {
      get: (_unused, key) => {
        const value: unknown = Reflect.get(this.target, key, this.target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (this.blocked) throw new Error("Telegram channel is unavailable during handoff");
          const gate = this.gate;
          if (gate !== undefined && !await gate) throw new Error("Telegram channel is unavailable during handoff");
          const method: unknown = Reflect.get(this.target, key, this.target);
          if (typeof method !== "function") throw new Error("Telegram method is unavailable after handoff");
          return Reflect.apply(method, this.target, args);
        };
      },
    });
  }

  pause(): void {
    if (this.gate !== undefined) throw new Error("Telegram channel is already paused");
    this.gate = new Promise((resolve) => { this.releaseGate = resolve; });
  }

  resume(allow: boolean): void {
    const release = this.releaseGate;
    if (release === undefined) return;
    this.blocked = !allow;
    this.releaseGate = undefined;
    this.gate = undefined;
    release?.(allow);
  }

  current(): BotApi { return this.target; }
  replace(next: BotApi): void { this.target = next; }
}
