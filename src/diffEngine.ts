import { diffLines } from 'diff';
import { DiffHunk, DisplayLine, DisplayRow } from './types';
import { splitKeepEndings, stripEol } from './textUtils';

export const DIFF_CONTEXT = 3;

type OpType = ' ' | '-' | '+';

interface Op {
  type: OpType;
  value: string;
  lines: number;
  /** Line index in the OLD text *before* this op consumes any old lines. */
  oldPos: number;
  /** Line index in the NEW text *before* this op consumes any new lines. */
  newPos: number;
}

function computeOps(oldText: string, newText: string): Op[] {
  const parts = diffLines(oldText, newText);
  const ops: Op[] = [];
  let oi = 0;
  let ni = 0;
  for (const p of parts) {
    const type: OpType = p.added ? '+' : p.removed ? '-' : ' ';
    // One Op per line so that hunk grouping is measured in lines, not chunks.
    for (const line of splitKeepEndings(p.value)) {
      ops.push({ type, value: line, lines: 1, oldPos: oi, newPos: ni });
      if (type === '+') {
        ni++;
      } else if (type === '-') {
        oi++;
      } else {
        oi++;
        ni++;
      }
    }
  }
  return ops;
}

function groupOps(ops: Op[], context: number): Op[][] {
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== ' ') {
      changeIdx.push(i);
    }
  }
  if (changeIdx.length === 0) {
    return [];
  }
  const ranges: Array<[number, number]> = [];
  for (const ci of changeIdx) {
    const lo = Math.max(0, ci - context);
    const hi = Math.min(ops.length - 1, ci + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      ranges.push([lo, hi]);
    }
  }
  return ranges.map(([lo, hi]) => ops.slice(lo, hi + 1));
}

function buildHunk(group: Op[], index: number): DiffHunk {
  const oldStart = group[0].oldPos;
  const newStart = group[0].newPos;
  let oldLines = 0;
  let newLines = 0;
  const lines: DisplayLine[] = [];
  let o = oldStart;
  let n = newStart;
  for (const op of group) {
    if (op.type === ' ') {
      oldLines += op.lines;
      newLines += op.lines;
    } else if (op.type === '-') {
      oldLines += op.lines;
    } else {
      newLines += op.lines;
    }
    for (const raw of splitKeepEndings(op.value)) {
      const text = stripEol(raw);
      if (op.type === ' ') {
        lines.push({ type: ' ', text, oldLine: o + 1, newLine: n + 1 });
        o++;
        n++;
      } else if (op.type === '-') {
        lines.push({ type: '-', text, oldLine: o + 1, newLine: null });
        o++;
      } else {
        lines.push({ type: '+', text, oldLine: null, newLine: n + 1 });
        n++;
      }
    }
  }
  return {
    index,
    header: `@@ -${oldStart + 1},${oldLines} +${newStart + 1},${newLines} @@`,
    oldStart: oldStart + 1,
    oldLines,
    newStart: newStart + 1,
    newLines,
    lines,
    oldSlice: [oldStart, oldStart + oldLines],
    newSlice: [newStart, newStart + newLines],
  };
}

export function computeDiff(oldText: string, newText: string, context = DIFF_CONTEXT): DiffHunk[] {
  const groups = groupOps(computeOps(oldText, newText), context);
  return groups.map((g, i) => buildHunk(g, i));
}

/** Human-readable location for a change region, e.g. "第 12–14 行". */
export function hunkRangeLabel(hunk: DiffHunk): string {
  const start = hunk.newStart;
  if (hunk.newLines <= 0) {
    return `第 ${start} 行后`;
  }
  if (hunk.newLines === 1) {
    return `第 ${start} 行`;
  }
  return `第 ${start}–${start + hunk.newLines - 1} 行`;
}

/**
 * Flatten a whole file into renderable rows so the UI can show the complete
 * working file (unchanged lines included) with removed lines interleaved and a
 * slim action bar at each change region.
 */
