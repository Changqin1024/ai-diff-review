import * as vscode from 'vscode';
import { detectEncoding, matchEncoding } from './encoding';

/** Whether VS Code auto-guess encoding is enabled (for gating the option). */
export function autoGuessEnabled(): boolean {
  return vscode.workspace.getConfiguration('files').get<boolean>('autoGuessEncoding', false);
}

/** Whether VS Code auto-guess is on AND the user opted into reusing it. */
export function reuseVSCodeEncodingEnabled(): boolean {
  const optIn = vscode.workspace.getConfiguration('aiReview').get<boolean>('reuseVSCodeEncoding', false);
  return optIn && autoGuessEnabled();
}

/**
 * Resolve the encoding for a file. When reusing VS Code's auto-guess, the
 * encoding VS Code chose is identified by matching its decoded text against
 * re-decoding the raw bytes with each candidate encoding.
 */
export async function resolveEncoding(uri: vscode.Uri, raw: Uint8Array): Promise<string> {
  const fallback = detectEncoding(raw);
  if (!reuseVSCodeEncodingEnabled()) {
    return fallback;
  }
  let vsText: string;
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    vsText = document.getText();
  } catch {
    return fallback;
  }
  if (vsText.length === 0) {
    return fallback;
  }
  return matchEncoding(raw, vsText) ?? fallback;
}
