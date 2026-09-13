import { execFile } from 'child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: '', stderr: stderr ? stderr.toString('utf8') : String(error.message) });
        return;
      }
      resolve({ ok: true, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

export async function listTrackedFiles(cwd: string): Promise<string[]> {
  const res = await runGit(cwd, ['ls-files', '-z']);
  if (!res.ok) {
    return [];
  }
  return res.stdout.split('\0').filter((s) => s.length > 0);
}

export async function showHeadFile(cwd: string, relativePath: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['show', `HEAD:${relativePath.replace(/\\/g, '/')}`],
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(new Uint8Array(stdout));
      }
    );
  });
}
