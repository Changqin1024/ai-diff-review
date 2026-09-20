import * as vscode from 'vscode';
import { ChangeTracker } from '../changeTracker';
import { ReviewController } from '../reviewController';
import { FileChangeView, PanelFile } from '../types';

interface IncomingMessage {
  type: string;
  key?: string;
  hunkIndex?: number;
}

export class ReviewPanel {
  private static current: ReviewPanel | undefined;
  static readonly viewType = 'aiReview.review';

  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  /** The single file currently shown in the panel. */
  private activeKey?: string;
  /** Change region to scroll to after the next render. */
  private pendingHunk?: number;

  static show(
    extensionUri: vscode.Uri,
    controller: ReviewController,
    tracker: ChangeTracker,
    focusKey?: string,
    focusHunkIndex?: number,
    column: vscode.ViewColumn = vscode.ViewColumn.Active
  ): ReviewPanel {
    if (ReviewPanel.current) {
      if (focusKey) {
        ReviewPanel.current.activeKey = focusKey;
      }
      if (focusHunkIndex !== undefined) {
        ReviewPanel.current.pendingHunk = focusHunkIndex;
      }
      ReviewPanel.current.panel.reveal(column);
      void ReviewPanel.current.update().then(() => ReviewPanel.current?.flushScroll());
      return ReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'AI 审查',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    ReviewPanel.current = new ReviewPanel(panel, extensionUri, controller, tracker, focusKey, focusHunkIndex);
    return ReviewPanel.current;
  }

  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    controller: ReviewController,
    tracker: ChangeTracker
  ): void {
    ReviewPanel.current = new ReviewPanel(panel, extensionUri, controller, tracker);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ReviewController,
    private readonly tracker: ChangeTracker,
    focusKey?: string,
    focusHunkIndex?: number
  ) {
    this.activeKey = focusKey;
    this.pendingHunk = focusHunkIndex;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: IncomingMessage) => void this.onMessage(message),
      null,
      this.disposables
    );
    this.disposables.push(this.tracker.onDidChange(() => void this.update()));
    void this.update();
  }

  private dispose(): void {
    ReviewPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  async update(): Promise<void> {
    void this.panel.webview.postMessage(await this.buildState());
  }

  /** Scroll the panel to the requested change region (once). */
  flushScroll(): void {
    if (this.pendingHunk === undefined) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'scrollToHunk', hunkIndex: this.pendingHunk });
    this.pendingHunk = undefined;
  }

  private toPanelFile(view: FileChangeView): PanelFile {
    return {
      key: view.key,
      relativePath: view.relativePath,
      status: view.status,
      additions: view.additions,
      deletions: view.deletions,
      isBinary: view.isBinary,
      tooLarge: view.tooLarge,
      rows: view.rows,
      pending: true,
      note: '',
    };
  }

  /**
   * Show the active file. If it is no longer pending we keep showing its final
   * content (does not auto-advance to another file).
   */
  private async buildState(): Promise<unknown> {
    const views = this.controller.getViews();
    let additions = 0;
    let deletions = 0;
    for (const v of views) {
      additions += v.additions;
      deletions += v.deletions;
    }

    let file: PanelFile | null = null;
    if (this.activeKey) {
      const pending = views.find((v) => v.key === this.activeKey);
      if (pending) {
        file = this.toPanelFile(pending);
      } else {
        file = (await this.controller.getResolvedFile(this.activeKey)) ?? null;
      }
    } else if (views.length > 0) {
      this.activeKey = views[0].key;
      file = this.toPanelFile(views[0]);
    }

    return {
      type: 'state',
      busy: this.busy,
      file,
      totalFiles: views.length,
      totals: { files: views.length, additions, deletions },
    };
  }

  private async onMessage(message: IncomingMessage): Promise<void> {
    const key = message.key;
    switch (message.type) {
      case 'ready':
        await this.update();
        this.flushScroll();
        return;
      case 'refresh':
        await this.tracker.refreshAll();
        return;
      case 'acceptFile':
        if (key) {
          await this.run(() => this.controller.acceptFile(key));
        }
        return;
      case 'rejectFile':
        if (key) {
          await this.run(() => this.controller.rejectFile(key));
        }
        return;
      case 'acceptHunk':
        if (key !== undefined && message.hunkIndex !== undefined) {
          await this.run(() => this.controller.acceptHunk(key, message.hunkIndex!));
        }
        return;
      case 'rejectHunk':
        if (key !== undefined && message.hunkIndex !== undefined) {
          await this.run(() => this.controller.rejectHunk(key, message.hunkIndex!));
        }
        return;
      case 'openDiff':
        if (key) {
          await this.controller.openDiff(key);
        }
        return;
      case 'reveal':
        if (key) {
          await this.controller.reveal(key);
        }
        return;
      default:
        return;
    }
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    await this.update();
    try {
      await fn();
    } catch (error) {
      void vscode.window.showErrorMessage(`AI 审查：${String(error)}`);
    } finally {
      this.busy = false;
      await this.update();
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'review.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'review.js'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${cssUri}" rel="stylesheet" />
<title>AI 审查</title>
</head>
<body>
<div id="app">
  <header id="toolbar">
    <div class="brand">
      <span class="brand-title">AI 审查</span>
      <span id="file-title" class="file-title"></span>
    </div>
    <div class="toolbar-actions">
      <button id="btn-refresh" class="btn ghost" title="重新扫描工作区">刷新</button>
      <button id="btn-accept-file" class="btn accept" title="接受当前文件的全部改动">接受当前文件</button>
      <button id="btn-reject-file" class="btn reject" title="拒绝当前文件的全部改动">拒绝当前文件</button>
    </div>
  </header>
  <main id="files"></main>
  <div id="empty" class="empty hidden">
    <p id="empty-title">没有待审查的改动。</p>
    <p class="hint">扩展会自动记录基线。让 智能体修改文件，或先执行
    <code>AI 审查: 记录基线</code> 再开始修改。</p>
  </div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
