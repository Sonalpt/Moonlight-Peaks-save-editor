(function () {
  'use strict';
  const M = window.MPSaveModel;
  const DB = window.MP_ITEM_DB || {};
  const INVENTORIES = window.MP_INVENTORIES || {};
  const ROOMS = window.MP_ROOMS || {};
  const $ = (id) => document.getElementById(id);

  /* ---------- small helpers ---------- */

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } },
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = kind || '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 8000 : 4000);
  }

  const shortGuid = (g) => g.slice(0, 8);
  const fmtInt = (n) => Number(n).toLocaleString('en-US');
  function fmtPlaytime(sec) {
    sec = Number(sec) || 0;
    return Math.floor(sec / 3600) + ' h ' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + ' min';
  }

  /* ---------- state ---------- */

  const state = {
    files: null, // [{name, bytes}] as opened, used to discard changes
    bundle: null,
    slotId: null,
    save: null,
    edits: 0,
    tab: 'overview',
    invKey: null,
    unlocked: new Set(), // inventory keys the user allowed editing on
    labels: store.get('mpse.labels', {}),
    invLabels: store.get('mpse.invLabels', {}),
  };

  // Quality levels seen in real saves; higher levels are not offered.
  const QUALITIES = [[0, 'Normal'], [1, '★'], [2, '★★']];

  // Default category filter when giving an item to these inventories.
  const INV_CATEGORY = {
    GameInventory_Tools: 'Tool', GameInventory_Spells: 'Spell', GameInventory_Forms: 'Form',
    GameInventory_NocturnaCards: 'Card', GameInventory_Upgrades: 'Upgrade', GameInventory_Customizations: 'Customization',
  };

  function itemName(guid) {
    return state.labels[guid] || (DB[guid] && DB[guid].n) || null;
  }
  function maxStack(guid) {
    return DB[guid] ? DB[guid].s : null;
  }
  function invKey(inv) {
    return inv.owner === 'player' ? 'p' + inv.index : 'r' + inv.roomIndex + '.' + inv.index;
  }
  function invLabel(inv) {
    if (state.invLabels[inv.guid]) return state.invLabels[inv.guid];
    if (inv.label) return inv.label;
    if (inv.kind === 'wallet') return 'Coin wallet';
    if (inv.kind === 'cards') return 'Card collection';
    if (inv.kind === 'unlocks') return 'Unlock list #' + inv.index;
    if (inv.kind === 'chest') return 'Chest · ' + (inv.roomName || 'area ' + inv.roomIndex);
    return 'Inventory #' + inv.index;
  }
  function isLocked(inv) {
    return (inv.kind === 'unlocks' || inv.kind === 'cards') && !state.unlocked.has(invKey(inv));
  }

  function edited(n) {
    state.edits += n || 1;
    updateHeader();
  }

  function updateHeader() {
    const s = $('status');
    if (!state.save) { s.textContent = ''; return; }
    s.textContent = state.edits ? state.edits + ' unsaved change' + (state.edits > 1 ? 's' : '') : 'No changes yet';
    s.className = state.edits ? 'dirty' : '';
    $('resetBtn').disabled = !state.edits;
  }

  /* ---------- loading ---------- */

  async function openFiles(fileList) {
    try {
      const files = [];
      for (const f of fileList) files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      if (!files.length) return;
      await loadFrom(files, null);
      toast('Save loaded: ' + (state.save.info.playerName || 'unknown player'), 'ok');
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), 'err');
    }
  }

  async function loadFrom(files, slotId) {
    const bundle = await M.loadBundle(files);
    let id = slotId;
    if (bundle.mode === 'zip' && !id) {
      id = bundle.slotIds[0];
      if (bundle.globalEntry) {
        try {
          const g = await M.openDocument(bundle.entries.find((e) => e.name === bundle.globalEntry).data);
          if (bundle.slotIds.includes(g.value.LastPlayedGameSave)) id = g.value.LastPlayedGameSave;
        } catch (_) { /* fall back to first slot */ }
      }
    }
    const save = await M.openSlot(bundle, id);
    save.invInfo = INVENTORIES;
    save.roomNames = ROOMS;
    Object.assign(state, { files, bundle, slotId: id, save, edits: 0, invKey: null });
    state.unlocked.clear();

    const pick = $('slotPick');
    const sel = $('slotSelect');
    sel.replaceChildren();
    if (bundle.mode === 'zip' && bundle.slotIds.length > 1) {
      for (const sid of bundle.slotIds) sel.append(h('option', { value: sid, selected: sid === id }, shortGuid(sid)));
      pick.hidden = false;
    } else {
      pick.hidden = true;
    }
    $('drop').hidden = true;
    $('editor').hidden = false;
    $('saveBtn').hidden = false;
    $('resetBtn').hidden = false;
    updateHeader();
    render();
  }

  /* ---------- saving ---------- */

  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function saveEdited() {
    try {
      const out = await state.save.export();
      if (!out.changed.length) { toast('Nothing changed yet. There is nothing to download.'); return; }
      if (out.kind === 'zip') {
        download(out.name, out.bytes);
        toast('Downloaded ' + out.name + '. Put it in your JKSV folder and restore it.', 'ok');
      } else {
        for (const f of out.files) download(f.name, f.bytes);
        toast('Downloaded ' + out.files.map((f) => f.name).join(' + ') + '. Copy back over the originals.', 'ok');
      }
    } catch (err) {
      console.error(err);
      toast('Could not build the save: ' + err.message, 'err');
    }
  }

  /* ---------- rendering ---------- */

  const TABS = [
    ['overview', 'Overview'],
    ['inventories', 'Inventories & chests'],
    ['names', 'Item list'],
    ['advanced', 'Advanced'],
  ];

  function render() {
    $('tabs').replaceChildren(...TABS.map(([id, label]) =>
      h('button', { class: state.tab === id ? 'active' : '', onclick: () => { state.tab = id; render(); } }, label)));
    const view = $('view');
    view.replaceChildren();
    if (state.tab === 'overview') view.append(renderOverview());
    else if (state.tab === 'inventories') view.append(renderInventories());
    else if (state.tab === 'names') view.append(renderNames());
    else view.append(renderAdvanced());
  }

  /* ----- overview ----- */

  function renderOverview() {
    const s = state.save;
    const info = s.info;
    const coinInput = h('input', { type: 'number', min: 0, max: M.INT32_MAX, step: 1, value: s.coins, style: 'width: 160px' });
    const setCoins = (v) => {
      try {
        const before = s.coins;
        s.coins = v;
        coinInput.value = s.coins;
        if (s.coins !== before) edited();
        if (s.coins > 9999999) toast('Very large amounts may not display well in the game UI.', '');
      } catch (err) { toast(err.message, 'err'); coinInput.value = s.coins; }
    };
    coinInput.addEventListener('change', () => setCoins(coinInput.value));

    return h('div', null,
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'label' }, 'Player'), h('div', { class: 'value' }, info.playerName || '?')),
        h('div', { class: 'card' }, h('div', { class: 'label' }, 'Date'), h('div', { class: 'value' }, 'Day ' + (info.day ?? '?') + ', Year ' + (info.year ?? '?'))),
        h('div', { class: 'card' }, h('div', { class: 'label' }, 'Playtime'), h('div', { class: 'value' }, fmtPlaytime(info.playtime))),
        h('div', { class: 'card' }, h('div', { class: 'label' }, 'Game version'), h('div', { class: 'value' }, info.version || '?'), h('div', { class: 'note mono' }, info.build || '')),
        h('div', { class: 'card wide' },
          h('div', { class: 'label' }, 'Coins'),
          h('div', { class: 'row', style: 'margin-top:6px' },
            coinInput,
            h('button', { onclick: () => setCoins(s.coins + 1000) }, '+1,000'),
            h('button', { onclick: () => setCoins(s.coins + 10000) }, '+10,000'),
            h('button', { onclick: () => setCoins(s.coins + 100000) }, '+100,000'),
            h('button', { onclick: () => setCoins(999999) }, 'Set 999,999')),
          h('p', { class: 'note' }, 'Updates both the coin wallet in GameData and the load-screen value in GameMetaData.'))),
      h('div', { class: 'callout' },
        h('b', null, 'Energy, mana and time of day are not stored in the save. '),
        'The game saves when you sleep and refills energy when you wake up, so the save always holds a fresh morning. ',
        'Those can only be changed while the game is running (cheats/overlay).'),
      Object.keys(DB).length < 10 ? h('div', { class: 'callout' }, h('b', null, 'Item database missing. '), 'data/items.js only has placeholder data, so items show as unnamed. See the README to generate it from your game backup.') : null,
      h('p', { class: 'note' }, 'Save slot ', h('code', null, info.slotId), ' · created ', (info.created || '').slice(0, 10), ' · last played ', (info.lastPlayed || '').slice(0, 16).replace('T', ' ')));
  }

  /* ----- inventories ----- */

  function renderInventories() {
    const s = state.save;
    const visible = s.allInventories().filter((i) => i.slots.length > 0);
    if (!state.invKey || !visible.some((i) => invKey(i) === state.invKey)) {
      const pref = visible.find((i) => i.internalId === 'GameInventory_Inventory') || visible.find((i) => i.kind === 'container') || visible[0];
      state.invKey = pref && invKey(pref);
    }
    const current = visible.find((i) => invKey(i) === state.invKey);

    const filled = (i) => i.slots.filter(M.isFilled).length;
    const btn = (i) => h('button', { class: invKey(i) === state.invKey ? 'active' : '', onclick: () => { state.invKey = invKey(i); render(); } },
      h('span', null, invLabel(i)), h('span', { class: 'count' }, filled(i) + '/' + i.slots.length));
    const groups = [
      ['Your inventories', visible.filter((i) => i.owner === 'player' && (i.kind === 'container' || i.kind === 'wallet'))],
      ['Chests', visible.filter((i) => i.owner === 'room')],
      ['Collections (careful)', visible.filter((i) => i.kind === 'unlocks' || i.kind === 'cards')],
    ];
    const list = h('div', { class: 'inv-list' }, groups.filter((g) => g[1].length).map(([title, items]) => [h('h4', null, title), items.map(btn)]));
    return h('div', { class: 'inv-layout' }, list, current ? renderInventory(current) : h('p', null, 'No inventories found.'));
  }

  function renderInventory(inv) {
    const locked = isLocked(inv);
    const empty = inv.slots.filter((x) => !M.isFilled(x)).length;
    const nameInput = h('input', { type: 'text', value: invLabel(inv), title: 'Rename this inventory (saved in your browser only)', style: 'width: 200px' });
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) state.invLabels[inv.guid] = v; else delete state.invLabels[inv.guid];
      store.set('mpse.invLabels', state.invLabels);
      render();
    });

    // Bulk edit: stacks of non-stackable items (max 1) and coins are skipped.
    const bulkTargets = () => inv.slots.filter((sl) => M.isFilled(sl) && M.itemGuid(sl) !== M.COIN_GUID &&
      (maxStack(M.itemGuid(sl)) || 1) > 1);
    const applyBulk = (amountFor) => {
      let n = 0;
      for (const sl of bulkTargets()) {
        const want = amountFor(maxStack(M.itemGuid(sl)));
        if (sl.ItemEntry.Amount !== want) { state.save.setAmount(sl, want); n++; }
      }
      if (n) edited(n);
      toast(n ? 'Updated ' + n + ' stack(s).' : 'No stacks changed.');
      render();
    };
    const bulk = h('input', { type: 'number', min: 1, value: 99, style: 'width: 90px' });

    const head = h('div', { class: 'inv-head' },
      h('h2', null, invLabel(inv)),
      h('span', { class: 'tag' }, inv.slots.length + ' slots · ' + empty + ' empty'),
      inv.internalId ? h('span', { class: 'tag mono', title: inv.guid }, inv.internalId) : h('span', { class: 'tag mono', title: inv.guid }, shortGuid(inv.guid)),
      h('span', { style: 'flex:1' }),
      nameInput);

    const tools = locked ? null : h('div', { class: 'row', style: 'margin-bottom: 12px' },
      h('button', { disabled: !empty, onclick: () => openPicker(inv, null) }, '+ Add item'),
      h('button', { onclick: () => applyBulk((max) => max), title: 'Set every stackable item to its maximum stack size' }, 'Max all stacks'),
      h('span', { class: 'note' }, 'or set every stack to'), bulk,
      h('button', { onclick: () => applyBulk((max) => Math.min(max, Math.max(1, Math.trunc(Number(bulk.value)) || 1))) }, 'Apply'),
      h('span', { class: 'note' }, 'Non-stackable items (tools, unique items) are left alone.'));

    const notes = [];
    if (inv.kind === 'unlocks') notes.push('This is a list of things you own or have learned (' + invLabel(inv).toLowerCase() + '), not a bag. Adding or removing entries unlocks or removes content.');
    if (inv.kind === 'cards') notes.push('This holds your Nocturna card collection.');
    const callouts = notes.map((n) => h('div', { class: 'callout' }, n));
    if (locked) {
      callouts.push(h('div', { class: 'callout' }, h('b', null, 'Read-only for safety. '),
        h('button', { class: 'small', onclick: () => { state.unlocked.add(invKey(inv)); render(); } }, 'Allow editing')));
    }

    const grid = h('div', { class: 'slots' }, inv.slots.map((sl, idx) => renderSlot(inv, sl, idx, locked)));
    return h('div', null, head, callouts, tools, grid);
  }

  function qualitySelect(current, enabled) {
    const sel = h('select', { disabled: !enabled, title: enabled ? 'Quality' : 'This item has no quality levels' },
      QUALITIES.map(([q, label]) => h('option', { value: q, selected: (current || 0) === q }, label)));
    return sel;
  }

  function renderSlot(inv, slot, idx, locked) {
    if (!M.isFilled(slot)) {
      return h('div', { class: 'slot empty' },
        h('div', { class: 'idx' }, 'Slot ' + (idx + 1)),
        locked ? h('span', null, 'empty') : h('button', { class: 'small', onclick: () => openPicker(inv, slot) }, '+ Add item'));
    }
    const e = slot.ItemEntry;
    const guid = M.itemGuid(slot);
    const info = DB[guid];
    const name = itemName(guid);
    const max = maxStack(guid);
    const amount = h('input', { type: 'number', min: 1, max: max || M.INT32_MAX, value: e.Amount, disabled: locked, title: max ? 'Max stack: ' + fmtInt(max) : 'Amount' });
    amount.addEventListener('change', () => {
      try {
        const before = e.Amount;
        let v = Math.trunc(Number(amount.value));
        if (max && v > max) { toast((name || 'This item') + ' stacks up to ' + fmtInt(max) + '.', ''); v = max; }
        state.save.setAmount(slot, v);
        amount.value = slot.ItemEntry.Amount;
        if (slot.ItemEntry.Amount !== before) edited();
      } catch (err) { toast(err.message, 'err'); amount.value = slot.ItemEntry.Amount; }
    });
    const canQuality = !locked && (!!(info && info.q) || !!e.ItemQualityLevel);
    const quality = qualitySelect(e.ItemQualityLevel, canQuality);
    quality.addEventListener('change', () => { state.save.setQuality(slot, quality.value); edited(); });

    return h('div', { class: 'slot' },
      h('div', { class: 'row', style: 'justify-content: space-between' },
        h('span', { class: 'idx' }, 'Slot ' + (idx + 1)),
        info ? h('span', { class: 'tag', title: info.i + '\n' + guid }, info.c + (max > 1 ? ' · max ' + fmtInt(max) : '')) : h('span', { class: 'tag mono', title: guid }, shortGuid(guid))),
      h('div', { class: 'name' + (name ? '' : ' unknown'), title: info ? info.i : guid }, name || 'Unknown item ' + shortGuid(guid)),
      e.CustomName ? h('div', { class: 'note' }, '“' + e.CustomName + '”') : null,
      h('div', { class: 'fields' },
        h('label', { class: 'note' }, 'Amount'), h('label', { class: 'note' }, 'Quality'),
        amount, quality),
      locked ? null : h('div', { class: 'acts' },
        h('button', { class: 'small danger', onclick: () => confirmRemove(slot, name, e.CustomName) }, 'Remove')));
  }

  function confirmRemove(slot, name, customName) {
    const close = () => back.remove();
    const back = h('div', { class: 'modal-back', onclick: (ev) => { if (ev.target === back) close(); } },
      h('div', { class: 'modal', style: 'width:min(440px,100%)' },
        h('header', null, h('h3', { style: 'margin:0' }, 'Remove this item?')),
        h('div', { class: 'body' },
          h('p', null, (name || 'This item') + ' will be removed from the slot.'),
          customName ? h('p', { class: 'note warn' }, 'It has a custom name (“' + customName + '”), so it may be a named creature or special item.') : null),
        h('footer', null,
          h('button', { class: 'danger', onclick: () => { state.save.clearSlot(slot); edited(); close(); render(); } }, 'Remove'),
          h('button', { onclick: close }, 'Cancel'))));
    document.body.append(back);
  }

  function setLabel(guid, text) {
    const v = String(text || '').trim();
    if (v) state.labels[guid] = v; else delete state.labels[guid];
    store.set('mpse.labels', state.labels);
  }

  /* ----- item catalogue (game database + anything referenced by the save) ----- */

  function catalogRows() {
    const cat = state.save.catalog();
    for (const g of Object.keys(DB)) if (!cat.has(g)) cat.set(g, { guid: g, owned: [], inRegistry: false });
    const rows = [];
    const isBag = (o) => o.inv.kind === 'container' || o.inv.kind === 'chest';
    for (const c of cat.values()) {
      if (c.guid === M.COIN_GUID) continue;
      const info = DB[c.guid];
      c.owned.sort((a, b) => isBag(b) - isBag(a));
      rows.push({ ...c, info, name: itemName(c.guid), cat: info ? info.c : 'Unknown', hidden: info ? !!info.h : false });
    }
    rows.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || (a.name || '').localeCompare(b.name || '') || a.guid.localeCompare(b.guid));
    return rows;
  }
  function whereText(c) {
    if (!c.owned.length) return '';
    return 'You have: ' + c.owned.slice(0, 3).map((o) => invLabel(o.inv) + ' ×' + fmtInt(o.amount)).join(', ') + (c.owned.length > 3 ? ' …' : '');
  }
  function matches(c, q) {
    return !q || (c.name || '').toLowerCase().includes(q) || c.guid.includes(q) || (c.info && c.info.i.toLowerCase().includes(q));
  }

  function openPicker(inv, slot) {
    const rows = catalogRows();
    const cats = [...new Set(rows.map((r) => r.cat))].sort();
    const defCat = INV_CATEGORY[inv.internalId] || '';
    let selected = null;
    const search = h('input', { type: 'search', placeholder: 'Search items…', style: 'width:100%' });
    const catSel = h('select', null, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c, selected: c === defCat }, c)));
    const showHidden = h('input', { type: 'checkbox' });
    const results = h('div');
    const amount = h('input', { type: 'number', min: 1, value: 1, style: 'width:100px' });
    const quality = qualitySelect(0, false);
    const selLabel = h('span', { class: 'note' }, 'Pick an item');
    const addBtn = h('button', { class: 'primary', disabled: true }, 'Add');
    const close = () => back.remove();

    function select(c) {
      selected = c;
      const max = c.info ? c.info.s : null;
      selLabel.textContent = (c.name || 'Unknown item') + (max ? ' · max ' + fmtInt(max) : '');
      amount.max = max || M.INT32_MAX;
      if (max && Number(amount.value) > max) amount.value = max;
      quality.disabled = !(c.info && c.info.q);
      if (quality.disabled) quality.value = 0;
      addBtn.disabled = false;
      draw();
    }
    function draw() {
      const q = search.value.trim().toLowerCase();
      const list = rows.filter((c) => (showHidden.checked || !c.hidden) && (!catSel.value || c.cat === catSel.value) && matches(c, q));
      if (q) {
        // Name matches first (names starting with the query before others), then internal-id/GUID matches.
        const rank = (c) => { const n = (c.name || '').toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2; };
        list.sort((a, b) => rank(a) - rank(b));
      }
      results.replaceChildren(...list.slice(0, 200).map((c) =>
        h('div', { class: 'pick-row' + (selected === c ? ' sel' : ''), onclick: () => select(c) },
          h('span', { class: c.name ? '' : 'note' }, c.name || 'Unknown item ' + shortGuid(c.guid)),
          h('span', { class: 'row', style: 'gap:6px' },
            c.info && c.info.s > 1 ? h('span', { class: 'tag' }, '×' + fmtInt(c.info.s)) : null,
            h('span', { class: 'tag', title: c.info ? c.info.i : c.guid }, c.cat)),
          h('span', { class: 'where' }, whereText(c)))),
      list.length > 200 ? h('p', { class: 'note' }, (list.length - 200) + ' more. Refine your search.') : '',
      list.length ? '' : h('p', { class: 'note' }, 'No match.'));
    }
    search.addEventListener('input', draw);
    catSel.addEventListener('change', draw);
    showHidden.addEventListener('change', draw);
    addBtn.addEventListener('click', () => {
      if (!selected) return;
      try {
        const target = slot || state.save.firstEmptySlot(inv);
        if (!target) throw new Error('This inventory has no empty slot.');
        const max = selected.info ? selected.info.s : null;
        const n = Math.max(1, Math.min(max || M.INT32_MAX, Math.trunc(Number(amount.value)) || 1));
        state.save.fillSlot(target, selected.guid, n, quality.disabled ? 0 : quality.value);
        edited();
        close();
        render();
        toast('Added ' + (selected.name || shortGuid(selected.guid)) + ' ×' + target.ItemEntry.Amount + ' to ' + invLabel(inv) + '.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    const back = h('div', { class: 'modal-back', onclick: (ev) => { if (ev.target === back) close(); } },
      h('div', { class: 'modal' },
        h('header', null, h('h3', { style: 'margin:0' }, 'Add item to ' + invLabel(inv))),
        h('div', { class: 'body' },
          h('div', { class: 'row', style: 'margin-bottom:8px' }, search),
          h('div', { class: 'row note', style: 'margin-bottom:8px' }, catSel,
            h('label', { class: 'row' }, showHidden, 'Show internal/test items')),
          results),
        h('footer', null, selLabel, h('span', { style: 'flex:1' }),
          h('label', { class: 'row note' }, 'Amount', amount),
          h('label', { class: 'row note' }, 'Quality', quality),
          addBtn, h('button', { onclick: close }, 'Cancel'))));
    document.body.append(back);
    draw();
    search.focus();
  }

  /* ----- item list ----- */

  function renderNames() {
    const rows = catalogRows();
    const search = h('input', { type: 'search', placeholder: 'Search items…', style: 'width: 240px' });
    const ownedOnly = h('input', { type: 'checkbox', checked: true });
    const tbody = h('tbody');
    const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });

    function draw() {
      const q = search.value.trim().toLowerCase();
      const list = rows.filter((c) => (!ownedOnly.checked || c.owned.length) && matches(c, q));
      tbody.replaceChildren(...list.slice(0, 300).map((c) => {
        const inp = h('input', { type: 'text', value: state.labels[c.guid] || '', placeholder: (c.info && c.info.n) || 'add a name' });
        inp.addEventListener('change', () => setLabel(c.guid, inp.value));
        return h('tr', null,
          h('td', { style: 'width:30%' }, inp),
          h('td', null, c.cat),
          h('td', null, c.info ? fmtInt(c.info.s) : '?'),
          h('td', { class: 'note' }, whereText(c) || '—'),
          h('td', { class: 'mono note' }, c.info ? c.info.i : c.guid));
      }));
      if (list.length > 300) tbody.append(h('tr', null, h('td', { colspan: 5, class: 'note' }, (list.length - 300) + ' more rows. Use the search.')));
    }
    search.addEventListener('input', draw);
    ownedOnly.addEventListener('change', draw);
    importInput.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await importInput.files[0].text());
        let n = 0;
        for (const [g, v] of Object.entries(data)) {
          const name = typeof v === 'string' ? v : v && v.name;
          if (M.GUID_RE.test(g) && name) { state.labels[g] = String(name); n++; }
        }
        store.set('mpse.labels', state.labels);
        toast('Imported ' + n + ' custom names.', 'ok');
        render();
      } catch (err) { toast('Import failed: ' + err.message, 'err'); }
    });
    draw();
    return h('div', null,
      h('p', { class: 'note' }, Object.keys(DB).length + ' items in the game database. The first column shows the game’s English name; type in it to use your own name instead (kept in this browser).'),
      h('div', { class: 'row', style: 'margin-bottom:10px' }, search,
        h('label', { class: 'row note' }, ownedOnly, 'Only items I own'),
        h('span', { style: 'flex:1' }),
        h('button', { onclick: () => download('moonlight-peaks-item-names.json', new TextEncoder().encode(JSON.stringify(state.labels, null, 2))) }, 'Export custom names'),
        h('button', { onclick: () => importInput.click() }, 'Import custom names'), importInput),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Category'), h('th', null, 'Max stack'), h('th', null, 'Where'), h('th', null, 'Internal id'))),
        tbody)));
  }

  /* ----- advanced raw editor ----- */

  function renderAdvanced() {
    const docs = [['GameData', state.save.game]];
    if (state.save.meta) docs.push(['GameMetaData', state.save.meta]);
    const sel = h('select', null, docs.map(([n], i) => h('option', { value: i }, n)));
    const holder = h('div', { class: 'tree' });
    const draw = () => {
      const [, doc] = docs[Number(sel.value)];
      holder.replaceChildren(...Object.keys(doc.value).filter((k) => k !== '$id').map((k) => treeNode(doc, doc.value, k)));
    };
    sel.addEventListener('change', draw);
    draw();
    return h('div', null,
      h('div', { class: 'callout' }, h('b', null, 'Raw editor. '), 'Every value in the save can be changed here. Field types are enforced (whole numbers stay whole). Wrong values can break quests or crash the game, so change one thing at a time and test.'),
      h('div', { class: 'row', style: 'margin-bottom:8px' }, 'File', sel),
      holder);
  }

  function isWrapper(v) { return v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.$values); }

  // Human-readable hint for GUID references (items, inventories, rooms).
  function guidHint(g) {
    if (!g) return '';
    if (DB[g]) return DB[g].n;
    if (INVENTORIES[g]) return INVENTORIES[g].label;
    if (ROOMS[g]) return ROOMS[g];
    return '';
  }

  function treeNode(doc, container, key) {
    const v = container[key];
    if (v !== null && typeof v === 'object') {
      const items = isWrapper(v) ? v.$values : v;
      const keys = Array.isArray(items) ? null : Object.keys(items).filter((k) => k !== '$id');
      const count = keys ? keys.length : items.length;
      const preview = Array.isArray(items) ? '[' + count + ']' : '{' + count + '}';
      let hint = '';
      if (!Array.isArray(items)) {
        const g = items.Guid || items.SerializedGuid || (items.itemRef && items.itemRef.SerializedGuid) || (items.ItemEntry && M.itemGuid(items));
        hint = guidHint(g) || g || '';
        if (items.ItemEntry && items.ItemEntry.Amount) hint += ' ×' + items.ItemEntry.Amount;
      }
      const det = h('details', null, h('summary', null, h('span', { class: 'k' }, String(key)), ' ', h('span', { class: 'meta' }, preview + (hint ? '  ' + hint : ''))));
      let rendered = false;
      det.addEventListener('toggle', () => {
        if (!det.open || rendered) return;
        rendered = true;
        if (keys) { for (const k of keys) det.append(treeNode(doc, items, k)); return; }
        let shown = 0;
        const more = h('button', { class: 'small more' }, 'Show more');
        const step = () => {
          const end = Math.min(items.length, shown + 100);
          for (; shown < end; shown++) det.insertBefore(treeNode(doc, items, shown), more);
          more.hidden = shown >= items.length;
          more.textContent = 'Show more (' + (items.length - shown) + ' left)';
        };
        det.append(more);
        more.addEventListener('click', step);
        step();
      });
      return det;
    }
    const row = h('div', { class: 'prim' }, h('span', { class: 'k' }, String(key)));
    if (v === null) { row.append(h('span', { class: 'meta' }, 'null')); return row; }
    if (typeof v === 'boolean') {
      const cb = h('input', { type: 'checkbox', checked: v });
      cb.addEventListener('change', () => { M.setPrimitive(doc, container, key, cb.checked); edited(); });
      row.append(cb);
      return row;
    }
    const inp = h('input', { type: 'text', value: String(v) });
    inp.addEventListener('change', () => {
      try {
        if (M.setPrimitive(doc, container, key, inp.value) !== v) edited();
        inp.value = String(container[key]);
      } catch (err) { toast(err.message, 'err'); inp.value = String(container[key]); }
    });
    row.append(inp, h('span', { class: 'meta' }, typeof v === 'string' && guidHint(v) ? guidHint(v) : typeof v));
    return row;
  }

  /* ---------- wiring ---------- */

  const fileInput = $('fileInput');
  const pickFiles = () => { fileInput.value = ''; fileInput.click(); };
  $('openBtn').addEventListener('click', pickFiles);
  $('openBtn2').addEventListener('click', pickFiles);
  fileInput.addEventListener('change', () => openFiles(fileInput.files));
  $('saveBtn').addEventListener('click', saveEdited);
  $('resetBtn').addEventListener('click', async () => {
    if (!state.files) return;
    await loadFrom(state.files, state.slotId);
    toast('All changes discarded.');
  });
  $('slotSelect').addEventListener('change', async (ev) => {
    await loadFrom(state.files, ev.target.value);
    toast('Switched save slot. Unsaved edits on the previous slot were discarded.');
  });

  document.body.addEventListener('dragover', (ev) => { ev.preventDefault(); $('drop').classList.add('over'); });
  document.body.addEventListener('dragleave', (ev) => { if (ev.target === document.body || ev.target === $('drop')) $('drop').classList.remove('over'); });
  document.body.addEventListener('drop', (ev) => {
    ev.preventDefault();
    $('drop').classList.remove('over');
    if (ev.dataTransfer.files.length) openFiles(ev.dataTransfer.files);
  });
  window.addEventListener('beforeunload', (ev) => { if (state.edits) { ev.preventDefault(); ev.returnValue = ''; } });
})();
