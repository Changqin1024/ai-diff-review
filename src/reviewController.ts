import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { BaselineStore } from './baselineStore';
import { ChangeTracker } from './changeTracker';
import {
  acceptHunk as acceptHunkText,
  buildHunkRows,
  buildUnifiedRows,
  computeDiff,
  rejectHunk as rejectHunkText,
} from './diffEngine';
import { AiReviewContentProvider } from './diffContentProvider';
import { gitRenames } from './git';
import { getWatchSettings, invalidatePathCache, isExcluded, isIncluded, matchesEntry } from './settings';
import { DisplayRow, FileChange, FileChangeView, PanelFile } from './types';
import {
  basename,
  decodeText,
  encodeText,
  isProbablyBinary,
  relativePathOf,
  splitKeepEndings,
  stripEol,
} from './util';

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function samePaths(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const norm = (list: string[]): string[] => list.map((p) => p.replace(/\\/g, '/').toLowerCase()).sort();
  const left = norm(a);
  const right = norm(b);
  return left.every((value, index) => value === right[index]);
}

/**
 * Applies review decisions. The mental model is simple:
 *
 *   baseline  = the content before the external change
 *   working   = the content on disk right now
 *
 * - Accept  : move the baseline towards the working copy (keep the change).
 * - Reject  : move the working copy back towards the baseline (discard it).
 *
 * Because both sides of a hunk can be edited independently, we can accept or
 * reject individual hunks and still keep the rest of the file pending.
 */
export class ReviewController {
  constructor(
    private readonly tracker: ChangeTracker,
    private readonly store: BaselineStore
  ) {}

  getViews(): FileChangeView[] {
    return this.tracker.all.map((c) => this.toView(c));
  }

  getView(key: string): FileChangeView | undefined {
    const change = this.tracker.getByKey(key);
    return change ? this.toView(change) : undefined;
  }

  /**
   * The final on-disk content of a file that no longer has pending changes.
   * Used to keep showing the result after accepting/rejecting instead of
   * jumping to another file.
   */
  async getResolvedFile(key: string): Promise<PanelFile | undefined> {
    const uri = vscode.Uri.parse(key);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = folder ? relativePathOf(folder, uri) : basename(uri.path);

    let bytes: Uint8Array | undefined;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      bytes = undefined;
    }

    const base: PanelFile = {
      key,
      relativePath,
      status: 'unchanged',
      additions: 0,
      deletions: 0,
      isBinary: false,
      tooLarge: false,
      rows: [],
      pending: false,
      note: '',
    };

    if (!bytes) {
      return { ...base, note: '文件已不存在（删除已确认）。' };
    }
    if (isProbablyBinary(bytes)) {
      return { ...base, isBinary: true, note: '二进制文件，已无差异。' };
    }
    const maxBytes = vscode.workspace.getConfiguration('aiReview').get<number>('maxTextFileKB', 4096) * 1024;
    if (bytes.length > maxBytes) {
      return { ...base, tooLarge: true, note: '文件过大，已无差异。' };
    }

