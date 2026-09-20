import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { matchesAny } from './textUtils';

export interface WatchSettings {
  enabled: boolean;
  /** Workspace-relative paths (files or folders) to watch. Empty = whole workspace. */
  paths: string[];
  /** Workspace-relative paths or globs to ignore, independent from the global ignore list. */
  exclude: string[];
}

export function normalizePath(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

let pathsCache: { key: string; value: string[]; at: number } | undefined;

export function invalidatePathCache(): void {
  pathsCache = undefined;
}

/**
 * Keep only the configured paths that currently exist. If none of them exist,
 * an empty list is returned which means "whole workspace" (fallback).
 */
function existingPaths(configured: string[]): string[] {
  if (configured.length === 0) {
    return [];
  }
  const key = configured.join('\u0000');
  const now = Date.now();
  if (pathsCache && pathsCache.key === key && now - pathsCache.at < 1500) {
    return pathsCache.value;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const value: string[] = [];
  for (const entry of configured) {
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      try {
        if (fs.existsSync(path.join(folder.uri.fsPath, entry))) {
          value.push(entry);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  pathsCache = { key, value, at: now };
  return value;
}

export function getWatchSettings(): WatchSettings {
  const config = vscode.workspace.getConfiguration('aiReview');
  const configured = (config.get<string[]>('watch.paths', []) ?? []).map(normalizePath).filter((p) => p.length > 0);
  return {
    enabled: config.get<boolean>('watch.enabled', true),
    paths: existingPaths(configured),
    exclude: (config.get<string[]>('watch.exclude', []) ?? []).map(normalizePath).filter((p) => p.length > 0),
  };
}

export function getGlobalIgnore(): string[] {
  return vscode.workspace.getConfiguration('aiReview').get<string[]>('ignore', []);
}

/** Match a workspace-relative path against a folder/file path or a glob pattern. */
export function matchesEntry(relativePath: string, entry: string): boolean {
  const rel = normalizePath(relativePath);
  if (/[*?[\]{}]/.test(entry)) {
    try {
      return matchesAny(rel, [entry]);
    } catch {
      return false;
    }
  }
  const e = normalizePath(entry);
  return rel === e || rel.startsWith(`${e}/`);
}

export function isExcluded(relativePath: string, settings: WatchSettings): boolean {
  if (matchesAny(relativePath, getGlobalIgnore())) {
    return true;
  }
  return settings.exclude.some((entry) => matchesEntry(relativePath, entry));
}

export function isIncluded(relativePath: string, settings: WatchSettings): boolean {
  if (settings.paths.length === 0) {
    return true;
  }
  return settings.paths.some((entry) => matchesEntry(relativePath, entry));
}

/**
 * A single glob for `workspace.findFiles`'s exclude so we never enumerate
 * ignored trees like node_modules. Returns undefined when nothing to exclude.
 */
export function enumerationExclude(): string | undefined {
  const patterns = new Set<string>(getGlobalIgnore());
  const settings = getWatchSettings();
  for (const entry of settings.exclude) {
    if (/[*?[\]{}]/.test(entry)) {
      patterns.add(entry);
    } else {
      patterns.add(entry);
      patterns.add(`${entry}/**`);
    }
  }
  const list = [...patterns].filter((p) => p.length > 0);
  return list.length > 0 ? `{${list.join(',')}}` : undefined;
}
