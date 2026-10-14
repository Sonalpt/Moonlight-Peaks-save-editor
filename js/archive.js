/*
 * gzip + minimal ZIP reader/writer built on the platform's
 * CompressionStream / DecompressionStream (browsers and Node 18+).
 *
 * The ZIP writer mirrors what JKSV (minizip) produces: deflate for every
 * entry including directories, no extra fields, DOS timestamps.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Archive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  async function pipe(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }
  const inflateRaw = (b) => pipe(b, new DecompressionStream('deflate-raw'));
  const deflateRaw = (b) => pipe(b, new CompressionStream('deflate-raw'));

  function isGzip(b) {
    return b.length > 10 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;
  }
  function isZip(b) {
    return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  }
  const gunzip = (b) => pipe(b, new DecompressionStream('gzip'));

  /**
   * gzip `data`. If `templateHeader` (the first 10 bytes of an original gzip
   * file) is given, its mtime/xfl/os bytes are reused so the output header is
   * identical to what the game wrote. Safe because FHCRC is never set here.
   */
  async function gzip(data, templateHeader) {
    const out = await pipe(data, new CompressionStream('gzip'));
    if (out[3] !== 0) {
      // Platform added optional header fields; rebuild a plain header instead.
      const body = await deflateRaw(data);
      const trailer = new Uint8Array(8);
      const dv = new DataView(trailer.buffer);
      dv.setUint32(0, crc32(data), true);
      dv.setUint32(4, data.length >>> 0, true);
      const hdr = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
      return concat([hdr, body, trailer]);
    }
    if (templateHeader && templateHeader.length >= 10 && templateHeader[3] === 0) {
      out.set(templateHeader.subarray(4, 10), 4);
    }
    return out;
  }

  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** Returns [{ name, data(Uint8Array), dosTime, dosDate, externalAttr }] in archive order. */
  async function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p--) {
      if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP file (end of central directory not found)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    const dec = new TextDecoder('utf-8');
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
      const method = dv.getUint16(p + 10, true);
      const dosTime = dv.getUint16(p + 12, true);
      const dosDate = dv.getUint16(p + 14, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const externalAttr = dv.getUint32(p + 38, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = csize === 0 ? new Uint8Array(0) : await inflateRaw(raw);
      else throw new Error('Unsupported ZIP compression method ' + method + ' for ' + name);
      if (data.length !== usize) throw new Error('ZIP size mismatch for ' + name);
      entries.push({ name, data, dosTime, dosDate, externalAttr });
    }
    return entries;
  }

  function dosDateTime(d) {
    return {
      dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      dosDate: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /** entries: [{ name, data, dosTime?, dosDate?, externalAttr? }] */
  async function writeZip(entries) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    const now = dosDateTime(new Date());
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.data || new Uint8Array(0);
      const comp = await deflateRaw(data);
      const crc = crc32(data);
      const t = e.dosTime ?? now.dosTime;
      const d = e.dosDate ?? now.dosDate;

      const lh = new Uint8Array(30 + name.length);
      const l = new DataView(lh.buffer);
      l.setUint32(0, 0x04034b50, true);
      l.setUint16(4, 20, true); // version needed
      l.setUint16(6, 0, true); // flags
      l.setUint16(8, 8, true); // deflate
      l.setUint16(10, t, true);
      l.setUint16(12, d, true);
      l.setUint32(14, crc, true);
      l.setUint32(18, comp.length, true);
      l.setUint32(22, data.length, true);
      l.setUint16(26, name.length, true);
      l.setUint16(28, 0, true);
      lh.set(name, 30);

      const ch = new Uint8Array(46 + name.length);
      const c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 0, true); // version made by (as JKSV)
      c.setUint16(6, 20, true);
      c.setUint16(8, 0, true);
      c.setUint16(10, 8, true);
      c.setUint16(12, t, true);
      c.setUint16(14, d, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, comp.length, true);
      c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(38, e.externalAttr || 0, true);
      c.setUint32(42, offset, true);
      ch.set(name, 46);

      locals.push(lh, comp);
      centrals.push(ch);
      offset += lh.length + comp.length;
    }
    let cdSize = 0;
    for (const ch of centrals) cdSize += ch.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return concat([...locals, ...centrals, end]);
  }

  return { isGzip, isZip, gzip, gunzip, readZip, writeZip, crc32 };
});
