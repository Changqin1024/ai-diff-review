import * as vscode from 'vscode';
import { ChangeTracker } from '../changeTracker';
import { computeDiff, hunkRangeLabel } from '../diffEngine';
import { AiReviewContentProvider } from '../diffContentProvider';

/**
 * Per-hunk review actions inside the native diff editor.
 *
 * We deliberately avoid CodeLens here: in a diff editor CodeLens occupies the
 * code line and hides the content the user is trying to read. Instead the
 * actions are exposed as clickable command links in a hover, so nothing is
 * covered. File-level and global actions live in the editor title and the
 * Review panel.
 */
export class AiReviewHoverProvider implements vscode.HoverProvider {
  constructor(private readonly tracker: ChangeTracker) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (document.uri.scheme !== AiReviewContentProvider.scheme) {
      return undefined;
    }
    const target = vscode.Uri.parse(document.uri.query);
    const side = document.uri.path.replace(/^\//, '');
    const change = this.tracker.getByKey(target.toString());
    if (!change || change.isBinary || change.tooLarge) {
      return undefined;
    }

    const hunks = computeDiff(change.baseline, change.current);
    const line = position.line;
    for (const hunk of hunks) {
      const start = (side === 'baseline' ? hunk.oldStart : hunk.newStart) - 1;
      const length = Math.max(1, side === 'baseline' ? hunk.oldLines : hunk.newLines);
      const end = Math.min(start + length - 1, document.lineCount - 1);
      if (line < start || line > end) {
        continue;
      }

      const args = encodeURIComponent(JSON.stringify([{ key: change.key, hunkIndex: hunk.index }]));
      const markdown = new vscode.MarkdownString(
        `**第 ${hunk.index + 1} / ${hunks.length} 处改动** · ${hunkRangeLabel(hunk)}\n\n` +
          `[$(check) 接受此改动](command:aiReview.acceptHunk?${args})` +
          ` &nbsp; [$(close) 拒绝此改动](command:aiReview.rejectHunk?${args})`
      );
      markdown.isTrusted = { enabledCommands: ['aiReview.acceptHunk', 'aiReview.rejectHunk'] };
      const range = new vscode.Range(start, 0, end, 0);
      return new vscode.Hover(markdown, range);
    }
    return undefined;
  }
}
