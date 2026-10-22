// A tiny ZIP writer (stored, no compression) for handing back several PDFs as
// one download. PDFs are already compressed inside, so deflating them again
// would mostly burn time. No dependency needed.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_NAMES = 0x0800; // general-purpose flag bit 11: file names are UTF-8

export function zip(entries: ZipEntry[], when = new Date()): Blob {
  if (entries.length > 0xffff) throw new Error("Too many files for a ZIP");
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const chunks: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const size = entry.data.length;
    const crc = crc32(entry.data);
    if (offset + size > 0xfffffffe) throw new Error("ZIP would be larger than 4 GB");

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // no extra field
    chunks.push(local.buffer, name as BlobPart, entry.data as BlobPart);

    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); // central directory header
    head.setUint16(4, 20, true); // version made by
    head.setUint16(6, 20, true); // version needed
    head.setUint16(8, UTF8_NAMES, true);
    head.setUint16(10, 0, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, size, true);
    head.setUint32(24, size, true);
    head.setUint16(28, name.length, true);
    // extra, comment, disk start, internal and external attributes: all zero
    head.setUint32(42, offset, true);
    const rec = new Uint8Array(46 + name.length);
    rec.set(new Uint8Array(head.buffer), 0);
    rec.set(name, 46);
    central.push(rec);

    offset += 30 + name.length + size;
  }

  const cdSize = central.reduce((n, r) => n + r.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...(central as BlobPart[]), end.buffer], { type: "application/zip" });
}
