import { inflateRawSync } from 'zlib';
import { crc32, zipFiles } from './zip';

/** Reads the archive back through its central directory, as an unzip tool would. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26);
    const data = inflateRawSync(buf.subarray(dataStart, dataStart + size));
    expect(crc32(data)).toBe(buf.readUInt32LE(p + 16));
    out[name] = data.toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}

describe('zipFiles', () => {
  it('round-trips files, including UTF-8 names and content', () => {
    const files = [{ path: 'infra/main.bicep', content: "param x string = 'é'\n".repeat(50) }, { path: 'README.md', content: '# Hi' }];
    expect(unzip(zipFiles(files))).toEqual({ 'infra/main.bicep': files[0].content, 'README.md': '# Hi' });
  });

  it('is byte-for-byte deterministic and rejects unsafe paths', () => {
    const f = [{ path: 'a.txt', content: 'a' }];
    expect(zipFiles(f).equals(zipFiles(f))).toBe(true);
    expect(() => zipFiles([{ path: '../x', content: '' }])).toThrow('Unsafe');
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
