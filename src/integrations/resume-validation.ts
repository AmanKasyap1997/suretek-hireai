import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { basename } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

/** ZIP central-directory validation distinguishes DOCX packages from arbitrary ZIPs. */
function isDocx(bytes: Buffer): boolean {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
    return false;
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    return false;
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    offset = bytes.readUInt32LE(end + 16);
  if (
    !count ||
    count > 1000 ||
    offset + size !== end ||
    bytes.readUInt16LE(end + 8) !== count
  )
    return false;
  const names = new Set<string>();
  let cursor = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      return false;
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      compressed = bytes.readUInt32LE(cursor + 20),
      uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      local = bytes.readUInt32LE(cursor + 42);
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      cursor + 46 + nameLength + extra + comment > end ||
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      return false;
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    if (
      !name ||
      names.has(name) ||
      name.startsWith('/') ||
      name.includes('..') ||
      name.includes('\\') ||
      name.includes('\0')
    )
      return false;
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtra;
    if (
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      localNameLength !== nameLength ||
      bytes
        .subarray(local + 30, local + 30 + localNameLength)
        .toString('utf8') !== name ||
      dataStart + compressed > offset
    )
      return false;
    // A data descriptor permits zero sizes/CRC in the local header. Otherwise
    // both headers must describe the exact same entry.
    for (const [localField, expected] of [
      [14, bytes.readUInt32LE(cursor + 16)],
      [18, compressed],
      [22, uncompressed],
    ]) {
      const actual = bytes.readUInt32LE(local + localField);
      if (actual !== expected && (!(flags & 8) || actual !== 0)) return false;
    }
    total += uncompressed;
    if (total > 20 * 1024 * 1024) return false;
    // Do not trust ZIP size declarations: malformed/over-expanding streams and
    // corrupt entries must fail before reaching a scanner or private storage.
    const compressedBytes = bytes.subarray(dataStart, dataStart + compressed);
    let content: Buffer;
    try {
      content =
        method === 0
          ? compressedBytes
          : inflateRawSync(compressedBytes, {
              maxOutputLength: Math.max(uncompressed, 1),
            });
    } catch {
      return false;
    }
    if (
      content.length !== uncompressed ||
      crc32(content) !== bytes.readUInt32LE(cursor + 16)
    )
      return false;
    names.add(name);
    cursor += 46 + nameLength + extra + comment;
  }
  return (
    cursor === end &&
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'].every((name) =>
      names.has(name),
    )
  );
}
export function validateResume(name: string, bytes: Buffer, maxBytes: number) {
  if (!bytes.length) throw new BadRequestException('Resume is empty');
  if (bytes.length > maxBytes)
    throw new PayloadTooLargeException('Resume exceeds size limit');
  const filename = basename(name.replace(/\\/g, '/'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-150);
  const extension = filename.toLowerCase().split('.').pop();
  if (
    extension === 'pdf' &&
    /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'))
  )
    return { filename, contentType: 'application/pdf' };
  if (extension === 'docx' && isDocx(bytes))
    return {
      filename,
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  throw new BadRequestException('Only valid PDF or DOCX resumes are allowed');
}
