import * as iconv from 'iconv-lite';
import * as jschardet from 'jschardet';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8', { fatal: false });

const ALIASES: Record<string, string> = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  'gbk': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'big5-hkscs': 'big5',
  'shift-jis': 'shift_jis',
  'sjis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'windows-1252': 'windows-1252',
  'iso-8859-1': 'latin1',
};

/** Candidate encodings used when matching VS Code's guessed text back to bytes. */
export const CANDIDATES = [
  'utf-8',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'windows-1252',
  'utf-16le',
  'utf-16be',
];

function normalizeEncoding(name: string | null | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const key = name.toLowerCase().replace(/_/g, '-');
  const mapped = ALIASES[key] ?? key;
  return iconv.encodingExists(mapped) ? mapped : undefined;
}

/** Best-effort detection of a file's text encoding. Always returns a usable name. */
export function detectEncoding(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return 'utf-8';
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return 'utf-16le';
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return 'utf-16be';
  }
  try {
    utf8Strict.decode(data);
    return 'utf-8';
  } catch {
    /* not valid utf-8 — try detection */
  }
  try {
    const sample = data.length > 65536 ? data.subarray(0, 65536) : data;
    const guess = jschardet.detect(Buffer.from(sample)) as { encoding?: string | null } | null;
    const normalized = normalizeEncoding(guess?.encoding);
    if (normalized) {
      return normalized;
    }
  } catch {
    /* ignore */
  }
  return 'utf-8';
}

export function decodeWith(data: Uint8Array, encoding: string): string {
  try {
    return iconv.decode(Buffer.from(data), encoding);
  } catch {
    return utf8Loose.decode(data);
  }
}

export function encodeWith(text: string, encoding: string): Uint8Array {
  try {
    return iconv.encode(text, encoding);
  } catch {
    return new TextEncoder().encode(text);
  }
}

const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');

/**
 * Find which candidate encoding decodes `raw` into the same text VS Code
 * produced (EOL-insensitive). Used to identify VS Code's guessed encoding.
 */
export function matchEncoding(raw: Uint8Array, targetText: string): string | undefined {
  const target = normalizeEol(targetText);
  for (const candidate of CANDIDATES) {
    try {
      if (normalizeEol(iconv.decode(Buffer.from(raw), candidate)) === target) {
        return candidate;
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}
