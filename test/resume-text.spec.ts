import { crc32, deflateRawSync } from 'node:zlib';
import { docxText, ResumeTextError } from '../src/integrations';

/** A minimal ZIP archive, as Word writes one. `size` can lie about an entry. */
function zip(
  entries: Record<string, string>,
  options: { stored?: boolean; size?: number } = {},
) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entry, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const body = options.stored ? data : deflateRawSync(data);
    const name = Buffer.from(entry);
    const method = options.stored ? 0 : 8;
    const size = options.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const body = (xml: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe('Word resume text', () => {
  it('reads paragraphs, line breaks, tabs, table cells and entities', () => {
    const file = zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': body(
        paragraph('Asha Verma') +
          '<w:p><w:r><w:t>Skills:</w:t><w:tab/><w:t>React &amp; Node.js</w:t><w:br/><w:t>SQL &lt;advanced&gt; &#8211; 5&#x2B; years</w:t></w:r></w:p>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>2019</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Acme</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          '<w:p><w:del><w:r><w:delText>Deleted line</w:delText></w:r></w:del><w:r><w:instrText> HYPERLINK "x" </w:instrText><w:t xml:space="preserve">Kept  text </w:t></w:r></w:p>',
      ),
    });
    expect(docxText(file)).toBe(
      'Asha Verma\nSkills: React & Node.js\nSQL <advanced> – 5+ years\n2019\nAcme\nKept text',
    );
  });

  it('reads stored (uncompressed) entries and caps the length', () => {
    const file = zip(
      { 'word/document.xml': body(paragraph('x'.repeat(500))) },
      { stored: true },
    );
    expect(docxText(file, 100)).toBe('x'.repeat(100));
  });

  it.each([
    ['not a Word file', Buffer.from('%PDF-1.7 not a zip')],
    ['an archive without document text', zip({ 'word/other.xml': 'x' })],
    [
      'a truncated archive',
      zip({ 'word/document.xml': body('') }).subarray(0, 60),
    ],
    ['an empty file', Buffer.alloc(0)],
  ])('refuses %s', (_name, file) => {
    expect(() => docxText(file)).toThrow(ResumeTextError);
  });

  it('refuses text that inflates past the limit, even if the size field lies', () => {
    const huge = body(paragraph('a'.repeat(9 * 1024 * 1024)));
    expect(() => docxText(zip({ 'word/document.xml': huge }))).toThrow(
      ResumeTextError,
    );
    expect(() =>
      docxText(zip({ 'word/document.xml': huge }, { size: 100 })),
    ).toThrow(ResumeTextError);
  });
});
