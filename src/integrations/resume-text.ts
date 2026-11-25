import { inflateRawSync } from 'node:zlib';

/** The resume's text could not be read. Never carries file content. */
export class ResumeTextError extends Error {
  constructor(reason: string) {
    super(`Resume text could not be read: ${reason}`);
  }
}

const DOCUMENT_XML = 'word/document.xml';
/** Generous for any resume; bounds decompression of a hostile file. */
const MAX_XML_BYTES = 8 * 1024 * 1024;

/**
 * The body text of a .docx file. A .docx file is a ZIP archive; its text is in
 * word/document.xml. Only that one entry is read, through the central
 * directory, and decompression is capped, so a "zip bomb" fails safely.
 */
export function docxText(file: Buffer, maxChars = 60_000): string {
  let xml: string;
  try {
    xml = zipEntry(file, DOCUMENT_XML).toString('utf8');
  } catch (error) {
    if (error instanceof ResumeTextError) throw error;
    // Truncated or malformed archives surface as RangeErrors from Buffer reads
    // and zlib; the cause is not reported, as it may echo file content.
    throw new ResumeTextError('malformed document');
  }
  return wordXmlText(xml).slice(0, maxChars);
}

function zipEntry(file: Buffer, name: string): Buffer {
  // The end-of-central-directory record is the last 22 bytes, plus a comment
  // of up to 65,535 bytes.
  let end = -1;
  for (
    let i = file.length - 22;
    i >= Math.max(0, file.length - 22 - 0xffff);
    i--
  )
    if (file.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new ResumeTextError('not a .docx file');
  const entries = file.readUInt16LE(end + 10);
  let offset = file.readUInt32LE(end + 16);
  for (let n = 0; n < entries; n++) {
    if (file.readUInt32LE(offset) !== 0x02014b50)
      throw new ResumeTextError('malformed document');
    const method = file.readUInt16LE(offset + 10);
    const compressedSize = file.readUInt32LE(offset + 20);
    const size = file.readUInt32LE(offset + 24);
    const nameLength = file.readUInt16LE(offset + 28);
    const extraLength = file.readUInt16LE(offset + 30);
    const commentLength = file.readUInt16LE(offset + 32);
    const local = file.readUInt32LE(offset + 42);
    const entryName = file.toString(
      'utf8',
      offset + 46,
      offset + 46 + nameLength,
    );
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (size > MAX_XML_BYTES) throw new ResumeTextError('document too large');
    if (file.readUInt32LE(local) !== 0x04034b50)
      throw new ResumeTextError('malformed document');
    const start =
      local +
      30 +
      file.readUInt16LE(local + 26) +
      file.readUInt16LE(local + 28);
    if (start + compressedSize > file.length)
      throw new ResumeTextError('malformed document');
    const data = file.subarray(start, start + compressedSize);
    if (method === 0) return data;
    if (method === 8)
      return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
    throw new ResumeTextError('unsupported compression');
  }
  throw new ResumeTextError('no document text');
}

const entities: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string) {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
      const code =
        entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    },
  );
}

/** Readable text from WordprocessingML: paragraphs, line breaks, tabs and table cells. */
export function wordXmlText(xml: string) {
  return decodeEntities(
    xml
      // Tracked deletions and field codes are not visible text.
      .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
