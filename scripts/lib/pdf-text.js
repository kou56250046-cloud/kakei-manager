import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * 依存パッケージなしの最小 PDF テキスト抽出器。
 *
 * 給与明細PDF（Prawn 生成・TrueType サブセット + ToUnicode CMap）から
 * 「座標付きテキスト片」を取り出し、行として組み直す。
 * 表形式の帳票を読むには位置情報が必須なので、単純な文字列連結ではなく
 * BT..ET ブロックごとに (x, y, text) を持たせている。
 *
 * 対応範囲は割り切っている：回転・スケーリングを伴う cm/Tm は扱わない
 * （対象PDFは平行移動のみ）。想定外の変換が来た場合は座標がずれるため、
 * 呼び出し側で必ず抽出結果を目視確認すること。
 */

export function extractPdfItems(path) {
  const buf = readFileSync(path);
  const raw = buf.toString('latin1');
  const objects = parseObjects(raw, buf);

  // フォント資源名 → ToUnicode マップ
  const fontMaps = new Map();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue;
    const m = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (!m) continue;
    const cmapObj = objects.get(Number(m[1]));
    if (cmapObj) fontMaps.set(num, parseCMap(decodeStream(cmapObj).toString('latin1')));
  }

  // /Pages の /Kids を辿って実ページを特定する。
  // ※ 単に「最初の /Type /Page」を拾うと、Prawn が出力する空の先頭ページを
  //    掴んでしまい抽出結果が0件になる。必ず Kids 経由で解決すること。
  const pagesObj = [...objects.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict));
  const kids = pagesObj
    ? [...(/\/Kids\s*\[([^\]]*)\]/.exec(pagesObj.dict)?.[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
    : [];
  const pageObjs = kids.map((n) => objects.get(n)).filter(Boolean);
  if (pageObjs.length === 0) throw new Error(`${path}: ページが見つかりません`);

  const items = [];
  for (const pageObj of pageObjs) {
    // ページの Resources から /Fx.y → フォントオブジェクト番号を引く
    const resFontMap = new Map();
    for (const m of pageObj.dict.matchAll(/\/(F[\d.]+)\s+(\d+)\s+\d+\s+R/g)) {
      resFontMap.set(m[1], fontMaps.get(Number(m[2])) ?? new Map());
    }
    // 参照している Form XObject（Stamp）。
    // 対象PDFの Form はいずれも /Matrix なし・全面 BBox なので座標系は共通。
    const xobjMap = new Map();
    for (const m of pageObj.dict.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
      if (/^F[\d.]+$/.test(m[1])) continue;
      xobjMap.set(m[1], Number(m[2]));
    }
    const visit = (objNum, depth = 0, ctm = IDENTITY) => {
      const o = objects.get(objNum);
      if (!o || depth > 8) return;
      const content = decodeStream(o).toString('latin1');
      // Form XObject の /Matrix があれば現在の CTM に合成する
      const fm = /\/Matrix\s*\[([^\]]+)\]/.exec(o.dict);
      const localCtm = fm
        ? matMul(fm[1].trim().split(/\s+/).map(Number), ctm)
        : ctm;
      extractFromContent(content, resFontMap, items, (name, curCtm) => {
        const n = xobjMap.get(name);
        if (n !== undefined) visit(n, depth + 1, curCtm);
      }, localCtm);
    };
    const cm = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageObj.dict);
    if (cm) visit(Number(cm[1]));
  }

  return items;
}

/** (x,y,text) の配列を、y 座標でグルーピングして行に組み直す */
export function itemsToRows(items, yTolerance = 2.5) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= yTolerance) last.cells.push(it);
    else rows.push({ y: it.y, cells: [it] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  return rows;
}

// ---------------------------------------------------------------- 内部実装

function parseObjects(raw, buf) {
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const num = Number(m[1]);
    const end = raw.indexOf('endobj', m.index);
    if (end < 0) continue;
    const body = raw.slice(m.index + m[0].length, end);
    const si = body.indexOf('stream');
    let dict = body;
    let stream = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      // stream キーワード直後の EOL をスキップ
      let s = m.index + m[0].length + si + 'stream'.length;
      if (raw[s] === '\r') s++;
      if (raw[s] === '\n') s++;
      const e = raw.indexOf('endstream', s);
      stream = buf.subarray(s, e);
    }
    objects.set(num, { num, dict, stream });
  }
  return objects;
}

function decodeStream(obj) {
  if (!obj.stream) return Buffer.alloc(0);
  if (/\/Filter\s*\[?\s*\/FlateDecode/.test(obj.dict)) {
    try { return inflateSync(obj.stream); } catch { return Buffer.alloc(0); }
  }
  return obj.stream;
}

function parseCMap(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dst = parseInt(m[3], 16);
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(dst + (c - lo)));
    }
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const dsts = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)];
      dsts.forEach((d, i) => map.set(lo + i, hexToUnicode(d[1])));
    }
  }
  return map;
}

