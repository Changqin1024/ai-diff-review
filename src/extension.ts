import * as vscode from 'vscode';
import { BaselineStore } from './baselineStore';
import { ChangeTracker } from './changeTracker';
import { AiReviewContentProvider } from './diffContentProvider';
import { ReviewController } from './reviewController';
import { ChangesTreeProvider } from './ui/treeProvider';
import { ReviewPanel } from './ui/reviewPanel';
import { AiReviewHoverProvider } from './ui/hoverProvider';
import { GlobalActionsViewProvider } from './ui/globalActionsView';

function keyOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const value = arg as Record<string, unknown>;
    if (typeof value.key === 'string') {
      return value.key;
    }
    const view = value.view as Record<string, unknown> | undefined;
    if (view && typeof view.key === 'string') {
      return view.key;
    }
    const change = value.change as Record<string, unknown> | undefined;
    if (change && typeof change.key === 'string') {
      return change.key;
    }
  }
  return undefined;
}

function hunkIndexOf(arg: unknown): number | undefined {
  if (arg && typeof arg === 'object') {
    const value = arg as Record<string, unknown>;
    if (typeof value.hunkIndex === 'number') {
      return value.hunkIndex;
    }
    if (typeof value.index === 'number') {
      return value.index;
    }
    const hunk = value.hunk as Record<string, unknown> | undefined;
    if (hunk && typeof hunk.index === 'number') {
      return hunk.index;
    }
  }
  return undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new BaselineStore(context);
  const tracker = new ChangeTracker(store);
  const controller = new ReviewController(tracker, store);
  const tree = new ChangesTreeProvider(controller, tracker);
  const contentProvider = new AiReviewContentProvider(tracker, store);
  const hoverProvider = new AiReviewHoverProvider(tracker);

  /** Real file key behind a native diff tab (either side), if it is ours. */
  const diffTabKey = (input: vscode.TabInputTextDiff): string | undefined => {
    for (const uri of [input.original, input.modified]) {
      if (uri.scheme === AiReviewContentProvider.scheme) {
        return vscode.Uri.parse(uri.query).toString();
      }
    }
    return undefined;
  };

  /**
   * Accepting/rejecting a file removes it from the model. Close the matching
   * native diff tab so the comparison is visibly cleared instead of lingering
   * with stale content.
   */
  const closeResolvedDiffTabs = (): void => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const key = diffTabKey(tab.input);
          if (key && !tracker.getByKey(key)) {
            void vscode.window.tabGroups.close(tab);
          }
        }
      }
    }
  };

  context.subscriptions.push(
    tracker,
    contentProvider,
    vscode.workspace.registerTextDocumentContentProvider(
      AiReviewContentProvider.scheme,
      contentProvider
    ),
    vscode.languages.registerHoverProvider(
      { scheme: AiReviewContentProvider.scheme },
      hoverProvider
    ),
    vscode.window.registerTreeDataProvider('aiReview.changes', tree),
    vscode.window.registerWebviewViewProvider(
      GlobalActionsViewProvider.viewType,
      new GlobalActionsViewProvider(tracker)
    ),
    vscode.window.registerWebviewPanelSerializer(ReviewPanel.viewType, {
      async deserializeWebviewPanel(panel): Promise<void> {
        ReviewPanel.revive(panel, context.extensionUri, controller, tracker);
      },
    }),
    // Keep open diff editors in sync and drop them once fully reviewed.
    tracker.onDidChange(() => {
      contentProvider.fireAll();
      closeResolvedDiffTabs();
    })
  );

  /** The real file behind the active baseline/working diff editor, if any. */
  const activeDiffKey = (): string | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === AiReviewContentProvider.scheme) {
      return vscode.Uri.parse(editor.document.uri.query).toString();
    }
    return undefined;
  };

  const updateActiveDiffContext = (): void => {
    void vscode.commands.executeCommand('setContext', 'aiReview.activeDiff', Boolean(activeDiffKey()));
  };

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'aiReview.openReview';
  context.subscriptions.push(statusItem);

  const updateStatus = (): void => {
    const count = tracker.count;
    statusItem.text = `$(diff) AI 审查: ${count}`;
    statusItem.tooltip =
      count > 0
        ? `有 ${count} 个文件发生改动，点击进行审查。`
        : '没有待审查的改动，点击打开审查面板。';
    void vscode.commands.executeCommand('setContext', 'aiReview.hasChanges', count > 0);
    const show = vscode.workspace.getConfiguration('aiReview').get<boolean>('showStatusBar', true);
    if (show) {
      statusItem.show();
    } else {
      statusItem.hide();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('aiReview.createCheckpoint', async () => {
      const count = await controller.createCheckpoint(true);
      void vscode.window.setStatusBarMessage(`AI 审查：检查点已更新（新增 ${count} 个文件）。`, 4000);
    }),
    vscode.commands.registerCommand('aiReview.reset', async () => {
      const count = await controller.reset();
      void vscode.window.setStatusBarMessage(`AI 审查：检查点已重置（${count} 个文件）。`, 4000);
    }),
    vscode.commands.registerCommand('aiReview.openReview', (arg: unknown) => {
      ReviewPanel.show(context.extensionUri, controller, tracker, keyOf(arg), hunkIndexOf(arg));
    }),
    vscode.commands.registerCommand('aiReview.refresh', async () => {
      await tracker.refreshAll();
    }),
    vscode.commands.registerCommand('aiReview.acceptAll', async () => {
      await controller.acceptAll();
    }),
    vscode.commands.registerCommand('aiReview.rejectAll', async () => {
      const choice = await vscode.window.showWarningMessage(
        `确定要拒绝全部 ${tracker.count} 个待审查改动，并将文件恢复到检查点吗？`,
        { modal: true },
        '全部拒绝'
      );
      if (choice === '全部拒绝') {
        await controller.rejectAll();
      }
    }),
    vscode.commands.registerCommand('aiReview.acceptFile', async (arg: unknown) => {
      const key = keyOf(arg) ?? activeDiffKey();
      if (key) {
        await controller.acceptFile(key);
      }
    }),
    vscode.commands.registerCommand('aiReview.rejectFile', async (arg: unknown) => {
      const key = keyOf(arg) ?? activeDiffKey();
      if (key) {
        await controller.rejectFile(key);
      }
    }),
    vscode.commands.registerCommand('aiReview.acceptHunk', async (arg: unknown) => {
      const key = keyOf(arg);
      const index = hunkIndexOf(arg);
      if (key && index !== undefined) {
        await controller.acceptHunk(key, index);
      }
    }),
    vscode.commands.registerCommand('aiReview.rejectHunk', async (arg: unknown) => {
      const key = keyOf(arg);
      const index = hunkIndexOf(arg);
      if (key && index !== undefined) {
        await controller.rejectHunk(key, index);
      }
    }),
    vscode.commands.registerCommand('aiReview.openDiff', async (arg: unknown) => {
      const key = keyOf(arg);
      if (key) {
        await controller.openDiff(key);
      }
    }),
    vscode.commands.registerCommand('aiReview.revealFile', async (arg: unknown) => {
      const key = keyOf(arg);
      if (key) {
        await controller.reveal(key);
      }
    }),
    vscode.commands.registerCommand('aiReview.openFile', async (arg: unknown) => {
      const key = keyOf(arg);
      if (!key) {
        return;
      }
      let line: number | undefined;
      if (arg && typeof arg === 'object') {
        const hunk = (arg as { hunk?: { newStart?: number } }).hunk;
        if (hunk && typeof hunk.newStart === 'number') {
          line = hunk.newStart;
        }
      }
      await controller.openFile(key, line);
    }),
    tracker.onDidChange(() => updateStatus()),
    vscode.window.onDidChangeActiveTextEditor(() => updateActiveDiffContext())
  );

  updateStatus();
  updateActiveDiffContext();
  tracker.start();

  const autoCheckpoint = vscode.workspace.getConfiguration('aiReview').get<boolean>('autoCheckpoint', true);
  if (autoCheckpoint && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AI 审查：正在建立检查点…' },
      async () => {
        await controller.createCheckpoint(true);
      }
    );
  }

  await tracker.refreshAll();
  updateStatus();
}

export function deactivate(): void {
  /* disposables are cleaned up by VS Code */
}
