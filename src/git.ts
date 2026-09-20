import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Cheap check for a git repository that does not spawn git. */
export function isGitFolder(folderPath: string): boolean {
  try {
    return fs.existsSync(path.join(folderPath, '.git'));
  } catch {
    return false;
  }
}

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

export interface GitRename {
  from: string;
  to: string;
}

/** All paths reported by `git status` (changed, staged, deleted, untracked, renamed). */
export async function gitStatusPaths(cwd: string): Promise<string[]> {
  const res = await runGit(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z']);
  if (!res.ok) {
    return [];
  }
  const parts = res.stdout.split('\0').filter((s) => s.length > 0);
  const paths = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    const status = record.slice(0, 2);
    paths.add(record.slice(3).replace(/\\/g, '/'));
    if (/[RC]/.test(status)) {
      const source = parts[++i];
      if (source !== undefined) {
        paths.add(source.replace(/\\/g, '/'));
      }
    }
  }
  return [...paths];
}

/** Detect renames/moves (including content edits) from git status. */
export async function gitRenames(cwd: string): Promise<GitRename[]> {
  const res = await runGit(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-M', '-z']);
  if (!res.ok) {
    return [];
  }
  const parts = res.stdout.split('\0').filter((s) => s.length > 0);
  const renames: GitRename[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    const status = record.slice(0, 2);
    const target = record.slice(3);
    if (/[RC]/.test(status)) {
      const source = parts[++i];
      if (source !== undefined) {
        renames.push({ from: source.replace(/\\/g, '/'), to: target.replace(/\\/g, '/') });
      }
    }
  }
  return renames;
}
