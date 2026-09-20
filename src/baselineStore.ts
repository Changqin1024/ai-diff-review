import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { isGitRepo, listTrackedFiles, showHeadFile } from './git';
import { matchesAny, relativePathOf, isProbablyBinary } from './util';

export interface BaselineMeta {
  /** Workspace folder fsPaths recorded when the baselines were captured. */
  folders: string[];
  /** Effective watch paths recorded when the baselines were captured. */
  paths: string[];
}

function sameFsPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * Stores the "baseline" (pre-change) content of tracked files, one real file
 * per workspace file, mirrored under a storage directory:
 *
 *   <root>/baseline/f0/src/app.ts
 *
 * The root defaults to the extension storage but can be pointed at a custom
 * cache directory (`aiReview.cacheDir`); changing it moves the data.
 */
export class BaselineStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Stable pointer file that always lives in the extension storage. */
  private get pointerFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, 'cache-location.json');
  }

  private get defaultRoot(): vscode.Uri {
    return this.context.storageUri ?? this.context.globalStorageUri;
  }

  private namespace(): string {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join('|');
    return crypto.createHash('sha1').update(folders || 'no-workspace').digest('hex').slice(0, 12);
  }

  /** Where the baselines actually live right now. */
  private get dataRoot(): vscode.Uri {
    const configured = (vscode.workspace.getConfiguration('aiReview').get<string>('cacheDir', '') ?? '').trim();
    if (!configured) {
      return this.defaultRoot;
    }
    let base: vscode.Uri;
    if (path.isAbsolute(configured)) {
      base = vscode.Uri.file(configured);
    } else {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return this.defaultRoot;
      }
      base = vscode.Uri.joinPath(folder.uri, ...configured.split(/[\\/]/).filter((s) => s.length > 0));
    }
    return vscode.Uri.joinPath(base, this.namespace());
  }

  private get baselineDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.dataRoot, 'baseline');
  }

  private async readPointer(): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.pointerFile);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { root?: unknown };
      return typeof parsed.root === 'string' ? parsed.root : undefined;
    } catch {
      return undefined;
    }
  }

  private async writePointer(root: string): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.defaultRoot);
      await vscode.workspace.fs.writeFile(
        this.pointerFile,
        new TextEncoder().encode(JSON.stringify({ root }, null, 2))
      );
    } catch {
      /* ignore */
    }
  }

  /** Move stored baselines when the configured cache directory changed. */
  async relocate(): Promise<boolean> {
    const pointer = await this.readPointer();
    const current = this.dataRoot.fsPath;
    const previous = pointer ?? this.defaultRoot.fsPath;
    if (sameFsPath(previous, current)) {
      if (!pointer) {
        await this.writePointer(current);
      }
      return false;
    }
    const fromRoot = vscode.Uri.file(previous);
    await this.movePath(vscode.Uri.joinPath(fromRoot, 'baseline'), this.baselineDir);
    await this.movePath(vscode.Uri.joinPath(fromRoot, 'workspace-folders.json'), this.metaFile);
    await this.writePointer(current);
    return true;
  }

  private async movePath(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    let fromExists = true;
    try {
      await vscode.workspace.fs.stat(from);
    } catch {
      fromExists = false;
    }
    if (!fromExists) {
      return;
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(to, '..'));
    } catch {
      /* ignore */
    }
    try {
      await vscode.workspace.fs.rename(from, to, { overwrite: true });
      return;
    } catch {
      /* fall through to copy + delete (e.g. across drives) */
    }
    await this.copyRecursive(from, to);
    try {
      await vscode.workspace.fs.delete(from, { recursive: true, useTrash: false });
    } catch {
      /* ignore */
    }
  }

  private async copyRecursive(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const stat = await vscode.workspace.fs.stat(from);
    if (stat.type === vscode.FileType.Directory) {
      await vscode.workspace.fs.createDirectory(to);
      for (const [name] of await vscode.workspace.fs.readDirectory(from)) {
        await this.copyRecursive(vscode.Uri.joinPath(from, name), vscode.Uri.joinPath(to, name));
      }
    } else {
      const bytes = await vscode.workspace.fs.readFile(from);
      await vscode.workspace.fs.writeFile(to, bytes);
    }
  }

  private folderIndex(uri: vscode.Uri): number {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return -1;
    }
    return vscode.workspace.workspaceFolders?.indexOf(folder) ?? -1;
  }

  uriFor(uri: vscode.Uri): vscode.Uri {
    const idx = this.folderIndex(uri);
    const rel = relativePathOf(vscode.workspace.getWorkspaceFolder(uri), uri);
    const segments = rel.split('/').filter((s) => s.length > 0);
    return vscode.Uri.joinPath(this.baselineDir, `f${idx}`, ...segments);
  }

  async has(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.uriFor(uri));
      return true;
    } catch {
      return false;
    }
  }

  async read(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(this.uriFor(uri));
    } catch {
      return undefined;
    }
  }

  async write(uri: vscode.Uri, data: Uint8Array): Promise<void> {
    const target = this.uriFor(uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, data);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uriFor(uri));
    } catch {
      /* ignore */
    }
  }

  async clear(): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.baselineDir, { recursive: true, useTrash: false });
    } catch {
      /* ignore */
    }
  }

  private get metaFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.dataRoot, 'workspace-folders.json');
  }

  /** Metadata recorded when the baselines were captured. */
  async readMeta(): Promise<BaselineMeta | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.metaFile);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { folders?: unknown; paths?: unknown };
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
      return { folders: strings(parsed.folders), paths: strings(parsed.paths) };
    } catch {
      /* ignore */
    }
    return undefined;
  }

  async writeMeta(meta: BaselineMeta): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.dataRoot);
      await vscode.workspace.fs.writeFile(
        this.metaFile,
        new TextEncoder().encode(JSON.stringify(meta, null, 2))
      );
    } catch {
      /* ignore */
    }
  }

  /** Move a stored baseline from one workspace path to another (rename/move). */
  async move(from: vscode.Uri, to: vscode.Uri): Promise<boolean> {
    const bytes = await this.read(from);
    if (!bytes) {
      return false;
    }
    await this.write(to, bytes);
    await this.delete(from);
    return true;
  }

  /** Delete baselines whose corresponding workspace file no longer exists. */
  async pruneMissing(): Promise<number> {
    const uris = await this.list();
    let removed = 0;
    for (const uri of uris) {
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }
      if (!exists) {
        await this.delete(uri);
        removed++;
      }
    }
    return removed;
  }

  /** Delete baselines whose workspace-relative path matches the predicate. */
  async deleteMatching(
    relativeOf: (uri: vscode.Uri) => string | undefined,
    match: (relativePath: string) => boolean
  ): Promise<number> {
    const uris = await this.list();
    let removed = 0;
    for (const uri of uris) {
      const relative = relativeOf(uri);
      if (relative && match(relative)) {
        await this.delete(uri);
        removed++;
      }
    }
    return removed;
  }

  /** Enumerate every URI that currently has a stored baseline. */
  async list(): Promise<vscode.Uri[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const result: vscode.Uri[] = [];
    for (let i = 0; i < folders.length; i++) {
      const dir = vscode.Uri.joinPath(this.baselineDir, `f${i}`);
      await this.walk(dir, dir, folders[i], result);
    }
    return result;
  }

  private async walk(
    dir: vscode.Uri,
    base: vscode.Uri,
    folder: vscode.WorkspaceFolder,
    out: vscode.Uri[]
  ): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        await this.walk(child, base, folder, out);
      } else {
        const relSegments = child.path.slice(base.path.length + 1).split('/');
        out.push(vscode.Uri.joinPath(folder.uri, ...relSegments));
      }
    }
  }

  /** Capture the current state of the whole workspace as the new baseline. */
  async snapshotWorkspace(
    ignore: string[],
    useGitBaseline: boolean,
    onlyMissing = false,
    include?: (relativePath: string) => boolean,
    skipBinary = false
  ): Promise<number> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let count = 0;
    for (const folder of folders) {
      count += await this.snapshotFolder(folder, ignore, useGitBaseline, onlyMissing, include, skipBinary);
    }
    return count;
  }

  private async snapshotFolder(
    folder: vscode.WorkspaceFolder,
    ignore: string[],
    useGitBaseline: boolean,
    onlyMissing: boolean,
    include?: (relativePath: string) => boolean,
    skipBinary = false
  ): Promise<number> {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'));
    let count = 0;

    let gitRepo = false;
    let tracked = new Set<string>();
    if (useGitBaseline) {
      gitRepo = await isGitRepo(folder.uri.fsPath);
      if (gitRepo) {
        tracked = new Set((await listTrackedFiles(folder.uri.fsPath)).map((p) => p.replace(/\\/g, '/')));
      }
    }

    for (const file of files) {
      const rel = relativePathOf(folder, file);
      if (matchesAny(rel, ignore)) {
        continue;
      }
      if (include && !include(rel)) {
        continue;
      }
      if (onlyMissing && (await this.has(file))) {
        continue;
      }
      let data: Uint8Array | undefined;
      if (gitRepo && tracked.has(rel)) {
        data = await showHeadFile(folder.uri.fsPath, rel);
      }
      if (!data) {
        try {
          data = await vscode.workspace.fs.readFile(file);
        } catch {
          continue;
        }
      }
      if (skipBinary && isProbablyBinary(data)) {
        continue;
      }
      await this.write(file, data);
      count++;
    }
    return count;
  }

  /** Number of stored baseline files and their total size, for the current workspace. */
  async stats(): Promise<{ files: number; bytes: number }> {    let files = 0;
    let bytes = 0;
    const walk = async (dir: vscode.Uri): Promise<void> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      for (const [name, type] of entries) {
        const child = vscode.Uri.joinPath(dir, name);
        if (type === vscode.FileType.Directory) {
          await walk(child);
        } else {
          try {
            const stat = await vscode.workspace.fs.stat(child);
            files++;
            bytes += stat.size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    await walk(this.baselineDir);
    return { files, bytes };
  }
}
