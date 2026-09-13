import * as vscode from 'vscode';
import { ChangeTracker } from '../changeTracker';
import { countChanges } from '../diffEngine';

/**
 * Bottom-of-sidebar webview view holding the global (all files) actions.
 * Buttons delegate to the regular commands so behaviour stays identical to the
 * command palette (including the reject-all confirmation).
 */
export class GlobalActionsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'aiReview.globalActions';

  private view?: vscode.WebviewView;

  constructor(private readonly tracker: ChangeTracker) {
    this.tracker.onDidChange(() => this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      switch (message?.type) {
        case 'ready':
          this.update();
          return;
        case 'acceptAll':
          void vscode.commands.executeCommand('aiReview.acceptAll');
          return;
        case 'rejectAll':
          void vscode.commands.executeCommand('aiReview.rejectAll');
          return;
        default:
          return;
      }
    });
    this.update();
  }

  private update(): void {
    if (!this.view) {
      return;
    }
    let additions = 0;
    let deletions = 0;
    for (const change of this.tracker.all) {
      if (change.isBinary || change.tooLarge) {
        continue;
      }
      const counts = countChanges(change.baseline, change.current);
      additions += counts.additions;
      deletions += counts.deletions;
    }
    void this.view.webview.postMessage({
      type: 'state',
      files: this.tracker.count,
      additions,
      deletions,
    });
  }

  private html(): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body {
    margin: 0;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  .summary {
    margin-bottom: 8px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .summary .add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
  .summary .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); margin-left: 6px; }
  .row + .row { margin-top: 6px; }
  button {
    width: 100%;
    padding: 6px 10px;
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  #accept {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  #accept:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  #reject {
    background: transparent;
    border-color: var(--vscode-input-border, #6b6b6b);
    color: var(--vscode-foreground);
  }
  #reject:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
</style>
</head>
<body>
  <div id="summary" class="summary">没有待审查的改动</div>
  <div class="row"><button id="accept" disabled>全部接受</button></div>
  <div class="row"><button id="reject" disabled>全部拒绝</button></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const accept = document.getElementById('accept');
    const reject = document.getElementById('reject');
    const summary = document.getElementById('summary');
    accept.addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
    reject.addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'state') return;
      accept.textContent = '全部接受 (' + message.files + ')';
      reject.textContent = '全部拒绝 (' + message.files + ')';
      accept.disabled = message.files === 0;
      reject.disabled = message.files === 0;
      summary.innerHTML = message.files === 0
        ? '没有待审查的改动'
        : message.files + ' 个文件 <span class="add">+' + message.additions +
          '</span><span class="del">-' + message.deletions + '</span>';
    });
    vscode.postMessage({ type: 'ready' });
  </script>
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
