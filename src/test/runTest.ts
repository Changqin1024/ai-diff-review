import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  // Create a throw-away workspace so no fixtures need to live in the repo.
  const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-diff-review-test-'));
  fs.writeFileSync(path.join(testWorkspace, 'sample.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(testWorkspace, 'second.txt'), 'one\ntwo\n');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testWorkspace, '--disable-extensions', '--disable-gpu'],
    });
  } finally {
    try {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((error) => {
  console.error('Integration test run failed:', error);
  process.exit(1);
});
