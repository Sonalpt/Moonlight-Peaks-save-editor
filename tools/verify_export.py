"""Independent check of an edited save produced by tools/test.js.

Usage: python3 tools/verify_export.py <original.zip> <edited.zip> <expected.json>

Re-reads both archives with Python's own zip/gzip/json, then reports every
JSON path that differs, so we can confirm only the intended values changed.
"""
import gzip
import json
import sys
import zipfile


def load(zpath):
    out = {}
    with zipfile.ZipFile(zpath) as z:
        assert z.testzip() is None, 'CRC error in ' + zpath
        for info in z.infolist():
            data = z.read(info)
            if data[:2] == b'\x1f\x8b':
                text = gzip.decompress(data).decode('utf-8')
                assert text.startswith('﻿'), info.filename + ' lost its BOM'
                out[info.filename] = json.loads(text[1:])
            else:
                out[info.filename] = data
    return out


def diff(a, b, path, acc):
    if type(a) is not type(b):
        acc.append((path, a, b))
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            diff(a.get(k, '<missing>'), b.get(k, '<missing>'), path + '.' + k, acc)
    elif isinstance(a, list):
        if len(a) != len(b):
            acc.append((path + '.length', len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, path + '[%d]' % i, acc)
    elif a != b:
        acc.append((path, a, b))


def main():
    orig, edited, expected = load(sys.argv[1]), load(sys.argv[2]), json.load(open(sys.argv[3]))
    assert list(orig) == list(edited), 'entry list differs'
    for name in orig:
        acc = []
        diff(orig[name], edited[name], '', acc)
        print('%s: %d difference(s)' % (name, len(acc)))
        for p, x, y in acc:
            print('   ', p, ':', json.dumps(x)[:150], '->', json.dumps(y)[:150])
    gd = next(v for k, v in edited.items() if k.endswith('/GameData'))
    inv = next(i for i in gd['Player']['Inventories']['$values'] if i['Guid'] == expected['inventoryGuid'])
    slots = inv['Slots']['$values']
    assert slots[expected['filledIdx']]['ItemEntry']['Amount'] == expected['newAmount']
    assert slots[expected['emptyIdx']]['ItemEntry']['itemRef']['SerializedGuid'] == expected['giveGuid']
    ids = []

    def collect(o):
        if isinstance(o, dict):
            if '$id' in o:
                ids.append(o['$id'])
            for v in o.values():
                collect(v)
        elif isinstance(o, list):
            for v in o:
                collect(v)
    collect(gd)
    assert len(ids) == len(set(ids)), 'duplicate $id values'
    print('VERIFIED: expected edits present, %d unique $id values' % len(ids))


main()
