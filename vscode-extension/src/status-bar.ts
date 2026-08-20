// Status bar item glue (spec.md §2.3, AC4). Thin `vscode`-calling shell —
// every decision (glyph/text, which checks are failing, what the
// click-through says) is delegated to the pure `status-bar-logic.ts` module
// so it stays unit-testable without a real VS Code instance, matching the
// house pattern already established by `extension.ts`/`status-logic.ts`.
//
// Data source: three CLI shell-outs through the existing `runKeryx` seam
// (`keryx status`, `keryx health status`, `keryx security status`) rather
// than `GET /v1/status` — see `status-bar-logic.ts`'s header comment for the
// full rationale (the loopback `keryx serve` HTTP backend is off by default
// and nothing in this extension starts it).

import * as vscode from "vscode";
import { runKeryx } from "./keryx-cli";
import { interpretStatus } from "./status-logic";
import {
  computeStatusBarSeverity,
  failingChecks,
  parseHealthGate,
  parseSecurityConfigState,
  statusBarDetailLines,
  statusBarText,
  type StatusBarInputs,
} from "./status-bar-logic";

const POLL_INTERVAL_MS = 60_000;
const COMMAND_ID = "keryx.showStatusDetail";

export class KeryxStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly commandRegistration: vscode.Disposable;
  private readonly timer: ReturnType<typeof globalThis.setInterval>;
  private lastInputs: StatusBarInputs = {
    metaprojectState: "incomplete",
    healthGate: "unknown",
    securityConfig: "unknown",
  };
  // In-flight guard: without it, overlapping refreshes could pile up under a
  // slow/hung `keryx` binary (each poll tick fires a fresh Promise.all of 3
  // child processes regardless of whether the previous tick's is still
  // running). A refresh already in progress means this tick is skipped.
  private refreshing = false;

  constructor(
    private readonly cwd: string,
    private readonly outputChannel?: { appendLine(line: string): void },
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = COMMAND_ID;
    this.commandRegistration = vscode.commands.registerCommand(COMMAND_ID, () => this.showDetail());
    this.item.show();
    this.timer = globalThis.setInterval(() => {
      if (this.refreshing) {
        return;
      }
      // Errors inside `refresh()` are already caught per-call via the
      // `.catch()`s below its `Promise.all`, but anything thrown outside that
      // (e.g. a rejection from `Promise.all` itself, or a bug in the
      // downstream parsing/render code) would otherwise vanish silently as an
      // unhandled rejection from a fire-and-forget interval callback. Log it
      // to the output channel instead, matching how `extension.ts` reports
      // unexpected errors.
      this.refresh().catch((error: unknown) => {
        this.outputChannel?.appendLine(
          `[status-bar] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, POLL_INTERVAL_MS);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      await this.doRefresh();
    } finally {
      this.refreshing = false;
    }
  }

  private async doRefresh(): Promise<void> {
    const [statusResult, healthResult, securityResult] = await Promise.all([
      runKeryx(["status"], this.cwd).catch(() => ({ stdout: "", stderr: "", exitCode: 1 })),
      runKeryx(["health", "status"], this.cwd).catch(() => ({ stdout: "", stderr: "", exitCode: 1 })),
      runKeryx(["security", "status"], this.cwd).catch(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    ]);

    this.lastInputs = {
      metaprojectState: interpretStatus(statusResult.stdout),
      healthGate: parseHealthGate(healthResult.stdout),
      securityConfig: parseSecurityConfigState(securityResult.stdout),
    };

    const severity = computeStatusBarSeverity(this.lastInputs);
    this.item.text = statusBarText(severity);
    this.item.tooltip = statusBarDetailLines(this.lastInputs).join("\n");
  }

  private async showDetail(): Promise<void> {
    const failing = failingChecks(this.lastInputs);
    if (failing.length === 0) {
      void vscode.window.showInformationMessage(statusBarDetailLines(this.lastInputs)[0] ?? "Keryx: all checks passing.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      failing.map((check) => ({ label: check.label, detail: check.detail })),
      { placeHolder: "Keryx: select a failing check for details" },
    );
    if (picked) {
      void vscode.window.showWarningMessage(`${picked.label}: ${picked.detail}`);
    }
  }

  dispose(): void {
    globalThis.clearInterval(this.timer);
    this.item.dispose();
    this.commandRegistration.dispose();
  }
}

/** Create the status bar item and run its first refresh immediately. */
export async function createKeryxStatusBar(
  cwd: string,
  outputChannel?: { appendLine(line: string): void },
): Promise<KeryxStatusBar> {
  const bar = new KeryxStatusBar(cwd, outputChannel);
  await bar.refresh();
  return bar;
}
