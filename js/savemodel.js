/*
 * Moonlight Peaks save model.
 *
 * Save layout (Switch, as exported by JKSV; PC uses the same JSON):
 *   GlobalData                      settings, last played slot
 *   Saves/<slotGuid>/GameData       the whole world state
 *   Saves/<slotGuid>/GameMetaData   summary shown on the load screen (Coins, name, day...)
 * Each file is UTF-8 JSON with BOM, gzip-compressed on Switch. The JSON is
 * Json.NET output with PreserveReferencesHandling ("$id" on every class
 * instance, no "$ref"), and default-valued fields omitted.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./losslessjson.js'), require('./archive.js'));
  } else {
    root.MPSaveModel = factory(root.LosslessJSON, root.Archive);
  }
})(typeof self !== 'undefined' ? self : this, function (LosslessJSON, Archive) {
  'use strict';

  const COIN_GUID = '62ec20c1-a852-4c26-8ac9-3b17e1fff385';
  const INT32_MAX = 2147483647;
  const BOM = '﻿';
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /* ---------- documents (one per JSON file) ---------- */

  async function openDocument(bytes) {
    const gz = Archive.isGzip(bytes);
    const plain = gz ? await Archive.gunzip(bytes) : bytes;
    // ignoreBOM keeps the BOM in the decoded text so we can detect and restore it.
    let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
    const bom = text.startsWith(BOM);
    if (bom) text = text.slice(1);
    const { value, rawTable } = LosslessJSON.parse(text);
    return { bytes, gz, gzHeader: gz ? bytes.slice(0, 10) : null, bom, text, value, rawTable };
  }

  /** Returns original bytes if nothing changed, else freshly encoded bytes. */
  async function encodeDocument(doc) {
    const text = LosslessJSON.stringify(doc.value, doc.rawTable);
    if (text === doc.text) return { bytes: doc.bytes, changed: false };
    const plain = new TextEncoder().encode((doc.bom ? BOM : '') + text);
    const bytes = doc.gz ? await Archive.gzip(plain, doc.gzHeader) : plain;
    return { bytes, changed: true };
  }

  function docKind(value) {
    if (!value || typeof value !== 'object') return null;
    if ('Player' in value && 'Rooms' in value) return 'GameData';
    if ('PlayerName' in value && 'Coins' in value) return 'GameMetaData';
    if ('LastPlayedGameSave' in value || 'RewiredSaveData' in value) return 'GlobalData';
    return null;
  }

  /* ---------- bundle: the set of files the user opened ---------- */

  /**
   * files: [{ name, bytes }]. Accepts one JKSV .zip, or loose files
   * (GameData / GameMetaData / GlobalData, gzip or plain JSON).
   */
  async function loadBundle(files) {
    if (files.length === 1 && Archive.isZip(files[0].bytes)) {
      const entries = await Archive.readZip(files[0].bytes);
      const slots = new Map();
      let globalDoc = null;
      for (const e of entries) {
        const m = /^(?:.*\/)?Saves\/([^/]+)\/(GameData|GameMetaData)$/.exec(e.name);
        if (m) {
          if (!slots.has(m[1])) slots.set(m[1], {});
          slots.get(m[1])[m[2]] = e.name;
        } else if (/(^|\/)GlobalData$/.test(e.name)) {
          globalDoc = { entry: e.name };
        }
      }
      const slotIds = [...slots.keys()].filter((k) => slots.get(k).GameData);
      if (!slotIds.length) throw new Error('No Saves/<slot>/GameData found in this ZIP. Is it a Moonlight Peaks JKSV backup?');
      return { mode: 'zip', zipName: files[0].name, entries, slots, slotIds, globalEntry: globalDoc && globalDoc.entry };
    }
    const loose = [];
    for (const f of files) {
      let doc;
      try {
        doc = await openDocument(f.bytes);
      } catch (err) {
        throw new Error(f.name + ': not a Moonlight Peaks save file (' + err.message + ')');
      }
      const kind = docKind(doc.value);
      if (!kind) throw new Error(f.name + ': unrecognised JSON (expected GameData, GameMetaData or GlobalData)');
      loose.push({ name: f.name, kind, doc });
    }
    if (!loose.some((l) => l.kind === 'GameData')) throw new Error('Please include the GameData file (the one inside Saves/<slot>/).');
    return { mode: 'loose', loose };
  }

  /** Opens one save slot from a bundle and returns an MPSave. */
  async function openSlot(bundle, slotId) {
    if (bundle.mode === 'zip') {
      const names = bundle.slots.get(slotId);
      const get = (n) => bundle.entries.find((e) => e.name === n);
      const game = await openDocument(get(names.GameData).data);
      const meta = names.GameMetaData ? await openDocument(get(names.GameMetaData).data) : null;
      const glob = bundle.globalEntry ? await openDocument(get(bundle.globalEntry).data) : null;
      return new MPSave(bundle, slotId, game, meta, glob);
    }
    const pick = (k) => bundle.loose.find((l) => l.kind === k);
    const g = pick('GameData');
    const m = pick('GameMetaData');
    if (m && m.doc.value.Guid && g.doc.value.Guid && m.doc.value.Guid !== g.doc.value.Guid) {
      throw new Error('GameMetaData belongs to a different save slot than GameData.');
    }
    const gl = pick('GlobalData');
    return new MPSave(bundle, g.doc.value.Guid, g.doc, m ? m.doc : null, gl ? gl.doc : null);
  }

  /* ---------- the editable save ---------- */

  class MPSave {
    constructor(bundle, slotId, game, meta, glob) {
      this.bundle = bundle;
      this.slotId = slotId;
      this.game = game;
      this.meta = meta;
      this.glob = glob;
      this.d = game.value;
      // Optional game data (data/game.js): inventory GUID -> {label, kind}, room GUID -> name.
      this.invInfo = {};
      this.roomNames = {};
      this._nextId = null;
      linkReferences(this.d);
      this._cardGuids = new Set(this.list(this.d.CardsDiscovered));
    }

    list(container) {
      return container && Array.isArray(container.$values) ? container.$values : [];
    }

    nextId() {
      if (this._nextId === null) {
        let max = 0;
        const re = /"\$id":"(\d+)"/g;
        let m;
        while ((m = re.exec(this.game.text))) { const v = +m[1]; if (v > max) max = v; }
        if (this.meta) { const v = +this.meta.value.$id; if (v > max) max = v; }
        this._nextId = max + 1;
      }
      return String(this._nextId++);
    }

    /* ----- summary / stats ----- */

    get info() {
      const m = this.meta ? this.meta.value : {};
      return {
        playerName: m.PlayerName,
        day: m.DayInSeason,
        year: m.Year,
        playtime: this.d.Player.Playtime,
        version: this.d.BuildVersion && this.d.BuildVersion.Version,
        build: this.d.BuildVersion && this.d.BuildVersion.BuildConfiguration,
        created: this.d.TimeCreated,
        lastPlayed: m.TimeLastPlayed,
        slotId: this.slotId,
      };
    }

    /** The wallet is a dedicated one-slot player inventory holding the coin item. */
    walletSlot() {
      for (const inv of this.list(this.d.Player.Inventories)) {
        const slots = this.list(inv.Slots);
        if (slots.length === 1 && itemGuid(slots[0]) === COIN_GUID) return slots[0];
      }
      return null;
    }

    get coins() {
      const s = this.walletSlot();
      return s ? s.ItemEntry.Amount : this.meta ? this.meta.value.Coins : 0;
    }

    set coins(n) {
      n = clampInt(n, 0, INT32_MAX);
      const s = this.walletSlot();
      if (!s) throw new Error('Coin wallet not found in this save.');
      s.ItemEntry.Amount = n;
      if (this.meta) this.meta.value.Coins = n;
    }

    /* ----- inventories ----- */

    /**
     * Player inventories. Kind and label come from the game data when
     * available, otherwise from a best-effort guess based on the contents.
     */
    inventories() {
      return this.list(this.d.Player.Inventories).map((inv, index) => {
        const slots = this.list(inv.Slots);
        const meta = this.invInfo[inv.Guid];
        let kind = 'container';
        if (meta && meta.kind) kind = meta.kind;
        else {
          const guids = slots.filter(isFilled).map(itemGuid);
          if (slots.length === 1 && guids[0] === COIN_GUID) kind = 'wallet';
          else if (slots.length >= 200) kind = 'unlocks';
          else if (guids.some((g) => this._cardGuids.has(g))) kind = 'cards';
        }
        return { owner: 'player', index, guid: inv.Guid, kind, label: meta ? meta.label : null, internalId: meta ? meta.id : null, inv, slots };
      });
    }

    /** Placed containers (chests) stored per room. */
    roomInventories() {
      const out = [];
      this.list(this.d.Rooms).forEach((room, roomIndex) => {
        this.list(room.Inventories).forEach((inv, index) => {
          out.push({ owner: 'room', roomIndex, roomGuid: room.Guid, roomName: this.roomNames[room.Guid] || null, index, guid: inv.Guid, kind: 'chest', inv, slots: this.list(inv.Slots) });
        });
      });
      return out;
    }

    allInventories() {
      return [...this.inventories(), ...this.roomInventories()];
    }

    setAmount(slot, amount) {
      if (!isFilled(slot)) throw new Error('Slot is empty.');
      const n = clampInt(amount, 1, INT32_MAX);
      slot.ItemEntry.Amount = n;
      if (slot === this.walletSlot() && this.meta) this.meta.value.Coins = n;
    }

    setQuality(slot, q) {
      if (!isFilled(slot)) throw new Error('Slot is empty.');
      q = clampInt(q, 0, 255);
      const old = slot.ItemEntry;
      // Json.NET writes ItemQualityLevel first and omits it when 0.
      const e = {};
      if (q > 0) e.ItemQualityLevel = q;
      for (const k of Object.keys(old)) if (k !== 'ItemQualityLevel') e[k] = old[k];
      slot.ItemEntry = e;
    }

    /** Put an item into an empty slot. */
    fillSlot(slot, itemGuid, amount, quality) {
      if (isFilled(slot)) throw new Error('Slot is not empty.');
      if (!GUID_RE.test(itemGuid)) throw new Error('Invalid item GUID: ' + itemGuid);
      if (itemGuid === COIN_GUID) throw new Error('Coins only exist in the wallet. Change them on the Overview tab.');
      const e = {};
      const q = clampInt(quality || 0, 0, 255);
      if (q > 0) e.ItemQualityLevel = q;
      e.Amount = clampInt(amount, 1, INT32_MAX);
      e.itemRef = { $id: this.nextId(), SerializedGuid: itemGuid };
      slot.ItemEntry = e;
    }

    clearSlot(slot) {
      slot.ItemEntry = {};
    }

    firstEmptySlot(invInfo) {
      return invInfo.slots.find((s) => !isFilled(s)) || null;
    }

    /**
     * Every item GUID known to this save: the game's item registry (Items)
     * plus anything referenced in an inventory. `owned` lists where the item
     * currently sits, which helps identify unnamed items.
     */
    catalog() {
      const map = new Map();
      const add = (g) => {
        if (!map.has(g)) map.set(g, { guid: g, owned: [], inRegistry: false });
        return map.get(g);
      };
      for (const it of this.list(this.d.Items)) add(it.Guid).inRegistry = true;
      for (const inv of this.allInventories()) {
        inv.slots.forEach((s, slotIndex) => {
          if (isFilled(s)) add(itemGuid(s)).owned.push({ inv, slotIndex, amount: s.ItemEntry.Amount });
        });
      }
      return map;
    }

    /* ----- export ----- */

    /**
     * Returns { kind: 'zip', name, bytes } or { kind: 'files', files: [{name, bytes}] },
     * plus `changed`: names of files whose content differs from the original.
     */
    async export() {
      const g = await encodeDocument(this.game);
      const m = this.meta ? await encodeDocument(this.meta) : null;
      const changed = [];
      if (this.bundle.mode === 'zip') {
        const names = this.bundle.slots.get(this.slotId);
        const entries = this.bundle.entries.map((e) => {
          let data = e.data;
          if (e.name === names.GameData && g.changed) { data = g.bytes; changed.push(e.name); }
          if (m && e.name === names.GameMetaData && m.changed) { data = m.bytes; changed.push(e.name); }
          return { name: e.name, data, dosTime: e.dosTime, dosDate: e.dosDate, externalAttr: e.externalAttr };
        });
        const bytes = await Archive.writeZip(entries);
        const base = this.bundle.zipName.replace(/\.zip$/i, '');
        return { kind: 'zip', name: base + '_edited.zip', bytes, changed };
      }
      const files = [];
      for (const l of this.bundle.loose) {
        if (l.doc === this.game && g.changed) { files.push({ name: l.name, bytes: g.bytes }); changed.push(l.name); }
        if (this.meta && l.doc === this.meta && m.changed) { files.push({ name: l.name, bytes: m.bytes }); changed.push(l.name); }
      }
      return { kind: 'files', files, changed };
    }
  }

  /**
   * Generic edit of a primitive field (advanced view). Keeps the field's JSON
   * type: integer fields only accept whole numbers (Json.NET would refuse
   * "1.5" for an int), float fields keep a decimal point ("3" -> "3.0").
   */
  function setPrimitive(doc, container, key, input) {
    const old = container[key];
    if (typeof old === 'number') {
      const n = Number(String(input).trim());
      if (String(input).trim() === '' || !Number.isFinite(n)) throw new Error('Not a number: ' + input);
      const m = doc.rawTable.get(container);
      const r = m && m.get(key);
      const isFloat = /[.eE]/.test(r ? r.raw : String(old));
      if (!isFloat) {
        if (!Number.isInteger(n)) throw new Error('This field only accepts whole numbers.');
        if (!Number.isSafeInteger(n)) throw new Error('Number too large.');
      }
      container[key] = n;
      if (isFloat && Number.isInteger(n) && !/e/i.test(String(n))) {
        let mm = doc.rawTable.get(container);
        if (!mm) doc.rawTable.set(container, (mm = new Map()));
        mm.set(key, { value: n, raw: String(n) + '.0' });
      }
      return container[key];
    }
    if (typeof old === 'string') return (container[key] = String(input));
    if (typeof old === 'boolean') return (container[key] = input === true || input === 'true');
    throw new Error('Only numbers, text and true/false values can be edited.');
  }

  /**
   * Json.NET writes an object referenced twice as {"$ref": "<$id>"} the
   * second time. The game does this when two stacks share one item reference
   * (stack splits, or items given by the in-game toolbox). Each $ref object
   * gets a non-enumerable link to its target, so lookups work and the JSON is
   * still written back unchanged.
   */
  function linkReferences(root) {
    const byId = new Map();
    const refs = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const v of o) walk(v); return; }
      if (typeof o.$id === 'string') byId.set(o.$id, o);
      if (typeof o.$ref === 'string') refs.push(o);
      for (const k in o) walk(o[k]);
    })(root);
    for (const r of refs) {
      const target = byId.get(r.$ref);
      if (target) Object.defineProperty(r, '__target', { value: target, enumerable: false });
    }
  }

  /** Item GUID of an inventory slot, following $ref links; null if empty. */
  function itemGuid(slot) {
    const ref = slot && slot.ItemEntry && slot.ItemEntry.itemRef;
    if (!ref) return null;
    if (ref.SerializedGuid) return ref.SerializedGuid;
    return (ref.__target && ref.__target.SerializedGuid) || null;
  }

  function isFilled(slot) {
    return !!itemGuid(slot);
  }

  function clampInt(v, lo, hi) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) throw new Error('Not a number: ' + v);
    return Math.min(hi, Math.max(lo, n));
  }

  return { loadBundle, openSlot, openDocument, encodeDocument, setPrimitive, isFilled, itemGuid, COIN_GUID, INT32_MAX, GUID_RE };
});
