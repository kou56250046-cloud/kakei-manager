import { basename } from 'node:path';
import { readSjisLines, splitCsvLine } from './sjis.js';

/**
 * イオンゴールドカードの利用明細CSVを1ファイル解析する。
 *
 * ⚠ セキュリティ：行4-5 の「金融機関 / 支店 / 口座番号 / 名義人」は
 *    読み取らず、返り値にも一切含めない（仕様書 5.6 / 12章）。
 */

const DETAIL_HEADER_RE = /^ご利用日,利用者区分/;
const INSTALLMENT_RE = /^分割・ボーナス払い明細/;
const PAY_DATE_RE = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/;

/** `260616` → `2026-06-16`（先頭2桁 + 2000 が西暦年） */
export function parseUsageDate(yymmdd) {
  const s = String(yymmdd).trim();
  if (!/^\d{6}$/.test(s)) return null;
  const y = 2000 + Number(s.slice(0, 2));
  const m = s.slice(2, 4);
  const d = s.slice(4, 6);
  return `${y}-${m}-${d}`;
}

/** `１回` → `1回払い` / 空欄はそのまま */
function normalizePaymentMethod(v) {
  const s = String(v ?? '').normalize('NFKC').replace(/\s+/g, '');
  if (!s) return '';
  return /^\d+回$/.test(s) ? `${s}払い` : s;
}

export function parseMeisai(path) {
  const lines = readSjisLines(path);
  const file = basename(path);

  let cardName = '';
  let billed = null;
  let paymentDate = null;
  let detailStart = -1;
  let detailEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (detailStart === -1) {
      // ヘッダ部（行0-6）。口座情報の行は値を取り出さずスキップする。
      const cells = splitCsvLine(line);
      if (cells[0] === 'ご利用カード') cardName = (cells[1] ?? '').trim();
      else if (cells[0] === '今回ご請求金額') billed = toInt(cells[1]);
      else if (cells[0] === 'お支払い日') {
        const m = PAY_DATE_RE.exec(cells[1] ?? '');
        if (m) paymentDate = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      }
      if (DETAIL_HEADER_RE.test(line)) detailStart = i + 1;
      continue;
    }
    if (INSTALLMENT_RE.test(line)) { detailEnd = i; break; }
  }

  if (detailStart === -1) {
    throw new Error(`${file}: 明細ヘッダ行「ご利用日,利用者区分,...」が見つかりません`);
  }
  if (billed === null) {
    throw new Error(`${file}: 「今回ご請求金額」が読み取れません`);
  }

  const rows = [];
  for (let i = detailStart; i < detailEnd; i++) {
    const c = splitCsvLine(lines[i]);
    const date = parseUsageDate(c[0]);
    const amount = toInt(c[6]);
    if (date === null || amount === null) continue; // 空行・区切り行
    rows.push({
      date,
      cardHolder: (c[1] ?? '').trim(),
      merchantRaw: (c[2] ?? '').trim(),
      paymentMethod: normalizePaymentMethod(c[3]),
      amount,
      noteRaw: (c[7] ?? '').trim(),
    });
  }

  // 分割・ボーナス払いブロック（今回の5ファイルはいずれも0件）
  const installments = [];
  for (let i = detailEnd + 2; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const date = parseUsageDate(c[0]);
    if (date === null) continue;
    installments.push({
      date,
      merchantRaw: (c[1] ?? '').trim(),
      times: (c[2] ?? '').trim(),
      amount: toInt(c[3]),
      thisBilling: toInt(c[6]),
      fee: toInt(c[7]),
    });
  }

  const detailSum = rows.reduce((a, r) => a + r.amount, 0);
  const installmentSum = installments.reduce((a, r) => a + (r.thisBilling ?? 0), 0);

  return {
    file,
    cardName,
    billed,
    paymentDate,
    billingMonth: paymentDate ? paymentDate.slice(0, 7) : null,
    rows,
    installments,
    detailSum,
    installmentSum,
    // 検算：明細合計 + 分割今回請求分 == 今回ご請求金額
    diff: detailSum + installmentSum - billed,
  };
}

function toInt(v) {
  const s = String(v ?? '').normalize('NFKC').replace(/[,\s]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10); // 金額は必ず整数（円）。浮動小数点を使わない。
}

function pad(n) { return String(n).padStart(2, '0'); }
