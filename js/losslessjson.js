/*
 * Lossless JSON parse/stringify.
 *
 * The game writes its saves with Newtonsoft Json.NET, whose number/string
 * formatting differs slightly from JavaScript's (e.g. "0.0" vs "0",
 * "-8.742278E-08" vs "-8.742278e-8"). To guarantee that untouched parts of a
 * save are written back byte-for-byte, the parser records the original source
 * text of every primitive whose JavaScript re-encoding would differ. On
 * stringify, that source text is reused as long as the value was not changed.
 *
 * Values stay plain JS objects/arrays/primitives, so editing code needs no
 * special handling.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LosslessJSON = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  function parse(text) {
    // container -> Map(key -> { value, raw })
    const rawTable = new WeakMap();
    let i = 0;
    const n = text.length;

    function fail(msg) {
      throw new SyntaxError(msg + ' at position ' + i);
    }
    function ws() {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 10 || c === 13 || c === 9) i++;
        else break;
      }
    }
    function remember(container, key, value, raw) {
      let m = rawTable.get(container);
      if (!m) rawTable.set(container, (m = new Map()));
      m.set(key, { value, raw });
    }
    function parseString() {
      // assumes text[i] === '"'
      const start = i;
      i++;
      let hasEscape = false;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 34) break; // "
        if (c === 92) { hasEscape = true; i += 2; continue; } // backslash
        i++;
      }
      if (i >= n) fail('Unterminated string');
      i++;
      const raw = text.slice(start, i);
      const value = hasEscape ? JSON.parse(raw) : raw.slice(1, -1);
      return { value, raw };
    }
    function parseValue(container, key) {
      ws();
      const c = text[i];
      if (c === '{') return parseObject();
      if (c === '[') return parseArray();
      if (c === '"') {
        const s = parseString();
        if (container && JSON.stringify(s.value) !== s.raw) remember(container, key, s.value, s.raw);
        return s.value;
      }
      if (c === 't' && text.startsWith('true', i)) { i += 4; return true; }
      if (c === 'f' && text.startsWith('false', i)) { i += 5; return false; }
      if (c === 'n' && text.startsWith('null', i)) { i += 4; return null; }
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(text);
      if (!m) fail('Unexpected character ' + JSON.stringify(c));
      i += m[0].length;
      const value = Number(m[0]);
      if (container && String(value) !== m[0]) remember(container, key, value, m[0]);
      return value;
    }
    function parseObject() {
      i++; // {
      const obj = {};
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected key');
        const k = parseString();
        if (JSON.stringify(k.value) !== k.raw) fail('Unsupported escaped key');
        if (/^(?:0|[1-9]\d*)$/.test(k.value)) fail('Unsupported numeric key (would reorder)');
        ws();
        if (text[i] !== ':') fail('Expected :');
        i++;
        const v = parseValue(obj, k.value);
        if (k.value === '__proto__') Object.defineProperty(obj, k.value, { value: v, enumerable: true, writable: true, configurable: true });
        else obj[k.value] = v;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('Expected , or }');
      }
    }
    function parseArray() {
      i++; // [
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(parseValue(arr, arr.length));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('Expected , or ]');
      }
    }

    const value = parseValue(null, null);
    ws();
    if (i !== n) fail('Trailing data');
    return { value, rawTable };
  }

  function stringify(value, rawTable) {
    const out = [];
    function prim(container, key, v) {
      const m = rawTable && rawTable.get(container);
      if (m) {
        const r = m.get(key);
        if (r && Object.is(r.value, v)) return r.raw;
      }
      if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('Non-finite number at key ' + key);
      return JSON.stringify(v);
    }
    function emit(container, key, v) {
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v)) {
          out.push('[');
          for (let j = 0; j < v.length; j++) {
            if (j) out.push(',');
            emit(v, j, v[j]);
          }
          out.push(']');
        } else {
          out.push('{');
          let first = true;
          for (const k of Object.keys(v)) {
            if (v[k] === undefined) continue;
            if (!first) out.push(',');
            first = false;
            out.push(JSON.stringify(k), ':');
            emit(v, k, v[k]);
          }
          out.push('}');
        }
      } else {
        out.push(prim(container, key, v));
      }
    }
    emit(null, null, value);
    return out.join('');
  }

  return { parse, stringify };
});
