"""Build the editor's game database from your own Switch game backups.

Usage:
    python3 tools/extract_game_data.py <base.nsz> <update.nsz> [output dir]

Reads the game files straight out of the NSZ backups (no keys or RomFS dump
needed: NSZ stores the NCA content decrypted under zstd), applies the update
patch (BKTR) on the fly, then reads the Unity Addressables bundles with UnityPy.

Writes (default output dir: data/ next to index.html):
    items.js  item GUID -> English name, internal id, category, max stack, quality
    game.js   inventory and room GUID -> labels

Requires Python 3.14+ (stdlib zstd) and UnityPy:  pip install UnityPy
"""
import collections
import json
import os
import re
import sys
import uuid
import warnings

warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'nx'))

import UnityPy  # noqa: E402
from patched import open_patched_romfs  # noqa: E402

ASSETS_BUNDLE = re.compile(r'/base_assets_assets__game_addressables_assets_[0-9a-f]{32}\.bundle$')

# Player inventories by internal name. Kinds: container (editable bag),
# wallet, unlocks (lists of things you own/learned), cards.
INVENTORIES = {
    'GameInventory_Inventory': ('Backpack', 'container'),
    'GameInventory_GlobalInventory': ('Storage', 'container'),
    'GameInventory_Tools': ('Tools', 'container'),
    'GameInventory_ConfinedInventory': ('Confined inventory', 'container'),
    'GameInventory_Wallet': ('Coin wallet', 'wallet'),
    'GameInventory_NocturnaCards': ('Nocturna cards', 'cards'),
    'GameInventory_Recipes': ('Recipes', 'unlocks'),
    'GameInventory_Customizations': ('Customizations', 'unlocks'),
    'GameInventory_Spells': ('Spells', 'unlocks'),
    'GameInventory_Forms': ('Forms', 'unlocks'),
    'GameInventory_Upgrades': ('Upgrades', 'unlocks'),
    'GameInventory_Collectibles': ('Collectibles', 'unlocks'),
    'GameInventory_QuestItems': ('Quest items', 'unlocks'),
    'GameInventory_ArcaneFlamesInventory': ('Arcane flames', 'unlocks'),
    'GameInventory_ScarletTeardropsInventory': ('Scarlet teardrops', 'unlocks'),
}
HIDDEN_CATEGORIES = {'Dummy', 'DEPRECATED', 'Demo', 'Debug', 'Test'}


def guid_str(sg):
    """SerializedGuid {part1, part2} -> the string used in saves (.NET byte order)."""
    return str(uuid.UUID(bytes_le=sg['part1'].to_bytes(8, 'little') + sg['part2'].to_bytes(8, 'little')))


