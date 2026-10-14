"""Random-access reader for block-compressed NCZ (inside NSZ) + RomFS parser.
Reads plaintext NCA body without writing anything to disk."""
import struct, sys, os
from functools import lru_cache
sys.path.insert(0, os.path.dirname(__file__))
from compression import zstd
from ncz import ncz_info

class NczReader:
    def __init__(self, path):
        self.info = info = ncz_info(path)
        b = info['block']
        assert b, 'only block-compressed NCZ supported'
        self.f = open(path, 'rb')
        self.bs = 1 << b['blockSizeExp']
        self.dsize = b['decompressedSize']
        self.f.seek(info['zstd_start'] - 4 * b['blocks'])
        self.csizes = struct.unpack('<%dI' % b['blocks'], self.f.read(4 * b['blocks']))
        self.coffs = []
        o = info['zstd_start']
        for c in self.csizes:
            self.coffs.append(o); o += c
        self.f.seek(info['ncz_off']); self.header = self.f.read(0x4000)
        self.size = 0x4000 + self.dsize
    @lru_cache(maxsize=64)
    def block(self, i):
        want = min(self.bs, self.dsize - i * self.bs)
        self.f.seek(self.coffs[i]); data = self.f.read(self.csizes[i])
        if self.csizes[i] < want: data = zstd.decompress(data)
        assert len(data) == want
        return data
    def read(self, off, n):
        out = bytearray()
        while n > 0:
            if off < 0x4000:
                chunk = self.header[off:off + n]
            else:
                d = off - 0x4000; bi, bo = divmod(d, self.bs)
                chunk = self.block(bi)[bo:bo + n]
            if not chunk: break
            out += chunk; off += len(chunk); n -= len(chunk)
        return bytes(out)

class RomFS:
    def __init__(self, reader, base):
        self.r, self.base = reader, base
        h = struct.unpack('<10Q', reader.read(base, 0x50))
        (self.hsize, _, _, self.dmeta_off, self.dmeta_size, _, _, self.fmeta_off, self.fmeta_size, self.data_off) = h
        self.dmeta = reader.read(base + self.dmeta_off, self.dmeta_size)
        self.fmeta = reader.read(base + self.fmeta_off, self.fmeta_size)
    def _dir(self, o):
        parent, sib, child, cfile, _h, nlen = struct.unpack_from('<6I', self.dmeta, o)
        return sib, child, cfile, self.dmeta[o + 24:o + 24 + nlen].decode('utf-8')
    def _file(self, o):
        parent, sib, doff, dsize, _h, nlen = struct.unpack_from('<IIQQII', self.fmeta, o)
        return sib, doff, dsize, self.fmeta[o + 32:o + 32 + nlen].decode('utf-8')
    def walk(self, o=0, path=''):
        """yields (path, data_offset, size) for every file."""
        NONE = 0xFFFFFFFF
        sib, child, cfile, name = self._dir(o)
        here = path + '/' + name if o else ''
        f = cfile
        while f != NONE:
            fsib, doff, dsize, fname = self._file(f)
            yield here + '/' + fname, doff, dsize
            f = fsib
        c = child
        while c != NONE:
            yield from self.walk(c, here)
            c = self._dir(c)[0]
    def read_file(self, doff, size):
        return self.r.read(self.base + self.data_off + doff, size)

def find_romfs(reader, sec_off, sec_size, scan=64 << 20, step=0x200):
    for p in range(sec_off, sec_off + min(scan, sec_size), step):
        h = reader.read(p, 0x50)
        if len(h) < 0x50: break
        v = struct.unpack('<10Q', h)
        if v[0] == 0x50 and v[9] == 0x200 and 0x200 <= v[3] < sec_size and 0 < v[4] < (64 << 20) and 0 < v[8] < (256 << 20):
            return p
    return None