export function buildUnifiedRows(baseline: string, current: string, context = DIFF_CONTEXT): DisplayRow[] {
  const hunks = computeDiff(baseline, current, context);
  const currentLines = splitKeepEndings(current).map(stripEol);
  const rows: DisplayRow[] = [];
  let newCursor = 1;
  let oldCursor = 1;

  for (const hunk of hunks) {
    while (newCursor < hunk.newStart) {
      rows.push({
        kind: 'context',
        oldLine: oldCursor,
        newLine: newCursor,
        text: currentLines[newCursor - 1] ?? '',
      });
      oldCursor++;
      newCursor++;
    }

    let additions = 0;
    let deletions = 0;
    for (const line of hunk.lines) {
      if (line.type === '+') {
        additions++;
      } else if (line.type === '-') {
        deletions++;
      }
    }
    rows.push({
      kind: 'hunk',
      hunkIndex: hunk.index,
      header: hunk.header,
      label: hunkRangeLabel(hunk),
      additions,
      deletions,
    });

    for (const line of hunk.lines) {
      if (line.type === ' ') {
        rows.push({ kind: 'context', oldLine: line.oldLine ?? 0, newLine: line.newLine ?? 0, text: line.text });
      } else if (line.type === '-') {
        rows.push({ kind: 'del', oldLine: line.oldLine ?? 0, text: line.text });
      } else {
        rows.push({ kind: 'add', newLine: line.newLine ?? 0, text: line.text });
      }
    }

    newCursor = hunk.newStart + hunk.newLines;
    oldCursor = hunk.oldStart + hunk.oldLines;
  }

  while (newCursor <= currentLines.length) {
    rows.push({
      kind: 'context',
      oldLine: oldCursor,
      newLine: newCursor,
      text: currentLines[newCursor - 1] ?? '',
    });
    oldCursor++;
    newCursor++;
  }

  return rows;
}

/** Count added/removed lines across a text pair. */
export function countChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const hunks = computeDiff(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === '+') {
        additions++;
      } else if (l.type === '-') {
        deletions++;
      }
    }
  }
  return { additions, deletions };
}

/**
 * Accept a hunk: returns the new OLD (baseline) text, where the hunk's removed
 * lines are replaced by the hunk's added lines. The working file is untouched.
 */
export function acceptHunk(oldText: string, newText: string, hunkIndex: number, context = DIFF_CONTEXT): string {
  const groups = groupOps(computeOps(oldText, newText), context);
  const group = groups[hunkIndex];
  if (!group) {
    return oldText;
  }
  const start = group[0].oldPos;
  let count = 0;
  let replacement = '';
  for (const op of group) {
    if (op.type === ' ' || op.type === '+') {
      replacement += op.value;
    }
    if (op.type === ' ' || op.type === '-') {
      count += op.lines;
    }
  }
  const oldLines = splitKeepEndings(oldText);
  return oldLines.slice(0, start).join('') + replacement + oldLines.slice(start + count).join('');
}

/**
 * Reject a hunk: returns the new NEW (working file) text, where the hunk's
 * added lines are replaced by the hunk's removed lines. The baseline is untouched.
 */
export function rejectHunk(oldText: string, newText: string, hunkIndex: number, context = DIFF_CONTEXT): string {
  const groups = groupOps(computeOps(oldText, newText), context);
  const group = groups[hunkIndex];
  if (!group) {
    return newText;
  }
  const start = group[0].newPos;
  let count = 0;
  let replacement = '';
  for (const op of group) {
    if (op.type === ' ' || op.type === '-') {
      replacement += op.value;
    }
    if (op.type === ' ' || op.type === '+') {
      count += op.lines;
    }
  }
  const newLines = splitKeepEndings(newText);
  return newLines.slice(0, start).join('') + replacement + newLines.slice(start + count).join('');
}
