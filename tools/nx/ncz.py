"""NCZ section/block header parsing (nsz format)."""
import struct, sys
sys.path.insert(0, __import__('os').path.dirname(__file__))
from pfs0 import list_pfs0
def ncz_info(path):
    for name, off, size in list_pfs0(path):
        if not name.endswith('.ncz'): continue
        f = open(path, 'rb'); f.seek(off + 0x4000)
        assert f.read(8) == b'NCZSECTN'
        (cnt,) = struct.unpack('<Q', f.read(8))
        secs = []
        for _ in range(cnt):
            o, s, ct, _p = struct.unpack('<QQQQ', f.read(32)); key = f.read(16); ctr = f.read(16)
            secs.append(dict(offset=o, size=s, cryptoType=ct, ctr=ctr.hex()))
        pos = f.tell()
        blk = f.read(8)
        block = None
        if blk == b'NCZBLOCK':
            ver, typ, _u, exp, nblocks, dsize = struct.unpack('<BBBBIQ', f.read(16))
            block = dict(version=ver, type=typ, blockSizeExp=exp, blocks=nblocks, decompressedSize=dsize)
            datastart = f.tell() + 4 * nblocks
        else:
            datastart = pos
        return dict(name=name, ncz_off=off, ncz_size=size, sections=secs, block=block, zstd_start=datastart, zstd_end=off + size)
if __name__ == '__main__':
    for p in sys.argv[1:]:
        i = ncz_info(p)
        print(p.split('/')[-1], i['name'], 'block:', i['block'], 'zstd@', hex(i['zstd_start']))
        for s in i['sections']:
            print('   section off=%#x size=%.1fMB crypto=%d ctr=%s' % (s['offset'], s['size']/1e6, s['cryptoType'], s['ctr']))
