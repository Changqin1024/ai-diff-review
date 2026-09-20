import * as crypto from 'crypto';
import * as fs from 'fs';

const CHUNK = 4096;

function digest(size: number, head: Buffer, tail: Buffer): string {
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(size >>> 0, 0);
  return crypto.createHash('sha1').update(sizeBuf).update(head).update(tail).digest('hex');
}

/** Cheap content fingerprint: size + first 4KB + last 4KB. */
export function contentHash(bytes: Uint8Array): string {
  const size = bytes.length;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = buffer.subarray(0, Math.min(CHUNK, size));
  const tail = size > CHUNK ? buffer.subarray(Math.max(0, size - CHUNK)) : Buffer.alloc(0);
  return digest(size, head, tail);
}

/** Same fingerprint as {@link contentHash}, reading only a few KB from disk. */
export async function hashFile(fsPath: string, size: number): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(fsPath, 'r');
    const headLen = Math.min(CHUNK, size);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) {
      await handle.read(head, 0, headLen, 0);
    }
    let tail = Buffer.alloc(0);
    if (size > CHUNK) {
      tail = Buffer.alloc(CHUNK);
      await handle.read(tail, 0, CHUNK, Math.max(0, size - CHUNK));
    }
    return digest(size, head, tail);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