def humanize(tokens):
    words = []
    for t in tokens:
        words += re.findall(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+', t) or [t]
    return ' '.join(words)


def load_assets(base_nsz, update_nsz):
    _, fs = open_patched_romfs(base_nsz, update_nsz)
    files = {p: (o, s) for p, o, s in fs.walk()}
    gm = files['/Data/globalgamemanagers']
    head = fs.read_file(gm[0], 256)
    m = re.search(rb'(?:20\d\d|6\d{3})\.\d+\.\d+[abfp]\d+', head)
    if not m:
        raise SystemExit('Could not find the Unity version in globalgamemanagers')
    UnityPy.config.FALLBACK_UNITY_VERSION = m.group().decode()

    wanted = [p for p in files if ASSETS_BUNDLE.search(p) or 'monoscripts' in p]
    if len(wanted) != 2:
        raise SystemExit('Expected the assets bundle and the monoscripts bundle, found: %r' % wanted)
    env = UnityPy.Environment()
    for p in wanted:
        o, s = files[p]
        env.load_file(fs.read_file(o, s), name=p.rsplit('/', 1)[1])

    by_pid = {}
    for obj in env.objects:
        if obj.type.name != 'MonoBehaviour':
            continue
        cls = obj.read(check_read=False).m_Script.read().m_ClassName
        by_pid[obj.path_id] = (cls, obj.read_typetree())
    return UnityPy.config.FALLBACK_UNITY_VERSION, by_pid


def build(by_pid):
    english = None
    for cls, t in by_pid.values():
        if cls == 'TranslationCollectionAsset' and t['m_Name'] == 'TranslationCollection_English':
            tr = t['<Translations>k__BackingField']
            english = dict(zip(tr['keys'], tr['values']))
    if english is None:
        raise SystemExit('English translation table not found')

    raw = {}
    for cls, t in by_pid.values():
        if cls == 'ItemAsset':
            raw[guid_str(t['<SerializedGuid>k__BackingField'])] = t
    owner_of_key = {t['<LocalizedName>k__BackingField']['Key']: t['m_Name'] for t in raw.values() if t['<LocalizedName>k__BackingField']['Key']}

    items, stats = {}, collections.Counter()
    for g, t in raw.items():
        iid = t['m_Name']
        tokens = iid.split('_')
        cat = tokens[1] if len(tokens) > 1 else 'Other'
        loc = t['<LocalizedName>k__BackingField']
        name, derived = None, False
        if loc['Key'] and english.get(loc['Key']):
            name = english[loc['Key']]
            stats['own name'] += 1
        else:
            m = re.fullmatch(r'LOC\((.+)\)', loc['Draft'] or '')
            if m and english.get(m.group(1)):
                # Variant sharing its base item's name: append what differs.
                name = english[m.group(1)]
                base = owner_of_key.get(m.group(1), '').split('_')
                extra = [x for x in tokens[2:] if x not in base]
                if extra:
                    name += ' (' + humanize(extra) + ')'
                stats['variant name'] += 1
            elif loc['Draft'] and not loc['Draft'].startswith('LOC('):
                name = loc['Draft']
                stats['draft name'] += 1
            else:
                name = humanize(tokens[2:] or tokens)
                derived = True
                stats['derived from id'] += 1
        ss = t['<StackSize>k__BackingField']['m_PathID']
        stack = by_pid[ss][1]['<Size>k__BackingField'] if ss in by_pid else 1
        rec = {'n': name, 'i': iid, 'c': cat, 's': stack}
        if t['<UsesQualities>k__BackingField']:
            rec['q'] = 1
        if derived:
            rec['d'] = 1
        if cat in HIDDEN_CATEGORIES or 'DEPRECATED' in iid or not t['<IsAcquirable>k__BackingField']:
            rec['h'] = 1
        items[g] = rec

    inventories, rooms = {}, {}
    for cls, t in by_pid.values():
        sg = t.get('<SerializedGuid>k__BackingField')
        if not sg:
            continue
        if t['m_Name'] in INVENTORIES:
            label, kind = INVENTORIES[t['m_Name']]
            inventories[guid_str(sg)] = {'id': t['m_Name'], 'label': label, 'kind': kind}
        elif cls == 'RoomAsset':
            rooms[guid_str(sg)] = humanize(t['m_Name'].split('_')[1:])
    return items, inventories, rooms, stats


def write_js(path, header, assignments):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(header)
        for name, value in assignments:
            f.write('window.%s = %s;\n' % (name, json.dumps(value, ensure_ascii=True, separators=(',', ':'), sort_keys=True)))


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, '..', 'data')
    unity, by_pid = load_assets(sys.argv[1], sys.argv[2])
    items, inventories, rooms, stats = build(by_pid)
    header = '// Generated by tools/extract_game_data.py (Unity %s). Do not edit by hand.\n' % unity
    write_js(os.path.join(out, 'items.js'), header, [('MP_ITEM_DB', items)])
    write_js(os.path.join(out, 'game.js'), header, [('MP_INVENTORIES', inventories), ('MP_ROOMS', rooms)])
    print('items: %d (%s), hidden: %d' % (len(items), ', '.join('%s %d' % kv for kv in stats.most_common()), sum(1 for r in items.values() if r.get('h'))))
    print('inventories: %d, rooms: %d -> %s' % (len(inventories), len(rooms), os.path.abspath(out)))


if __name__ == '__main__':
    main()
