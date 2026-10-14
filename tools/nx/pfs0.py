"""PFS0 (NSP/NSZ container) listing."""
import struct, sys
def list_pfs0(path, base=0):
    f = open(path, 'rb'); f.seek(base)
    magic, n, strsz, _ = struct.unpack('<4sIII', f.read(16))
    assert magic == b'PFS0', magic
    ents = [struct.unpack('<QQII', f.read(24)) for _ in range(n)]
    strtab = f.read(strsz)
    data0 = base + 16 + 24 * n + strsz
    out = []
    for off, size, no, _ in ents:
        name = strtab[no:strtab.index(b'\0', no)].decode()
        out.append((name, data0 + off, size))
    return out
if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(p.split('/')[-1])
        for name, off, size in list_pfs0(p):
            f = open(p, 'rb'); f.seek(off + 0x4000); m = f.read(8)
            print(f'   {name:60} off={off:#x} size={size/1e6:9.1f} MB  @0x4000={m!r}')