function hexToUnicode(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const cp = parseInt(hex.slice(i, i + 4), 16);
    if (!Number.isNaN(cp)) out += String.fromCharCode(cp);
  }
  return out;
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m1 × m2（PDFの [a b c d e f] 形式） */
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * コンテンツストリームを線形に走査してテキスト片を取り出す。
 *
 * ★ この帳票は表のセルをすべて同じテキスト座標に描き、行と列の位置を
 *   cm（CTM）で与えている。cm を無視すると全セルが1点に重なるため、
 *   グラフィックス状態スタック（q/Q）と行列演算は省略できない。
 */
function extractFromContent(content, resFontMap, items, onXObject, initialCTM = IDENTITY) {
  let ctm = initialCTM;
  const stack = [];
  let tm = IDENTITY;   // テキスト行列
  let tlm = IDENTITY;  // テキスト行行列
  let font = new Map();
  let pending = null;  // { x, y, text }

  const flush = () => {
    if (pending && pending.text.trim()) items.push({ x: pending.x, y: pending.y, text: pending.text.trim() });
    pending = null;
  };
  const setPos = () => {
    // テキスト原点 (0,0) を Tm → CTM の順に変換する
    const x0 = tm[4], y0 = tm[5];
    const x = ctm[0] * x0 + ctm[2] * y0 + ctm[4];
    const y = ctm[1] * x0 + ctm[3] * y0 + ctm[5];
    flush();
    pending = { x, y, text: '' };
  };

  const tokenRe = new RegExp(
    [
      /(?<nums>(?:-?[\d.]+\s+){1,6})(?<op>cm|Td|TD|Tm)\b/.source,
      /(?<q>\bq\b)|(?<Q>\bQ\b)|(?<BT>\bBT\b)|(?<ET>\bET\b)|(?<Tstar>\bT\*)/.source,
      /\/(?<fontName>F[\d.]+)\s+[\d.]+\s+Tf/.source,
      /<(?<hex>[0-9a-fA-F\s]*)>\s*Tj/.source,
      /\((?<lit>(?:\\.|[^)])*)\)\s*Tj/.source,
      /\[(?<tj>[\s\S]*?)\]\s*TJ/.source,
      /\/(?<xobj>[\w.]+)\s+Do\b/.source,
    ].join('|'),
    'g',
  );

  let t;
  while ((t = tokenRe.exec(content))) {
    const g = t.groups;
    if (g.op) {
      const n = g.nums.trim().split(/\s+/).map(Number);
      if (g.op === 'cm' && n.length === 6) ctm = matMul(n, ctm);
      else if (g.op === 'Tm' && n.length === 6) { tlm = n; tm = n; setPos(); }
      else if ((g.op === 'Td' || g.op === 'TD') && n.length === 2) {
        tlm = matMul([1, 0, 0, 1, n[0], n[1]], tlm); tm = tlm; setPos();
      }
    } else if (g.q) { stack.push(ctm); }
    else if (g.Q) { ctm = stack.pop() ?? ctm; }
    else if (g.BT) { flush(); tm = IDENTITY; tlm = IDENTITY; }
    else if (g.ET) { flush(); }
    else if (g.Tstar) { tlm = matMul([1, 0, 0, 1, 0, -12], tlm); tm = tlm; setPos(); }
    else if (g.fontName) { font = resFontMap.get(g.fontName) ?? new Map(); }
    else if (g.hex !== undefined) { if (pending) pending.text += decodeHexString(g.hex, font); }
    else if (g.lit !== undefined) { if (pending) pending.text += decodeLiteral(g.lit, font); }
    else if (g.tj !== undefined) {
      for (const p of g.tj.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^)])*)\)/g)) {
        const s = p[1] !== undefined ? decodeHexString(p[1], font) : decodeLiteral(p[2], font);
        if (pending) pending.text += s;
      }
    } else if (g.xobj) { flush(); onXObject(g.xobj, ctm); }
  }
  flush();
}

function decodeHexString(hex, font) {
  const h = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < h.length + 1; i += 2) {
    const code = parseInt(h.slice(i, i + 2), 16);
    if (Number.isNaN(code)) continue;
    out += font.get(code) ?? String.fromCharCode(code);
  }
  return out;
}

function decodeLiteral(str, font) {
  const unescaped = str.replace(/\\([nrtbf()\\]|\d{1,3})/g, (s, g) => {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return simple[g] ?? String.fromCharCode(parseInt(g, 8));
  });
  let out = '';
  for (const ch of unescaped) out += font.get(ch.charCodeAt(0)) ?? ch;
  return out;
}
