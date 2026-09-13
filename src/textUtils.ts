export const EXT_NAME = 'AI Diff Review';

/** Split text into lines, preserving the original line endings on each element. */
export function splitKeepEndings(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    out.push(text.slice(start));
  }
  return out;
}

/** Count logical lines in a chunk as produced by the `diff` package. */
export function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) {
      n++;
    }
  }
  return value.endsWith('\n') ? n : n + 1;
}

/** Strip a single trailing newline (and carriage return) for display. */
export function stripEol(value: string): string {
  return value.replace(/\r?\n$/, '');
}

export function isProbablyBinary(data: Uint8Array): boolean {
  const len = Math.min(data.length, 8000);
  for (let i = 0; i < len; i++) {
    if (data[i] === 0) {
      return true;
    }
  }
  return false;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export function decodeText(data: Uint8Array): string {
  return decoder.decode(data);
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function basename(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function dirname(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') {
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else if (c === '/') {
      re += '\\/';
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchesAny(relativePath: string, patterns: string[]): boolean {
  const posix = relativePath.replace(/\\/g, '/');
  for (const g of patterns) {
    try {
      if (globToRegExp(g).test(posix)) {
        return true;
      }
    } catch {
      /* ignore malformed patterns */
    }
  }
  return false;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
