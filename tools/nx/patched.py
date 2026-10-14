"""Virtual 1.1.30 RomFS = base RomFS section + update BKTR indirect patch (both read from NSZ)."""
import struct, sys, os, bisect
sys.path.insert(0, os.path.dirname(__file__))
from nczfs import NczReader, RomFS, find_romfs

class PatchedSection:
    def __init__(self, base_nsz, upd_nsz):
        self.b = NczReader(base_nsz); self.u = NczReader(upd_nsz)
        bsec = max(self.b.info['sections'], key=lambda s: s['size'])
        self.b_off = bsec['offset']
        usecs = self.u.info['sections']
        self.u_off = usecs[0]['offset']                       # patch section start (0x4000)
        tail = usecs[-2]['offset']                            # indirect table lives in the tail subsection
        node = self.u.read(tail, 0x4000)
        idx, nsets, vsize = struct.unpack_from('<iiq', node, 0)
        assert idx == 0 and nsets >= 1
        self.vsize = vsize
        self.entries = []
        for k in range(nsets):
            es = self.u.read(tail + 0x4000 * (1 + k), 0x4000)
            _i, cnt, end = struct.unpack_from('<iiq', es, 0)
            for j in range(cnt):
                v, p, st = struct.unpack_from('<qqi', es, 16 + 0x14 * j)
                self.entries.append((v, p, st))
        self.virts = [e[0] for e in self.entries]
        assert self.virts == sorted(self.virts) and self.virts[0] == 0
    def read(self, off, n):
        out = bytearray()
        while n > 0 and off < self.vsize:
            i = bisect.bisect_right(self.virts, off) - 1
            v, p, st = self.entries[i]
            nxt = self.virts[i + 1] if i + 1 < len(self.virts) else self.vsize
            take = min(n, nxt - off)
            src = self.b.read(self.b_off + p + (off - v), take) if st == 0 else self.u.read(self.u_off + p + (off - v), take)
            assert len(src) == take
            out += src; off += take; n -= take
        return bytes(out)

def open_patched_romfs(base_nsz, upd_nsz):
    ps = PatchedSection(base_nsz, upd_nsz)
    rb = find_romfs(ps, 0, ps.vsize)
    assert rb is not None, 'RomFS header not found in patched section'
    return ps, RomFS(ps, rb)

if __name__ == '__main__':
    ps, fs = open_patched_romfs(sys.argv[1], sys.argv[2])
    print('patched entries', len(ps.entries), 'from base', sum(1 for e in ps.entries if e[2] == 0), 'from update', sum(1 for e in ps.entries if e[2] == 1))
    files = list(fs.walk())
    print('files:', len(files), 'total %.1f MB' % (sum(f[2] for f in files) / 1e6))
    bad = 0
    for p, o, s in files:
        if p.endswith('.bundle'):
            if fs.read_file(o, 7) != b'UnityFS': bad += 1; print('BAD bundle magic', p)
    print('bundles with bad magic:', bad)
    sys.path.insert(0, os.path.dirname(__file__))
    from nczfs import NczReader as _R
    base_fs = RomFS(ps.b, find_romfs(ps.b, ps.b_off, max(s['size'] for s in ps.b.info['sections'])))
    bset = {p: s for p, _, s in base_fs.walk()}
    pset = {p: s for p, _, s in files}
    print('new files in 1.1.30:', len(set(pset) - set(bset)), '| removed:', len(set(bset) - set(pset)), '| same name+size:', sum(1 for p in pset if bset.get(p) == pset[p]))
    for p, o, s in files:
        if p.startswith('/Data/') and p.count('/') == 2: print('  %9d  %s' % (s, p))
    gm = [f for f in files if f[0].endswith('global-metadata.dat')][0]
    print('global-metadata magic', fs.read_file(gm[1], 8).hex())
