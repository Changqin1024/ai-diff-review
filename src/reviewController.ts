import * as vscode from 'vscode';
import { BaselineStore } from './baselineStore';
import { ChangeTracker } from './changeTracker';
import {
  acceptHunk as acceptHunkText,
  buildUnifiedRows,
  computeDiff,
  rejectHunk as rejectHunkText,
} from './diffEngine';
import { AiReviewContentProvider } from './diffContentProvider';
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
    const rows = hasText ? buildUnifiedRows(change.baseline, change.current) : [];
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
    const count = await this.store.snapshotWorkspace(ignore, useGit, onlyMissing);
    await this.tracker.refreshAll();
    return count;
  }

  async reset(): Promise<number> {
    await this.store.clear();
    this.tracker.clear();
    return this.createCheckpoint(false);
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

  async reveal(key: string): Promise<void> {
    const change = this.tracker.getByKey(key);
    if (!change) {
      return;
    }
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(change.key));
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
