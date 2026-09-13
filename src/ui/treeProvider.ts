import * as vscode from 'vscode';
import { ReviewController } from '../reviewController';
import { ChangeTracker } from '../changeTracker';
import { DiffHunk, FileChangeView } from '../types';
import { hunkRangeLabel } from '../diffEngine';
import { dirname } from '../util';

export interface FileNode {
  kind: 'file';
  key: string;
  view: FileChangeView;
}

export interface HunkNode {
  kind: 'hunk';
  key: string;
  hunkIndex: number;
  view: FileChangeView;
  hunk: DiffHunk;
}

export type ReviewNode = FileNode | HunkNode;

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

export class ChangesTreeProvider implements vscode.TreeDataProvider<ReviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReviewNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly controller: ReviewController,
    private readonly tracker: ChangeTracker
  ) {
    this.tracker.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ReviewNode): vscode.TreeItem {
    if (element.kind === 'file') {
      return this.fileItem(element);
    }
    return this.hunkItem(element);
  }

  getChildren(element?: ReviewNode): ReviewNode[] {
    if (!element) {
      return this.controller.getViews().map((view) => ({ kind: 'file' as const, key: view.key, view }));
    }
    if (element.kind === 'file') {
      return element.view.hunks.map((hunk) => ({
        kind: 'hunk' as const,
        key: element.key,
        hunkIndex: hunk.index,
        view: element.view,
        hunk,
      }));
    }
    return [];
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { view } = node;
    const item = new vscode.TreeItem(view.fileName, vscode.TreeItemCollapsibleState.Expanded);
    const dir = dirname(view.relativePath);
    const counts = `+${view.additions} −${view.deletions}`;
    item.description = dir ? `${dir}  ${counts}` : counts;
    item.tooltip = new vscode.MarkdownString(
      `**${view.relativePath}**\n\n状态：\`${view.status}\`  \`${counts}\``
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
