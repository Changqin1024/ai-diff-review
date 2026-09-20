import * as vscode from 'vscode';
import { ReviewController } from '../reviewController';
import { getWatchSettings, normalizePath } from '../settings';
import { relativePathOf } from '../util';

interface IncomingMessage {
  type: string;
  value?: string;
  checked?: boolean;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Settings as a sidebar webview view, next to the change list. */
export class SettingsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'aiReview.settings';

  private view?: vscode.WebviewView;

  constructor(private readonly controller: ReviewController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message: IncomingMessage) => void this.onMessage(message));
    void this.update();
  }

  async update(): Promise<void> {
    if (!this.view) {
      return;
    }
    const config = vscode.workspace.getConfiguration('aiReview');
    const settings = getWatchSettings();
    const stats = await this.controller.cacheStats();
    void this.view.webview.postMessage({
      type: 'state',
      enabled: settings.enabled,
      paths: settings.paths,
      excludes: settings.exclude,
      files: stats.files,
      size: humanSize(stats.bytes),
      cacheDir: (config.get<string>('cacheDir', '') ?? '').trim(),
      trackBinary: config.get<boolean>('trackBinaryFiles', false),
      diffDisplay: config.get<string>('diffDisplay', 'full'),
    });
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('aiReview').update(key, value, vscode.ConfigurationTarget.Workspace);
  }

  private async updateWatch(key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration('aiReview')
      .update(`watch.${key}`, value, vscode.ConfigurationTarget.Workspace);
  }

  private async pickWorkspacePaths(): Promise<string[] | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      void vscode.window.showWarningMessage('请先打开一个工作区。');
      return undefined;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: folders[0].uri,
      openLabel: '选择',
      title: '选择工作区内的文件或文件夹',
    });
    if (!uris || uris.length === 0) {
      return undefined;
    }
    const result: string[] = [];
    for (const uri of uris) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) {
        void vscode.window.showWarningMessage(`已忽略工作区外的路径：${uri.fsPath}`);
        continue;
      }
      const relative = relativePathOf(folder, uri);
      if (relative.startsWith('..')) {
        void vscode.window.showWarningMessage(`已忽略工作区外的路径：${uri.fsPath}`);
        continue;
      }
      result.push(normalizePath(relative));
    }
    return result.length > 0 ? result : undefined;
  }

  private async onMessage(message: IncomingMessage): Promise<void> {
    const settings = getWatchSettings();
    switch (message.type) {
      case 'ready':
        await this.update();
        return;
      case 'setEnabled': {
        const enabled = Boolean(message.checked);
        await this.updateWatch('enabled', enabled);
        if (enabled) {
          await this.controller.createCheckpoint(true);
        } else {
          this.controller.clearPending();
        }
        await this.update();
        return;
      }
      case 'addPath': {
        const picked = await this.pickWorkspacePaths();
        if (picked) {
          await this.updateWatch('paths', Array.from(new Set([...settings.paths, ...picked])));
          await this.controller.reconcile();
        }
        await this.update();
        return;
      }
      case 'removePath': {
        if (message.value) {
          await this.updateWatch(
            'paths',
            settings.paths.filter((p) => p !== message.value)
          );
          await this.controller.reconcile();
        }
        await this.update();
        return;
      }
      case 'addExcludePath': {
        const picked = await this.pickWorkspacePaths();
        if (picked) {
          await this.controller.setWatchExclude(Array.from(new Set([...settings.exclude, ...picked])));
          const cleared = await this.controller.pruneExcludedBaselines();
          if (cleared > 0) {
            void vscode.window.showInformationMessage(`AI 审查：已清除 ${cleared} 个被排除文件的基线。`);
          }
        }
        await this.update();
        return;
      }
      case 'addExcludeGlob': {
        const value = await vscode.window.showInputBox({
          title: '输入排除的 glob 模式',
          placeHolder: '例如 **/*.min.js',
          validateInput: (v) => (v.trim().length === 0 ? '不能为空' : undefined),
        });
        if (value) {
          await this.controller.setWatchExclude(
            Array.from(new Set([...settings.exclude, normalizePath(value.trim())]))
          );
          const cleared = await this.controller.pruneExcludedBaselines();
          if (cleared > 0) {
            void vscode.window.showInformationMessage(`AI 审查：已清除 ${cleared} 个被排除文件的基线。`);
          }
        }
        await this.update();
        return;
      }
      case 'removeExclude': {
        if (message.value) {
          await this.controller.setWatchExclude(settings.exclude.filter((p) => p !== message.value));
          await this.controller.reconcile();
        }
        await this.update();
        return;
      }
      case 'clearCache': {
        const stats = await this.controller.cacheStats();
        const choice = await vscode.window.showWarningMessage(
          `确定要删除当前工作区的全部基线缓存吗？（${stats.files} 个文件）`,
          { modal: true },
          '清理'
        );
        if (choice === '清理') {
          const cleared = await this.controller.clearWorkspaceCache();
          void vscode.window.showInformationMessage(`AI 审查：已清理 ${cleared.files} 个文件的缓存。`);
        }
        await this.update();
        return;
      }
      case 'resetBaseline': {
        const choice = await vscode.window.showWarningMessage(
          '确定要重置基线吗？将以当前内容作为新基线，并丢弃所有待审查项。',
          { modal: true },
          '重置基线'
        );
        if (choice === '重置基线') {
          const count = await this.controller.reset();
          void vscode.window.showInformationMessage(`AI 审查：已重置基线（${count} 个文件）。`);
        }
        await this.update();
        return;
      }
      case 'pickCacheDir': {
        const folders = vscode.workspace.workspaceFolders;
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: folders?.[0]?.uri,
          openLabel: '使用此目录',
          title: '选择基线缓存目录',
        });
        if (picked && picked[0]) {
          await this.updateSetting('cacheDir', picked[0].fsPath);
          await this.controller.relocateStore();
        }
        await this.update();
        return;
      }
      case 'resetCacheDir': {
        await this.updateSetting('cacheDir', '');
        await this.controller.relocateStore();
        await this.update();
        return;
      }
      case 'setTrackBinary': {
        await this.updateSetting('trackBinaryFiles', Boolean(message.checked));
        await this.update();
        return;
      }
      case 'setDiffDisplay': {
        await this.updateSetting('diffDisplay', message.value === 'hunks' ? 'hunks' : 'full');
        await this.update();
        return;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:changqin.ai-diff-review');
        return;
      case 'exit':
        await vscode.commands.executeCommand('aiReview.exitSettings');
        return;
      case 'refresh':
        await this.update();
        return;
      default:
        return;
    }
  }

  private html(): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { margin: 0; padding: 10px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .page-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .page-head .back { display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-size: 0.9em; padding: 2px 8px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; background: transparent; color: var(--vscode-foreground); }
  .page-head .back:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
  .page-head .page-title { font-weight: 700; font-size: 1.05em; }
  .switch-row { display: flex; align-items: center; gap: 8px; padding: 4px 0 10px; }
  .switch-row input { margin: 0; }
  .switch-row .label { font-weight: 600; }
  .section { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); padding: 10px 0; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .section-head .title { font-weight: 600; }
  .head-actions { display: flex; gap: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 6px; border-radius: 4px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }
  .chip .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .x { cursor: pointer; border: none; background: transparent; color: inherit; padding: 0 2px; font-size: 1em; line-height: 1; }
  .chip .x:hover { color: var(--vscode-errorForeground, #f85149); }
  .empty { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .hint { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .btn { font-family: inherit; font-size: 0.85em; padding: 2px 8px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .btn.reject { background: transparent; border-color: var(--vscode-input-border, #6b6b6b); color: var(--vscode-foreground); }
  .btn.reject:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
  .foot { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); padding-top: 10px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .dir-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
  .field-label { font-size: 0.9em; }
  select { font-family: inherit; font-size: 0.85em; background: var(--vscode-dropdown-background, #3a3d41); color: var(--vscode-dropdown-foreground, #fff); border: 1px solid var(--vscode-dropdown-border, #3a3d41); border-radius: 4px; padding: 2px 6px; }
</style>
</head>
<body>
  <div class="page-head">
    <button class="back" id="back">← 返回</button>
    <span class="page-title">设置</span>
  </div>

  <label class="switch-row">
    <input type="checkbox" id="enabled" />
    <span class="label">启动监听</span>
  </label>

  <div class="section">
    <div class="section-head">
      <span class="title">监听路径</span>
      <button class="btn" id="add-path">+ 添加</button>
    </div>
    <div class="chips" id="paths"></div>
    <div class="hint">留空表示监听整个工作区</div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="title">排除（本工作区）</span>
      <span class="head-actions">
        <button class="btn" id="add-exclude-path">+ 路径</button>
        <button class="btn" id="add-exclude-glob">+ glob</button>
      </span>
    </div>
    <div class="chips" id="excludes"></div>
    <div class="hint">与全局 aiReview.ignore 互相独立、同时生效</div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="title">缓存</span>
      <button class="btn reject" id="clear-cache">清理</button>
    </div>
    <div class="dir-row">
      <span class="dir" id="cache-dir" title=""></span>
      <button class="btn" id="pick-cache-dir">选择目录…</button>
      <button class="btn" id="reset-cache-dir">恢复默认</button>
    </div>
    <div class="hint" id="cache-info"></div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="title">内容</span>
    </div>
    <label class="switch-row">
      <input type="checkbox" id="track-binary" />
      <span class="label">追踪二进制文件</span>
    </label>
    <div class="field">
      <span class="field-label">diff 显示范围</span>
      <select id="diff-display">
        <option value="full">整份文件</option>
        <option value="hunks">仅变更片段</option>
      </select>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="title">基线</span>
      <button class="btn reject" id="reset-baseline">重置基线</button>
    </div>
    <div class="hint">清空基线并以当前内容重新开始（会丢弃所有待审查项）</div>
  </div>

  <div class="foot">
    <a id="open-settings">打开完整设置</a>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const enabledEl = document.getElementById('enabled');
    const pathsEl = document.getElementById('paths');
    const excludesEl = document.getElementById('excludes');
    const cacheInfoEl = document.getElementById('cache-info');
    const cacheDirEl = document.getElementById('cache-dir');
    const trackBinaryEl = document.getElementById('track-binary');
    const diffDisplayEl = document.getElementById('diff-display');

    function esc(v) {
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function renderChips(el, list, action, emptyText) {
      if (!list || list.length === 0) {
        el.innerHTML = '<span class="empty">' + emptyText + '</span>';
        return;
      }
      el.innerHTML = list.map(function (p) {
        return '<span class="chip"><span class="text" title="' + esc(p) + '">' + esc(p) +
          '</span><button class="x" data-action="' + action + '" data-value="' + esc(p) + '">×</button></span>';
      }).join('');
    }
    function render(state) {
      enabledEl.checked = !!state.enabled;
      renderChips(pathsEl, state.paths, 'removePath', '整个工作区');
      renderChips(excludesEl, state.excludes, 'removeExclude', '无');
      cacheInfoEl.textContent = state.files + ' 个文件 · ' + state.size;
      cacheDirEl.textContent = state.cacheDir ? state.cacheDir : '扩展默认存储';
      cacheDirEl.title = state.cacheDir || '扩展默认存储';
      trackBinaryEl.checked = !!state.trackBinary;
      diffDisplayEl.value = state.diffDisplay === 'hunks' ? 'hunks' : 'full';
    }
    document.getElementById('add-path').addEventListener('click', () => vscode.postMessage({ type: 'addPath' }));
    document.getElementById('add-exclude-path').addEventListener('click', () => vscode.postMessage({ type: 'addExcludePath' }));
    document.getElementById('add-exclude-glob').addEventListener('click', () => vscode.postMessage({ type: 'addExcludeGlob' }));
    document.getElementById('clear-cache').addEventListener('click', () => vscode.postMessage({ type: 'clearCache' }));
    document.getElementById('reset-baseline').addEventListener('click', () => vscode.postMessage({ type: 'resetBaseline' }));
    document.getElementById('open-settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('back').addEventListener('click', () => vscode.postMessage({ type: 'exit' }));
    document.getElementById('pick-cache-dir').addEventListener('click', () => vscode.postMessage({ type: 'pickCacheDir' }));
    document.getElementById('reset-cache-dir').addEventListener('click', () => vscode.postMessage({ type: 'resetCacheDir' }));
    enabledEl.addEventListener('change', () => vscode.postMessage({ type: 'setEnabled', checked: enabledEl.checked }));
    trackBinaryEl.addEventListener('change', () => vscode.postMessage({ type: 'setTrackBinary', checked: trackBinaryEl.checked }));
    diffDisplayEl.addEventListener('change', () => vscode.postMessage({ type: 'setDiffDisplay', value: diffDisplayEl.value }));
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (btn) {
        vscode.postMessage({ type: btn.dataset.action, value: btn.dataset.value });
      }
    });
    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'state') render(e.data); });
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
