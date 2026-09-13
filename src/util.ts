import * as vscode from 'vscode';

export * from './textUtils';

export function relativePathOf(folder: vscode.WorkspaceFolder | undefined, uri: vscode.Uri): string {
  void folder;
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}
