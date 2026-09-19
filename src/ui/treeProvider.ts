import * as vscode from 'vscode';
import { ReviewController } from '../reviewController';
import { ChangeTracker } from '../changeTracker';
import { hunkRangeLabel } from '../diffEngine';
import { DiffHunk, FileChangeView } from '../types';

export interface FolderNode {
  kind: 'folder';
  id: string;
  name: string;
  relPath: string;
  children: ReviewNode[];
}

export interface FileNode {
  kind: 'file';
  key: string;
  view: FileChangeView;
  children: HunkNode[];
}

export interface HunkNode {
  kind: 'hunk';
  key: string;
  hunkIndex: number;
  view: FileChangeView;
  hunk: DiffHunk;
  children: [];
}

export type ReviewNode = FolderNode | FileNode | HunkNode;

function statusIcon(status: FileChangeView['status']): vscode.ThemeIcon {
  switch (status) {
    case 'added':
      return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    case 'deleted':
      return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
    default:
      return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
  }
}

interface FolderSummary {
  files: number;
  additions: number;
  deletions: number;
}

function summarize(node: ReviewNode): FolderSummary {
  if (node.kind === 'file') {
    return { files: 1, additions: node.view.additions, deletions: node.view.deletions };
  }
  if (node.kind === 'hunk') {
    return { files: 0, additions: 0, deletions: 0 };
  }
  const total: FolderSummary = { files: 0, additions: 0, deletions: 0 };
  for (const child of node.children) {
    const s = summarize(child);
    total.files += s.files;
    total.additions += s.additions;
    total.deletions += s.deletions;
  }
  return total;
}

/** Folders before files, then alphabetical (numeric-aware). */
function sortNodes(nodes: ReviewNode[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.kind === 'folder' ? 0 : 1;
    const bFolder = b.kind === 'folder' ? 0 : 1;
    if (aFolder !== bFolder) {
      return aFolder - bFolder;
    }
    const an = a.kind === 'file' ? a.view.fileName : a.kind === 'folder' ? a.name : '';
    const bn = b.kind === 'file' ? b.view.fileName : b.kind === 'folder' ? b.name : '';
    return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
  });
  for (const node of nodes) {
    if (node.kind === 'folder') {
      sortNodes(node.children);
    }
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ReviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReviewNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: ReviewNode[] = [];

  constructor(
    private readonly controller: ReviewController,
    private readonly tracker: ChangeTracker
  ) {
    this.tracker.onDidChange(() => this.refresh());
    this.rebuild();
  }

  refresh(): void {
    this.rebuild();
    this._onDidChangeTreeData.fire();
  }

  /** Group pending files into a folder tree: folder → file → change region. */
  private rebuild(): void {
    const root: FolderNode = { kind: 'folder', id: 'folder:', name: '', relPath: '', children: [] };

    for (const view of this.controller.getViews()) {
      const parts = view.relativePath.split('/').filter((p) => p.length > 0);
      parts.pop(); // drop the file name; remaining parts are folders

      const hunks: HunkNode[] = view.hunks.map((hunk) => ({
        kind: 'hunk',
        key: view.key,
        hunkIndex: hunk.index,
        view,
        hunk,
        children: [],
      }));
      const fileNode: FileNode = { kind: 'file', key: view.key, view, children: hunks };

      let cursor = root;
      for (const part of parts) {
        let folder = cursor.children.find(
          (c): c is FolderNode => c.kind === 'folder' && c.name === part
        );
        if (!folder) {
          const relPath = cursor.relPath ? `${cursor.relPath}/${part}` : part;
          folder = { kind: 'folder', id: `folder:${relPath}`, name: part, relPath, children: [] };
          cursor.children.push(folder);
        }
        cursor = folder;
      }
      cursor.children.push(fileNode);
    }

    sortNodes(root.children);
    this.roots = root.children;
  }

  getTreeItem(element: ReviewNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      return this.folderItem(element);
    }
    if (element.kind === 'file') {
      return this.fileItem(element);
    }
    return this.hunkItem(element);
  }

  getChildren(element?: ReviewNode): ReviewNode[] {
    if (!element) {
      return this.roots;
    }
    return element.children;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    const summary = summarize(node);
    item.description = `${summary.files} 个文件  +${summary.additions} −${summary.deletions}`;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.contextValue = 'changeFolder';
    item.tooltip = new vscode.MarkdownString(
      `**${node.relPath}/**\n\n${summary.files} 个文件  \`+${summary.additions} −${summary.deletions}\``
    );
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { view } = node;
    const item = new vscode.TreeItem(view.fileName, vscode.TreeItemCollapsibleState.Expanded);
    item.description = `+${view.additions} −${view.deletions}`;
    item.tooltip = new vscode.MarkdownString(
      `**${view.relativePath}**\n\n状态：\`${view.status}\`  \`+${view.additions} −${view.deletions}\``
    );
    item.iconPath = statusIcon(view.status);
    item.contextValue = 'changeFile';
    item.resourceUri = vscode.Uri.parse(view.uriString);
    item.command = {
      command: 'aiReview.openReview',
      title: '审查文件',
      arguments: [{ key: node.key }],
    };
    return item;
  }

  private hunkItem(node: HunkNode): vscode.TreeItem {
    const item = new vscode.TreeItem(hunkRangeLabel(node.hunk), vscode.TreeItemCollapsibleState.None);
    const added = node.hunk.lines.filter((l) => l.type === '+').length;
    const removed = node.hunk.lines.filter((l) => l.type === '-').length;
    item.description = `+${added} −${removed}`;
    item.iconPath = new vscode.ThemeIcon('diff-modified');
    item.contextValue = 'changeHunk';
    item.tooltip = new vscode.MarkdownString(
      `第 ${node.hunkIndex + 1} 处改动 · ${hunkRangeLabel(node.hunk)}\n\n\`${node.hunk.header}\``
    );
    item.command = {
      command: 'aiReview.openReview',
      title: '跳转到此改动',
      arguments: [{ key: node.key, hunkIndex: node.hunkIndex }],
    };
    return item;
  }
}
