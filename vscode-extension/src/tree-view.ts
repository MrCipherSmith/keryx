// Tree view glue (spec.md §2.4): four `vscode.TreeDataProvider`
// implementations, one per view id already declared in `package.json`'s
// `contributes.views.keryx` (`keryx.status`, `keryx.projects`,
// `keryx.recentTurns`, `keryx.needsAttention`). Every "what should this node
// show" decision is delegated to the pure `tree-view-logic.ts` module so it
// stays unit-testable without a real VS Code instance — this file only
// shells CLI commands (via the existing `runKeryx` seam) and turns the
// parsed results into `vscode.TreeItem`s.

import * as vscode from "vscode";
import { runKeryx } from "./keryx-cli";
import { interpretStatus } from "./status-logic";
import {
  needsAttentionItems,
  parseInProgressFlows,
  parsePendingProposals,
  parseProjectsList,
  parseRecentTurns,
  projectNodeItems,
  recentTurnNodeItems,
  statusNodeLabel,
  type NeedsAttentionItem,
  type ProjectNodeItem,
  type RecentTurnNodeItem,
} from "./tree-view-logic";

async function safeRunKeryx(args: readonly string[], cwd: string): Promise<string> {
  try {
    const result = await runKeryx(args, cwd);
    return result.exitCode === 0 ? result.stdout : "";
  } catch {
    // A missing binary or a transient shell-out failure must not crash a
    // tree view — the Status node/status bar already surface CLI health.
    return "";
  }
}

/** Status: a single node, label = the same 3-state interpretation `status-logic.ts` uses. */
export class KeryxStatusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly cwd: string) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    const stdout = await safeRunKeryx(["status"], this.cwd);
    const label = statusNodeLabel(interpretStatus(stdout));
    return [new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None)];
  }
}

/** Projects: a flat list from `keryx projects list --json`. */
export class KeryxProjectsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly cwd: string) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    const stdout = await safeRunKeryx(["projects", "list", "--json"], this.cwd);
    const items: ProjectNodeItem[] = projectNodeItems(parseProjectsList(stdout));
    if (items.length === 0) {
      return [new vscode.TreeItem("No registered projects", vscode.TreeItemCollapsibleState.None)];
    }
    return items.map((item) => {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      treeItem.description = item.description;
      treeItem.resourceUri = vscode.Uri.file(item.path);
      return treeItem;
    });
  }
}

/** Recent Turns: last 10 sessions from `keryx sessions list --json`. */
export class KeryxRecentTurnsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly cwd: string) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    const stdout = await safeRunKeryx(["sessions", "list", "--json"], this.cwd);
    const items: RecentTurnNodeItem[] = recentTurnNodeItems(parseRecentTurns(stdout));
    if (items.length === 0) {
      return [new vscode.TreeItem("No recent turns", vscode.TreeItemCollapsibleState.None)];
    }
    return items.map((item) => {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      treeItem.description = item.description;
      treeItem.id = item.sessionId;
      return treeItem;
    });
  }
}

/**
 * Needs Your Attention: merges in-progress flow tasks
 * (`keryx flow list --json`) and pending SAC proposals
 * (`keryx workspace catch-up --json`) into one list — AC5's explicit
 * empty-state requirement is handled by `tree-view-logic.ts`'s
 * `needsAttentionItems`, which always returns at least one legible item.
 */
export class KeryxNeedsAttentionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly cwd: string) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    const [flowStdout, catchUpStdout] = await Promise.all([
      safeRunKeryx(["flow", "list", "--json"], this.cwd),
      safeRunKeryx(["workspace", "catch-up", "--json"], this.cwd),
    ]);
    const items: NeedsAttentionItem[] = needsAttentionItems(
      parseInProgressFlows(flowStdout),
      parsePendingProposals(catchUpStdout),
    );
    return items.map((item) => {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      treeItem.description = item.description;
      if (item.kind === "empty") {
        treeItem.iconPath = new vscode.ThemeIcon("info");
      }
      return treeItem;
    });
  }
}

export interface KeryxTreeProviders {
  readonly status: KeryxStatusTreeProvider;
  readonly projects: KeryxProjectsTreeProvider;
  readonly recentTurns: KeryxRecentTurnsTreeProvider;
  readonly needsAttention: KeryxNeedsAttentionTreeProvider;
}

/** Construct and register all 4 tree-view providers against `package.json`'s declared view ids. */
export function registerKeryxTreeViews(context: vscode.ExtensionContext, cwd: string): KeryxTreeProviders {
  const providers: KeryxTreeProviders = {
    status: new KeryxStatusTreeProvider(cwd),
    projects: new KeryxProjectsTreeProvider(cwd),
    recentTurns: new KeryxRecentTurnsTreeProvider(cwd),
    needsAttention: new KeryxNeedsAttentionTreeProvider(cwd),
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("keryx.status", providers.status),
    vscode.window.registerTreeDataProvider("keryx.projects", providers.projects),
    vscode.window.registerTreeDataProvider("keryx.recentTurns", providers.recentTurns),
    vscode.window.registerTreeDataProvider("keryx.needsAttention", providers.needsAttention),
  );

  return providers;
}

/** Refresh every registered tree view (wired into the existing `keryx.refresh` command). */
export function refreshAll(providers: KeryxTreeProviders): void {
  providers.status.refresh();
  providers.projects.refresh();
  providers.recentTurns.refresh();
  providers.needsAttention.refresh();
}
