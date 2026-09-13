import * as vscode from 'vscode';
import { isGitRepo, listTrackedFiles, showHeadFile } from './git';
import { matchesAny, relativePathOf } from './util';

/**
 * Stores the "baseline" (pre-change) content of tracked files, one real file
 * per workspace file, mirrored under the extension storage directory:
 *
 *   <storage>/baseline/f0/src/app.ts
 *
 * Using real files keeps things transparent and lets us feed them straight to
 * the native diff editor if desired.
 */
export class BaselineStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get root(): vscode.Uri {
    return this.context.storageUri ?? this.context.globalStorageUri;
  }

  private get baselineDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'baseline');
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
  async snapshotWorkspace(ignore: string[], useGitBaseline: boolean, onlyMissing = false): Promise<number> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let count = 0;
    for (const folder of folders) {
      count += await this.snapshotFolder(folder, ignore, useGitBaseline, onlyMissing);
    }
    return count;
  }

  private async snapshotFolder(
    folder: vscode.WorkspaceFolder,
    ignore: string[],
    useGitBaseline: boolean,
    onlyMissing: boolean
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
      await this.write(file, data);
      count++;
    }
    return count;
  }
}
