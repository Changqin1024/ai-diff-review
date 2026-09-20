import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const normalize = (value: string): string => value.replace(/\r\n/g, '\n');

function virtualUri(side: 'baseline' | 'current', target: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'ai-review', path: `/${side}`, query: target });
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .map((h) =>
      h.contents
        .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
        .join('\n')
    )
    .join('\n');
}

suite('AI Diff Review', () => {
  test('captures, rejects and accepts changes end to end', async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON && e.packageJSON.name === 'ai-diff-review');
    assert.ok(ext, 'extension should be installed in the dev host');
    await ext!.activate();

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'test workspace should be open');
    const filePath = path.join(folder!.uri.fsPath, 'sample.txt');
    const file2Path = path.join(folder!.uri.fsPath, 'second.txt');
    const uriString = vscode.Uri.file(filePath).toString();
    const uri2String = vscode.Uri.file(file2Path).toString();
    const read = (p: string): string => fs.readFileSync(p, 'utf8');

    const baseline = 'alpha\nbeta\ngamma\n';
    fs.writeFileSync(filePath, baseline);
    fs.writeFileSync(file2Path, 'one\ntwo\n');
    await vscode.commands.executeCommand('aiReview.reset');
    await delay(400);

    // 1) reject restores the baseline
    fs.writeFileSync(filePath, 'alpha\nCHANGED-1\ngamma\n');
    await delay(1200);
    await vscode.commands.executeCommand('aiReview.rejectFile', uriString);
    await delay(400);
    assert.strictEqual(read(filePath), baseline, 'rejectFile should restore the baseline');

    // 2) accept advances the baseline and leaves the working copy alone
    fs.writeFileSync(filePath, 'alpha\nACCEPTED\ngamma\n');
    await delay(1200);
    await vscode.commands.executeCommand('aiReview.acceptFile', uriString);
    await delay(400);
    assert.strictEqual(read(filePath), 'alpha\nACCEPTED\ngamma\n', 'acceptFile should keep the working copy');

    // 3) a later reject returns to the accepted state, proving the baseline moved
    fs.writeFileSync(filePath, 'alpha\nACCEPTED\nREJECTED\ngamma\n');
    await delay(1200);
    await vscode.commands.executeCommand('aiReview.rejectFile', uriString);
    await delay(400);
    assert.strictEqual(read(filePath), 'alpha\nACCEPTED\ngamma\n', 'accepted content should be the new baseline');

    // 4) per-hunk reject only reverts the selected hunk
    fs.writeFileSync(filePath, 'X-alpha\nACCEPTED\ngamma\n');
    await delay(1200);
    await vscode.commands.executeCommand('aiReview.rejectHunk', { key: uriString, hunkIndex: 0 });
    await delay(400);
    assert.strictEqual(read(filePath), 'alpha\nACCEPTED\ngamma\n', 'rejectHunk should revert one hunk');

    // 5) the native diff exposes virtual baseline / working documents
    fs.writeFileSync(filePath, 'alpha\nHOVER\ngamma\n');
    await delay(1200);
    const currentUri = virtualUri('current', uriString);
    const baselineUri = virtualUri('baseline', uriString);
    const curDoc = await vscode.workspace.openTextDocument(currentUri);
    const baseDoc = await vscode.workspace.openTextDocument(baselineUri);
    assert.strictEqual(normalize(baseDoc.getText()), 'alpha\nACCEPTED\ngamma\n', 'baseline document content');
    assert.strictEqual(normalize(curDoc.getText()), 'alpha\nHOVER\ngamma\n', 'working document content');

    // 6) per-hunk actions are exposed as non-covering hover links
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      currentUri,
      new vscode.Position(1, 0)
    );
    const text = hoverText(hovers);
    assert.ok(/接受此改动/.test(text), `hover should offer accept, got: ${text}`);
    assert.ok(/拒绝此改动/.test(text), 'hover should offer reject');

    // 7) the diff content refreshes live when the file changes on disk
    fs.writeFileSync(filePath, 'alpha\nLIVE\ngamma\n');
    await delay(1200);
    assert.strictEqual(normalize(curDoc.getText()), 'alpha\nLIVE\ngamma\n', 'working side refreshed live');

    // 8) a pending diff tab exists, then closes and clears once accepted
    await vscode.commands.executeCommand('aiReview.openDiff', uriString);
    await delay(600);
    const hasDiffTab = (): boolean =>
      vscode.window.tabGroups.all.some((g) =>
        g.tabs.some(
          (t) =>
            t.input instanceof vscode.TabInputTextDiff &&
            (t.input.original.scheme === 'ai-review' || t.input.modified.scheme === 'ai-review')
        )
      );
    assert.ok(hasDiffTab(), 'diff tab should be open for the pending file');
    await vscode.commands.executeCommand('aiReview.acceptHunk', { key: uriString, hunkIndex: 0 });
    await delay(800);
    assert.strictEqual(read(filePath), 'alpha\nLIVE\ngamma\n', 'accept must not revert the working copy');
    assert.ok(!hasDiffTab(), 'diff tab should close once the file is fully reviewed');
    const baseDocAfter = await vscode.workspace.openTextDocument(baselineUri);
    assert.strictEqual(
      normalize(baseDocAfter.getText()),
      'alpha\nLIVE\ngamma\n',
      'baseline advanced live'
    );

    // 9) global Accept All covers every file and never reverts the working copy
    fs.writeFileSync(filePath, 'alpha\nGLOBAL1\ngamma\n');
    fs.writeFileSync(file2Path, 'one\nGLOBAL2\n');
    await delay(1400);
    await vscode.commands.executeCommand('aiReview.openDiff', uriString);
    await delay(400);
    await vscode.commands.executeCommand('aiReview.acceptAll');
    await delay(800);
    assert.strictEqual(read(filePath), 'alpha\nGLOBAL1\ngamma\n', 'acceptAll keeps file 1 working copy');
    assert.strictEqual(read(file2Path), 'one\nGLOBAL2\n', 'acceptAll keeps file 2 working copy');
    const base2 = await vscode.workspace.openTextDocument(virtualUri('baseline', uri2String));
    const cur2 = await vscode.workspace.openTextDocument(virtualUri('current', uri2String));
    assert.strictEqual(normalize(base2.getText()), normalize(cur2.getText()), 'file 2 diff cleared');
    assert.ok(!hasDiffTab(), 'diff tabs cleared after global accept');

    // 10) the review panel can be opened without throwing
    await vscode.commands.executeCommand('aiReview.openReview');
    await delay(400);

    // 11) renaming a file moves its baseline instead of delete + rebuild
    fs.writeFileSync(filePath, 'alpha\nRENAME_BASE\ngamma\n');
    await delay(1200);
    await vscode.commands.executeCommand('aiReview.acceptFile', uriString);
    await delay(400);
    const renamedPath = path.join(folder!.uri.fsPath, 'renamed-sample.txt');
    fs.renameSync(filePath, renamedPath);
    await delay(2200);
    const renamedUriString = vscode.Uri.file(renamedPath).toString();
    const renamedBase = await vscode.workspace.openTextDocument(virtualUri('baseline', renamedUriString));
    assert.strictEqual(
      normalize(renamedBase.getText()),
      'alpha\nRENAME_BASE\ngamma\n',
      'baseline should be moved to the renamed path'
    );
    fs.renameSync(renamedPath, filePath);
    await delay(800);
  });
});
