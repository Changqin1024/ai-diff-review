import * as vscode from 'vscode';
import { BaselineStore } from './baselineStore';
import { FileChange } from './types';
import { bytesEqual, isProbablyBinary, relativePathOf } from './util';
import { decodeWith } from './encoding';
import { resolveEncoding } from './encodingVSCode';
import { getWatchSettings, isExcluded, isIncluded } from './settings';

/**
 * Watches the workspace for external file mutations (e.g. an code agent writing
 * to disk) and keeps an in-memory model of files that differ from the baseline.
 */
export class ChangeTracker implements vscode.Disposable {
  private readonly changes = new Map<string, FileChange>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher?: vscode.FileSystemWatcher;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidStructure = new vscode.EventEmitter<void>();
  /** Fired (debounced) when files/folders are created or deleted. */
  readonly onDidStructureChange = this._onDidStructure.event;
  private structureTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly store: BaselineStore) {}

  /** Suppress watcher evaluation while this extension is writing to disk. */
  private readonly selfWrites = new Set<string>();

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      this.watcher.onDidChange((uri) => this.schedule(uri)),
      this.watcher.onDidCreate((uri) => {
        this.schedule(uri);
        this.scheduleStructure();
      }),
      this.watcher.onDidDelete((uri) => {
        this.schedule(uri);
        this.scheduleStructure();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('aiReview.ignore') ||
          e.affectsConfiguration('aiReview.maxTextFileKB') ||
          e.affectsConfiguration('aiReview.watch') ||
          e.affectsConfiguration('aiReview.trackBinaryFiles')
        ) {
          void this.refreshAll();
        }
        if (e.affectsConfiguration('aiReview.diffDisplay')) {
          this._onDidChange.fire();
        }
      })
    );
  }

  private scheduleStructure(): void {
    if (this.structureTimer) {
      clearTimeout(this.structureTimer);
    }
    this.structureTimer = setTimeout(() => {
      this.structureTimer = undefined;
      this._onDidStructure.fire();
    }, 900);
  }

  dispose(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
    if (this.structureTimer) {
      clearTimeout(this.structureTimer);
    }
    this._onDidStructure.dispose();
    this.watcher?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private get maxTextBytes(): number {
    return vscode.workspace.getConfiguration('aiReview').get<number>('maxTextFileKB', 4096) * 1024;
  }

  private get debounceMs(): number {
    return vscode.workspace.getConfiguration('aiReview').get<number>('debounceMs', 150);
  }

  shouldIgnore(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return true;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return true;
    }
    const relativePath = relativePathOf(folder, uri);
    const settings = getWatchSettings();
    if (!isIncluded(relativePath, settings)) {
      return true;
    }
    return isExcluded(relativePath, settings);
  }

  private schedule(uri: vscode.Uri): void {
    if (!getWatchSettings().enabled) {
      return;
    }
    if (this.shouldIgnore(uri) || this.selfWrites.has(uri.toString())) {
      return;
    }
    const key = uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.evaluate(uri);
      }, this.debounceMs)
    );
  }

  /**
   * Run `fn` while suppressing watcher reactions for `uri`. Used when we write
   * to disk during a reject operation.
   */
  async withSelfWrite<T>(uri: vscode.Uri, fn: () => Thenable<T> | Promise<T>): Promise<T> {
    const key = uri.toString();
    this.selfWrites.add(key);
    try {
      return await fn();
    } finally {
      const existing = this.timers.get(key);
      if (existing) {
        clearTimeout(existing);
        this.timers.delete(key);
      }
      setTimeout(() => this.selfWrites.delete(key), this.debounceMs * 2);
    }
  }

  get all(): FileChange[] {
    return [...this.changes.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  get count(): number {
    return this.changes.size;
  }

  getByKey(key: string): FileChange | undefined {
    return this.changes.get(key);
  }

  getByUri(uri: vscode.Uri): FileChange | undefined {
    return this.changes.get(uri.toString());
  }

  async evaluate(uri: vscode.Uri): Promise<void> {
    if (this.shouldIgnore(uri)) {
      this.remove(uri.toString());
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const key = uri.toString();

    const baselineBytes = await this.store.read(uri);
    let currentBytes: Uint8Array | undefined;
    try {
      currentBytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      currentBytes = undefined;
    }

    const maxBytes = this.maxTextBytes;
    const change = await this.buildChange(key, uri, folder, baselineBytes, currentBytes, maxBytes);
    if (!change) {
      this.remove(key);
      return;
    }
    const previous = this.changes.get(key);
    if (previous && this.sameChange(previous, change)) {
      return;
    }
    this.changes.set(key, change);
    this._onDidChange.fire();
  }

  private async buildChange(
    key: string,
    uri: vscode.Uri,
    folder: vscode.WorkspaceFolder | undefined,
    baselineBytes: Uint8Array | undefined,
    currentBytes: Uint8Array | undefined,
    maxBytes: number
  ): Promise<FileChange | undefined> {
    const relativePath = relativePathOf(folder, uri);
    if (!baselineBytes && !currentBytes) {
      return undefined;
    }

    if (baselineBytes && currentBytes && bytesEqual(baselineBytes, currentBytes)) {
      return undefined;
    }

    let status: FileChange['status'];
    if (!baselineBytes) {
      status = 'added';
    } else if (!currentBytes) {
      status = 'deleted';
    } else {
      status = 'modified';
    }

    const sample = currentBytes ?? baselineBytes ?? new Uint8Array();
    const isBinary = isProbablyBinary(sample);
    if (isBinary && !vscode.workspace.getConfiguration('aiReview').get<boolean>('trackBinaryFiles', false)) {
      return undefined;
    }
    const tooLarge = !isBinary && sample.length > maxBytes;

    const encoding = await resolveEncoding(uri, sample);
    let baseline = '';
    let current = '';
    if (!isBinary && !tooLarge) {
      baseline = baselineBytes ? decodeWith(baselineBytes, encoding) : '';
      current = currentBytes ? decodeWith(currentBytes, encoding) : '';
    }

    return { key, relativePath, status, baseline, current, isBinary, tooLarge, encoding };
  }

  private sameChange(a: FileChange, b: FileChange): boolean {
    return a.status === b.status && a.baseline === b.baseline && a.current === b.current;
  }

  private remove(key: string): void {
    if (this.changes.delete(key)) {
      this._onDidChange.fire();
    }
  }

  /** Re-evaluate every file in the workspace (and every stored baseline). */
  async refreshAll(): Promise<void> {
    if (!getWatchSettings().enabled) {
      this.clear();
      return;
    }
    const seen = new Set<string>();
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      let files: vscode.Uri[] = [];
      try {
        files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'));
      } catch {
        files = [];
      }
      for (const file of files) {
        if (this.shouldIgnore(file)) {
          continue;
        }
        seen.add(file.toString());
        await this.evaluate(file);
      }
    }
    for (const uri of await this.store.list()) {
      if (!seen.has(uri.toString()) && !this.shouldIgnore(uri)) {
        await this.evaluate(uri);
      }
    }
    this._onDidChange.fire();
  }

  clear(): void {
    if (this.changes.size > 0) {
      this.changes.clear();
      this._onDidChange.fire();
    }
  }
}
