export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface DisplayLine {
  type: ' ' | '-' | '+';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DisplayLine[];
  /** [start, end) line indices into the OLD text used to splice on accept. */
  oldSlice: [number, number];
  /** [start, end) line indices into the NEW text used to splice on reject. */
  newSlice: [number, number];
}

export interface FileChange {
  /** Stable key: the workspace file URI as a string. */
  key: string;
  relativePath: string;
  status: ChangeStatus;
  baseline: string;
  current: string;
  isBinary: boolean;
  /** True when the file body is too large to diff hunk by hunk. */
  tooLarge: boolean;
  /** Detected text encoding of the file (e.g. "utf-8", "gbk"). */
  encoding: string;
}

export type DisplayRow =
  | { kind: 'context'; oldLine: number; newLine: number; text: string }
  | { kind: 'del'; oldLine: number; text: string }
  | { kind: 'add'; newLine: number; text: string }
  | { kind: 'hunk'; hunkIndex: number; header: string; label: string; additions: number; deletions: number };

export interface FileChangeView {
  key: string;
  uriString: string;
  relativePath: string;
  fileName: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  tooLarge: boolean;
  hunks: DiffHunk[];
}

/**
 * A single file as shown in the review panel. Either it still has pending
 * changes (with hunk action bars) or it has been fully resolved, in which case
 * `rows` contains the final whole-file content and `pending` is false.
 */
export interface PanelFile {
  key: string;
  relativePath: string;
  status: ChangeStatus | 'unchanged';
  additions: number;
  deletions: number;
  isBinary: boolean;
  tooLarge: boolean;
  rows: DisplayRow[];
  pending: boolean;
  note: string;
}
