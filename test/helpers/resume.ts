import { crc32, deflateRawSync } from 'node:zlib';
export const pdfResume = Buffer.from('%PDF-1.7\nSample resume\n%%EOF');
export function docxResume(
  names = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'],
  deflated = false,
): Buffer {
  const contents = [
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Resume</w:t></w:r></w:p></w:body></w:document>',
  ];
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  names.forEach((name, index) => {
    const filename = Buffer.from(name),
      content = Buffer.from(contents[index] ?? 'test'),
      stored = deflated ? deflateRawSync(content) : content,
      crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(deflated ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(stored.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(deflated ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + stored.length;
  });
  const end = Buffer.alloc(22),
    directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
