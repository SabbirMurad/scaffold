// Minimal STORE-only ZIP writer (no compression). Enough to bundle generated
// files — text (Dart source, SVGs) or binary (image bytes as a Uint8Array),
// including nested paths like "lib/model/user.dart" — into a single downloadable
// archive, with no external dependency.

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

const u16 = n => [n & 0xff, (n >>> 8) & 0xff];
const u32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// files: [{ name, content }] — name is the path inside the zip; content is a
// string (encoded UTF-8) or a Uint8Array (written as-is, for binary assets).
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.content instanceof Uint8Array ? f.content : enc.encode(f.content);
    const crc = crc32(data);

    const localHeader = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), // sig, version, flags, method (0 = store)
      ...u16(0), ...u16(0),                                 // mod time, mod date
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),                  // name len, extra len
    ]);
    chunks.push(localHeader, nameBytes, data);

    central.push({
      bytes: new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), // sig, ver made/needed, flags, method
        ...u16(0), ...u16(0),                                             // time, date
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBytes.length), ...u16(0), ...u16(0),                  // name, extra, comment len
        ...u16(0), ...u16(0), ...u32(0),                                // disk #, int/ext attrs
        ...u32(offset),                                                 // local header offset
      ]),
      name: nameBytes,
    });

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    chunks.push(c.bytes, c.name);
    centralSize += c.bytes.length + c.name.length;
  }

  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(centralStart), ...u16(0),
  ]));

  return new Blob(chunks, { type: 'application/zip' });
}
