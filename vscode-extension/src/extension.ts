// Extension entry point (spec.md §2.1). Thin `vscode`-calling shell: every
// decision (parse status, decide whether to prompt, decide whether to
// reveal, judge a version) is delegated to the pure modules in this
// directory (`status-logic.ts`, `version-logic.ts`, `audit-log.ts`) so the
// decision logic is unit-testable with `bun test` and no `vscode` import —
// there is no VS Code test harness available in this environment (no `code`
// CLI, no verified-installable `@vscode/test-electron`), so this file itself
// is NOT exercised by the test suite here; only static/manual review backs
// it, honestly noted in the flow report.

import * as vscode from "vscode";
import { registerKeryxHoverProvider } from "./hover-provider";
import { KeryxBinaryNotFoundError, runKeryx } from "./keryx-cli";
import { createKeryxOutputChannel, type KeryxOutputChannel } from "./output-channel";
import { createKeryxStatusBar, type KeryxStatusBar } from "./status-bar";
import {
  initPromptMessage,
  initSucceededButNotReadyMessage,
  interpretStatus,
  shouldPromptInit,
  shouldRevealAfterInit,
} from "./status-logic";
import { refreshAll, registerKeryxTreeViews, type KeryxTreeProviders } from "./tree-view";
import { checkKeryxVersion, versionWarningMessage } from "./version-logic";

// The extension's declared minimum keryx version (spec.md §3). Advisory
// only — never blocks activation, mirrors
// `src/harness/external/registry.ts`'s `knownGoodRange.min` precedent.
const MIN_KERYX_VERSION = "0.2.0";

const VIEW_CONTAINER_ID = "keryx";

let outputChannel: KeryxOutputChannel;
let statusBar: KeryxStatusBar | undefined;
let treeProviders: KeryxTreeProviders | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function checkVersionAndWarn(cwd: string): Promise<void> {
  try {
    const result = await runKeryx(["--version"], cwd);
    const verdict = checkKeryxVersion(result.stdout, MIN_KERYX_VERSION);
    if (verdict.state === "below-minimum") {
      void vscode.window.showWarningMessage(versionWarningMessage(verdict));
    }
    // "undetermined" and "ok" are both silent — advisory only (spec.md §3).
  } catch (error) {
    // A missing binary is already surfaced by the init/status flow below;
    // don't double-report it here.
    if (!(error instanceof KeryxBinaryNotFoundError)) {
      outputChannel.appendLine(`[version-check] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function revealTreeView(): Promise<void> {
  await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
}

async function runInitFlow(cwd: string): Promise<void> {
  const statusResult = await runKeryx(["status"], cwd);
  const state = interpretStatus(statusResult.stdout);

  if (!shouldPromptInit(state)) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    initPromptMessage(state),
    "Run keryx init",
    "Not now",
  );

  // AC1's never-silent requirement: `keryx init --yes` runs ONLY on the
  // explicit button click, never automatically.
  if (choice !== "Run keryx init") {
    return;
  }

  const initResult = await runKeryx(["init", "--yes"], cwd);
  outputChannel.audit("user", "keryx.init", initResult.exitCode, initResult.exitCode === 0 ? undefined : initResult.stderr.trim());

  const statusAfterInit = await runKeryx(["status"], cwd);
  const afterState = interpretStatus(statusAfterInit.stdout);

  if (shouldRevealAfterInit(initResult.exitCode, afterState)) {
    if (treeProviders) {
      refreshAll(treeProviders);
    }
    if (statusBar) {
      await statusBar.refresh();
    }
    await revealTreeView();
  } else if (initResult.exitCode !== 0) {
    void vscode.window.showErrorMessage(
      `keryx init failed: ${initResult.stderr.trim() || "see the Keryx output channel"}`,
    );
    outputChannel.appendLine(initResult.stderr);
  } else {
    // Exit 0 but not "ready" (e.g. still "incomplete"): neither the
    // success/reveal branch nor the error branch above fires. Never leave
    // this path silent — show an informational message naming the resulting
    // state and audit-log it too.
    const message = initSucceededButNotReadyMessage(afterState);
    void vscode.window.showInformationMessage(message);
    outputChannel.appendLine(`[keryx.init] ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = createKeryxOutputChannel();
  context.subscriptions.push(outputChannel);

  const initCommand = vscode.commands.registerCommand("keryx.init", async () => {
    const cwd = workspaceRoot();
    if (!cwd) {
      void vscode.window.showWarningMessage("Keryx: open a folder or workspace first.");
      return;
    }
    const result = await runKeryx(["init", "--yes"], cwd);
    outputChannel.audit("user", "keryx.init", result.exitCode, result.exitCode === 0 ? undefined : result.stderr.trim());
    if (result.exitCode === 0) {
      await revealTreeView();
    } else {
      void vscode.window.showErrorMessage(`keryx init failed: ${result.stderr.trim()}`);
    }
  });

  const refreshCommand = vscode.commands.registerCommand("keryx.refresh", async () => {
    outputChannel.audit("user", "keryx.refresh", 0);
    if (treeProviders) {
      refreshAll(treeProviders);
    }
    if (statusBar) {
      await statusBar.refresh();
    }
  });

  context.subscriptions.push(initCommand, refreshCommand);

  const cwd = workspaceRoot();
  if (!cwd) {
    return;
  }

  context.subscriptions.push(registerKeryxHoverProvider(cwd));

  treeProviders = registerKeryxTreeViews(context, cwd);

  statusBar = await createKeryxStatusBar(cwd, outputChannel);
  context.subscriptions.push(statusBar);

  try {
    await runInitFlow(cwd);
  } catch (error) {
    if (error instanceof KeryxBinaryNotFoundError) {
      void vscode.window.showErrorMessage(error.message);
    } else {
      outputChannel.appendLine(`[activation] ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  await checkVersionAndWarn(cwd);
}

export function deactivate(): void {
  // No teardown required: registered commands/output channel/status bar are
  // disposed via context.subscriptions.
  statusBar = undefined;
  treeProviders = undefined;
}
