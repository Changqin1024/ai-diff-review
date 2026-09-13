import * as vscode from 'vscode';
import { BaselineStore } from './baselineStore';
import { ChangeTracker } from './changeTracker';
import { decodeText } from './util';

export class AiReviewContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'ai-review';

  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** Fires when a baseline/working document changes, so open diff editors refresh. */
  readonly onDidChange = this.emitter.event;

  /** Target files whose virtual documents have been requested by a diff editor. */
  private readonly requested = new Set<string>();

  constructor(
    private readonly tracker: ChangeTracker,
    private readonly store: BaselineStore
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  static uri(side: 'baseline' | 'current', target: vscode.Uri): vscode.Uri {
    return vscode.Uri.from({
      scheme: AiReviewContentProvider.scheme,
      path: `/${side}`,
      query: target.toString(),
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = vscode.Uri.parse(uri.query);
    this.requested.add(target.toString());
    const side = uri.path.replace(/^\//, '');
    const change = this.tracker.getByKey(target.toString());

    if (change) {
      return side === 'baseline' ? change.baseline : change.current;
    }

    if (side === 'baseline') {
      const bytes = await this.store.read(target);
      return bytes ? decodeText(bytes) : '';
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      return decodeText(bytes);
    } catch {
      return '';
    }
  }

  /** Ask every open diff editor to re-read its baseline/working content. */
  fireAll(): void {
    for (const query of this.requested) {
      const target = vscode.Uri.parse(query);
      this.emitter.fire(AiReviewContentProvider.uri('baseline', target));
      this.emitter.fire(AiReviewContentProvider.uri('current', target));
    }
  }
}
