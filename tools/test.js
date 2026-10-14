// Usage: node tools/test.js <JKSV save .zip> <output dir>
// Runs the editor core against a real save and writes edited copies for
// independent verification (see tools/verify_export.py).
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const LosslessJSON = require('../js/losslessjson.js');
const Archive = require('../js/archive.js');
const M = require('../js/savemodel.js');

async function main() {
  const [zipPath, outDir] = process.argv.slice(2);
  if (!zipPath || !outDir) throw new Error('usage: node tools/test.js <save.zip> <outdir>');
  fs.mkdirSync(outDir, { recursive: true });
  const zipBytes = new Uint8Array(fs.readFileSync(zipPath));

  // 1. Lossless round trip of every JSON document in the archive.
  const entries = await Archive.readZip(zipBytes);
  for (const e of entries) {
    if (!e.data.length || !Archive.isGzip(e.data)) continue;
    const doc = await M.openDocument(e.data);
    assert.strictEqual(doc.bom, true, 'BOM not detected in ' + e.name);
    const t0 = Date.now();
    const again = LosslessJSON.stringify(doc.value, doc.rawTable);
    assert.strictEqual(again, doc.text, 'round trip differs for ' + e.name);
    const enc = await M.encodeDocument(doc);
    assert.strictEqual(enc.changed, false);
    console.log('ok  lossless round trip', e.name, doc.text.length, 'chars', Date.now() - t0, 'ms');
  }

  // 2. Unedited export: every entry's content identical to the original.
  {
    const bundle = await M.loadBundle([{ name: path.basename(zipPath), bytes: zipBytes }]);
    const save = await M.openSlot(bundle, bundle.slotIds[0]);
    const out = await save.export();
    assert.deepStrictEqual(out.changed, []);
    const re = await Archive.readZip(out.bytes);
    assert.deepStrictEqual(re.map((e) => e.name), entries.map((e) => e.name));
    re.forEach((e, i) => assert.ok(Buffer.from(e.data).equals(Buffer.from(entries[i].data)), 'entry changed: ' + e.name));
    fs.writeFileSync(path.join(outDir, 'unedited.zip'), out.bytes);
    console.log('ok  unedited export keeps all', re.length, 'entries byte-identical');
  }

  // 3. Edits.
  const bundle = await M.loadBundle([{ name: path.basename(zipPath), bytes: zipBytes }]);
  const save = await M.openSlot(bundle, bundle.slotIds[0]);
  const info = save.info;
  console.log('    slot', info.slotId, 'player', info.playerName, 'coins', save.coins, 'version', info.version);

  const invs = save.inventories();
  const wallet = invs.find((i) => i.kind === 'wallet');
  assert.ok(wallet, 'wallet found');
  console.log('    kinds:', invs.map((i) => i.index + ':' + i.kind + '(' + i.slots.length + ')').join(' '));

  save.coins = 999999;
  assert.strictEqual(save.coins, 999999);
  assert.strictEqual(save.meta.value.Coins, 999999);

  // Pick a container with both filled and empty slots.
  const target = invs.find((i) => i.kind === 'container' && i.slots.some(M.isFilled) && i.slots.some((s) => !M.isFilled(s)));
  const filledIdx = target.slots.findIndex(M.isFilled);
  const filled = target.slots[filledIdx];
  save.setAmount(filled, 77);
  const emptyIdx = target.slots.findIndex((s) => !M.isFilled(s));
  const empty = target.slots[emptyIdx];
  const giveGuid = filled.ItemEntry.itemRef.SerializedGuid;
  save.fillSlot(empty, giveGuid, 5, 2);
  assert.throws(() => save.fillSlot(empty, giveGuid, 1, 0), /not empty/);
  assert.throws(() => save.fillSlot(target.slots.find((s) => !M.isFilled(s)), 'nope', 1, 0), /Invalid item GUID/);
  assert.throws(() => save.fillSlot(target.slots.find((s) => !M.isFilled(s)), M.COIN_GUID, 1, 0), /wallet/);
  assert.strictEqual(save.walletSlot().ItemEntry.Amount, 999999);

  const exp = await save.export();
  console.log('    changed:', exp.changed.join(', '));
  assert.strictEqual(exp.changed.length, 2);
  fs.writeFileSync(path.join(outDir, 'edited.zip'), exp.bytes);
  fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify({
    coins: 999999,
    inventoryGuid: target.guid,
    filledIdx, emptyIdx, giveGuid,
    newAmount: 77,
  }));
  console.log('ok  edits exported to', path.join(outDir, 'edited.zip'));

  // 3b. Shared item references: Json.NET writes the second use of an object
  // as {"$ref": "<$id>"}, which the in-game toolbox's "give item" produces.
  {
    const b = await M.loadBundle([{ name: path.basename(zipPath), bytes: zipBytes }]);
    const s0 = await M.openSlot(b, b.slotIds[0]);
    const inv = s0.inventories().find((i) => i.kind === 'container' && i.slots.some(M.isFilled) && i.slots.some((x) => !M.isFilled(x)));
    const donor = inv.slots.find(M.isFilled);
    const target = inv.slots.find((x) => !M.isFilled(x));
    target.ItemEntry = { Amount: 3, itemRef: { $ref: donor.ItemEntry.itemRef.$id } };
    const out = await s0.export();
    const reopened = await M.openSlot(await M.loadBundle([{ name: 'ref.zip', bytes: out.bytes }]), b.slotIds[0]);
    const inv2 = reopened.inventories().find((i) => i.guid === inv.guid);
    const t2 = inv2.slots[inv.slots.indexOf(target)];
    assert.strictEqual(M.isFilled(t2), true, '$ref slot should count as filled');
    assert.strictEqual(M.itemGuid(t2), M.itemGuid(donor));
    assert.ok(reopened.catalog().get(M.itemGuid(donor)).owned.length >= 2);
    const again = await reopened.export();
    assert.deepStrictEqual(again.changed, [], 'unedited save with $ref must stay byte-identical');
    console.log('ok  $ref item references resolved and preserved');
  }

  // 4. Loose-file mode (Switch gzip files and plain PC-style JSON).
  {
    const gd = entries.find((e) => /\/GameData$/.test(e.name)).data;
    const gm = entries.find((e) => /\/GameMetaData$/.test(e.name)).data;
    const plainGd = await Archive.gunzip(gd);
    for (const [label, files] of [
      ['gzip', [{ name: 'GameData', bytes: gd }, { name: 'GameMetaData', bytes: gm }]],
      ['plain', [{ name: 'GameData.json', bytes: plainGd }]],
    ]) {
      const b = await M.loadBundle(files);
      const s = await M.openSlot(b, null);
      s.coins = 1234;
      const o = await s.export();
      assert.strictEqual(o.kind, 'files');
      const back = await M.openDocument(o.files.find((f) => /GameData/.test(f.name) && !/Meta/.test(f.name)).bytes);
      assert.strictEqual(back.gz, label === 'gzip');
      const reopened = await M.openSlot(await M.loadBundle([{ name: 'x', bytes: o.files[0].bytes }]), null);
      assert.strictEqual(reopened.coins, 1234);
      console.log('ok  loose', label, 'mode:', o.files.map((f) => f.name).join(', '));
    }
  }
  console.log('ALL TESTS PASSED');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