    const lines = splitKeepEndings(decodeText(bytes)).map(stripEol);
    const rows: DisplayRow[] = lines.map((text, index) => ({
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text,
    }));
    return { ...base, rows, note: '该文件已无差异，以下为操作后的最终内容。' };
  }

  private toView(change: FileChange): FileChangeView {
    const hasText = !change.isBinary && !change.tooLarge;
    const hunks = hasText ? computeDiff(change.baseline, change.current) : [];
    const fullFile = vscode.workspace.getConfiguration('aiReview').get<string>('diffDisplay', 'full') !== 'hunks';
    const rows = hasText
      ? fullFile
        ? buildUnifiedRows(change.baseline, change.current)
        : buildHunkRows(change.baseline, change.current)
      : [];
    let additions = 0;
    let deletions = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.type === '+') {
          additions++;
        } else if (l.type === '-') {
          deletions++;
        }
      }
    }
    return {
      key: change.key,
      uriString: change.key,
      relativePath: change.relativePath,
      fileName: basename(change.relativePath),
      status: change.status,
      additions,
      deletions,
      isBinary: change.isBinary,
      tooLarge: change.tooLarge,
      hunks,
      rows,
    };
  }

  async acceptHunk(key: string, hunkIndex: number): Promise<void> {
    const change = this.tracker.getByKey(key);
    if (!change) {
      return;
    }
    if (change.isBinary || change.tooLarge) {
      await this.acceptFile(key);
      return;
    }
    const newBaseline = acceptHunkText(change.baseline, change.current, hunkIndex);
    if (change.status === 'deleted' && newBaseline === '') {
      await this.store.delete(vscode.Uri.parse(change.key));
    } else {
      await this.store.write(vscode.Uri.parse(change.key), encodeText(newBaseline));
    }
    await this.tracker.evaluate(vscode.Uri.parse(change.key));
  }

  async rejectHunk(key: string, hunkIndex: number): Promise<void> {
    const change = this.tracker.getByKey(key);
    if (!change) {
      return;
    }
    if (change.isBinary || change.tooLarge) {
      await this.rejectFile(key);
      return;
    }
    const newCurrent = rejectHunkText(change.baseline, change.current, hunkIndex);
    if (change.status === 'added' && newCurrent === '') {
      await this.tracker.withSelfWrite(vscode.Uri.parse(change.key), () => this.deleteFile(vscode.Uri.parse(change.key)));
      await this.store.delete(vscode.Uri.parse(change.key));
    } else {
      await this.tracker.withSelfWrite(vscode.Uri.parse(change.key), () =>
        vscode.workspace.fs.writeFile(vscode.Uri.parse(change.key), encodeText(newCurrent))
      );
    }
    await this.tracker.evaluate(vscode.Uri.parse(change.key));
  }

  async acceptFile(key: string): Promise<void> {
    const change = this.tracker.getByKey(key);
    if (!change) {
      return;
    }
    if (change.status === 'deleted') {
      await this.store.delete(vscode.Uri.parse(change.key));
    } else {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(change.key));
      await this.store.write(vscode.Uri.parse(change.key), bytes);
    }
    await this.tracker.evaluate(vscode.Uri.parse(change.key));
  }

  async rejectFile(key: string): Promise<void> {
    const change = this.tracker.getByKey(key);
    if (!change) {
      return;
    }
    if (change.status === 'added') {
      await this.tracker.withSelfWrite(vscode.Uri.parse(change.key), () => this.deleteFile(vscode.Uri.parse(change.key)));
      await this.store.delete(vscode.Uri.parse(change.key));
    } else {
      const bytes = await this.store.read(vscode.Uri.parse(change.key));
      if (bytes) {
        await this.tracker.withSelfWrite(vscode.Uri.parse(change.key), () =>
          vscode.workspace.fs.writeFile(vscode.Uri.parse(change.key), bytes)
        );
      }
    }
    await this.tracker.evaluate(vscode.Uri.parse(change.key));
  }

  async acceptAll(): Promise<void> {
    const keys = this.tracker.all.map((c) => c.key);
    for (const key of keys) {
      await this.acceptFile(key);
    }
  }

  async rejectAll(): Promise<void> {
    const keys = this.tracker.all.map((c) => c.key);
    for (const key of keys) {
      await this.rejectFile(key);
    }
  }

  async createCheckpoint(onlyMissing = true): Promise<number> {
    const config = vscode.workspace.getConfiguration('aiReview');
    const ignore = config.get<string[]>('ignore', []);
    const useGit = config.get<boolean>('baselineFromGit', false);
    const trackBinary = config.get<boolean>('trackBinaryFiles', false);
    const settings = getWatchSettings();
    const include = (relativePath: string): boolean =>
      isIncluded(relativePath, settings) && !isExcluded(relativePath, settings);
    const count = await this.store.snapshotWorkspace(ignore, useGit, onlyMissing, include, !trackBinary);
    await this.tracker.refreshAll();
    return count;
  }

  async reset(): Promise<number> {
    await this.store.clear();
    this.tracker.clear();
    return this.createCheckpoint(false);
  }

  async setWatchExclude(entries: string[]): Promise<void> {
    await vscode.workspace
      .getConfiguration('aiReview')
      .update('watch.exclude', entries, vscode.ConfigurationTarget.Workspace);
  }

  /** Move the stored baselines when the cache directory setting changed. */
  async relocateStore(): Promise<boolean> {
    const moved = await this.store.relocate();
    if (moved) {
      await this.tracker.refreshAll();
    }
    return moved;
  }

  private binaryCleanupTimer?: ReturnType<typeof setTimeout>;

  /** Delay cleaning binary baselines so rapid toggling cancels out. */
  scheduleBinaryCleanup(delayMs = 5000): void {
    this.cancelBinaryCleanup();
    this.binaryCleanupTimer = setTimeout(() => {
      this.binaryCleanupTimer = undefined;
      void this.pruneBinaryBaselines();
    }, delayMs);
  }

  cancelBinaryCleanup(): void {
    if (this.binaryCleanupTimer) {
      clearTimeout(this.binaryCleanupTimer);
      this.binaryCleanupTimer = undefined;
    }
  }

  /** Delete stored baselines that look binary. */
  async pruneBinaryBaselines(): Promise<number> {
    if (vscode.workspace.getConfiguration('aiReview').get<boolean>('trackBinaryFiles', false)) {
      return 0;
    }
    const uris = await this.store.list();
    let removed = 0;
    for (const uri of uris) {
      const bytes = await this.store.read(uri);
      if (bytes && isProbablyBinary(bytes)) {
        await this.store.delete(uri);
        removed++;
      }
    }
    if (removed > 0) {
      await this.tracker.refreshAll();
    }
    return removed;
  }

  /** Delete baselines of files that are now excluded in this workspace. */
  async pruneExcludedBaselines(): Promise<number> {
    const settings = getWatchSettings();
    const removed = await this.store.deleteMatching(
      (uri) => {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder ? relativePathOf(folder, uri) : undefined;
      },
      (relativePath) => settings.exclude.some((entry) => matchesEntry(relativePath, entry))
    );
    if (removed > 0) {
      await this.tracker.refreshAll();
    }
    return removed;
  }

  /**
   * Bring the stored baselines in sync with the current filesystem:
   * - if the effective watch scope changed, delete out-of-scope baselines and
   *   baseline the newly in-scope files;
   * - remap baselines of renamed/moved files instead of deleting and rebuilding.
   */
  async reconcile(): Promise<{ pruned: number; remapped: number; rebaselined: boolean }> {
    invalidatePathCache();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const settings = getWatchSettings();
    const meta = await this.store.readMeta();

    const relativeOf = (uri: vscode.Uri): string | undefined => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      return folder ? relativePathOf(folder, uri) : undefined;
    };
    const inScope = (relativePath: string): boolean =>
      isIncluded(relativePath, settings) && !isExcluded(relativePath, settings);

    const scopeChanged =
      meta !== undefined && (!samePaths(meta.paths, settings.paths) || !samePaths(meta.folders, folders));

    let pruned = 0;
    if (scopeChanged) {
      pruned = await this.store.deleteMatching(relativeOf, (relativePath) => !inScope(relativePath));
    }

    const remapped = await this.remapRenames(settings);

    await this.store.writeMeta({ folders, paths: settings.paths });

    if (scopeChanged) {
      await this.createCheckpoint(true);
    }

    return { pruned, remapped, rebaselined: scopeChanged };
  }

  /** Move baselines when files were renamed/moved (git detection, then content hash). */
  private async remapRenames(_settings: ReturnType<typeof getWatchSettings>): Promise<number> {
    const deleted = this.tracker.all.filter((c) => c.status === 'deleted' && c.baseline.length > 0);
    const added = this.tracker.all.filter((c) => c.status === 'added' && c.current.length > 0);
    if (added.length === 0 || deleted.length === 0) {
      return 0;
    }

    let moved = 0;

    // 1) git rename detection (handles rename + edit via similarity)
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      const renames = await gitRenames(folder.uri.fsPath);
      for (const rename of renames) {
        const from = vscode.Uri.joinPath(folder.uri, ...rename.from.split('/'));
        const to = vscode.Uri.joinPath(folder.uri, ...rename.to.split('/'));
        if ((await this.store.has(from)) && !(await this.store.has(to))) {
          if (await this.store.move(from, to)) {
            moved++;
          }
        }
      }
    }

    // 2) content-hash fallback from pending changes (pure rename/move)
    if (deleted.length <= 500) {
      const byHash = new Map<string, FileChange>();
      for (const change of deleted) {
        const hash = sha1(change.baseline);
        if (!byHash.has(hash)) {
          byHash.set(hash, change);
        }
      }
      for (const change of added) {
        const hash = sha1(change.current);
        const source = byHash.get(hash);
        if (!source) {
          continue;
        }
        await this.store.write(vscode.Uri.parse(change.key), encodeText(source.baseline));
        await this.store.delete(vscode.Uri.parse(source.key));
        byHash.delete(hash);
        moved++;
      }
    }

    if (moved > 0) {
      await this.tracker.refreshAll();
    }
    return moved;
  }

  /** Delete every stored baseline of the current workspace and empty the list. */
  async clearWorkspaceCache(): Promise<{ files: number; bytes: number }> {
    const stats = await this.store.stats();
    await this.store.clear();
    this.tracker.clear();
    return stats;
  }

  cacheStats(): Promise<{ files: number; bytes: number }> {
    return this.store.stats();
  }

  /** Empty the pending list without touching the stored baselines. */
  clearPending(): void {
    this.tracker.clear();
  }

  async openDiff(key: string): Promise<void> {
    const change = this.tracker.getByKey(key);
    if (!change) {
      return;
    }
    if (change.isBinary) {
      void vscode.window.showInformationMessage(`“${change.relativePath}”是二进制文件，无法逐行对比。`);
      return;
    }
    const left = AiReviewContentProvider.uri('baseline', vscode.Uri.parse(change.key));
    const right = AiReviewContentProvider.uri('current', vscode.Uri.parse(change.key));
    const title = `${change.relativePath}（基线 ↔ 当前）`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
    void vscode.window.setStatusBarMessage(
      'AI 审查：将鼠标移到变更块上可“接受/拒绝”，或使用编辑器右上角按钮。',
      6000
    );
  }

  /** Open the real working file in the editor (optionally at a given line). */
  async openFile(key: string, line?: number): Promise<void> {
    const uri = vscode.Uri.parse(key);
    try {
      const document = await vscode.window.showTextDocument(uri, { preview: false });
      if (line !== undefined && line > 0) {
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        document.selection = new vscode.Selection(position, position);
        document.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      }
    } catch {
      void vscode.window.showInformationMessage(`无法打开文件：${uri.fsPath}`);
    }
  }

  async reveal(key: string): Promise<void> {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(key));
  }

  private async deleteFile(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        /* ignore */
      }
    }
  }
}
