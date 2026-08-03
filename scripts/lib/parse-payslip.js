import { basename } from 'node:path';
import { extractPdfItems, itemsToRows } from './pdf-text.js';

/**
 * 給与明細PDF（株式会社分析屋・Prawn 生成）を構造化する。
 *
 * 帳票は4列構成で、列は x 座標で分かれている：
 *   勤怠 x<164 / 支給 164〜305 / 控除 305〜450 / その他 x>=450
 * 各列は「左寄せの項目名」と「右寄せの金額」の組。
 * 項目名が長い場合は次の行に折り返されるため、金額を伴わない
 * 単独のラベル行は直前の項目名に連結する。
 */

const COL = {
  勤怠: (x) => x < 164,
  支給: (x) => x >= 164 && x < 305,
  控除: (x) => x >= 305 && x < 450,
  その他: (x) => x >= 450,
};

const AMOUNT_RE = /^-?[\d,]+$/;

export function parsePayslip(path) {
  const items = extractPdfItems(path);
  const rows = itemsToRows(items);
  const file = basename(path);
  const flat = rows.flatMap((r) => r.cells.map((c) => ({ ...c, rowY: r.y })));

  const findText = (re) => flat.find((c) => re.test(c.text));

  // 支給日：「2026(令和08)年07月17日支給分 給与明細」
  const title = findText(/支給分/)?.text ?? '';
  const dm = /(\d{4})\D*?(\d{1,2})月\s*(\d{1,2})日支給分/.exec(title.replace(/\(.*?\)/g, ''));
  if (!dm) throw new Error(`${file}: 支給日が読み取れません（"${title}"）`);
  const payDate = `${dm[1]}-${pad(dm[2])}-${pad(dm[3])}`;

  // 対象期間：「対象期間:」と同じ行の日付2つ
  const periodRow = rows.find((r) => r.cells.some((c) => /対象期間/.test(c.text)));
  const periodDates = (periodRow?.cells ?? [])
    .map((c) => /(\d{1,2})月\s*(\d{1,2})日/.exec(c.text))
    .filter(Boolean);
  let periodStart = null, periodEnd = null;
  if (periodDates.length >= 2) {
    const payYear = Number(dm[1]);
    const payMonth = Number(dm[2]);
    const pMonth = Number(periodDates[0][1]);
    // 支給月より対象月が大きければ前年（12月分を1月に支給するケース）
    const year = pMonth > payMonth ? payYear - 1 : payYear;
    periodStart = `${year}-${pad(periodDates[0][1])}-${pad(periodDates[0][2])}`;
    periodEnd = `${year}-${pad(periodDates[1][1])}-${pad(periodDates[1][2])}`;
  }

  // 差引支給額：ラベルと同じ行の金額
  const netRow = rows.find((r) => r.cells.some((c) => /差引支給額/.test(c.text)));
  const netAmount = toInt(netRow?.cells.find((c) => AMOUNT_RE.test(c.text))?.text);
  if (netAmount === null) throw new Error(`${file}: 差引支給額が読み取れません`);

  // 合計行（支給合計・控除合計）。「合計」ラベルが列ごとに2つ並ぶ。
  const totalRow = rows.find((r) => r.cells.filter((c) => c.text === '合計').length >= 1 && r.cells.some((c) => AMOUNT_RE.test(c.text)));
  const grossTotal = toInt(totalRow?.cells.find((c) => COL.支給(c.x) && AMOUNT_RE.test(c.text))?.text);
  const deductionTotal = toInt(totalRow?.cells.find((c) => COL.控除(c.x) && AMOUNT_RE.test(c.text))?.text);
  const otherTotalCell = toInt(totalRow?.cells.find((c) => COL.その他(c.x) && AMOUNT_RE.test(c.text))?.text);

  // 明細行（ヘッダ「勤怠/支給/控除」の行より下、合計行より上）
  const headerY = rows.find((r) => r.cells.some((c) => c.text === '支給'))?.y ?? Infinity;
  const totalY = totalRow?.y ?? -Infinity;
  const bodyRows = rows.filter((r) => r.y < headerY && r.y > totalY);

  const earnings = readColumn(bodyRows, COL.支給);
  const deductions = readColumn(bodyRows, COL.控除);
  const attendance = readColumn(bodyRows, COL.勤怠, false);
  // 「その他」列には年末調整の過不足税額などが入る。
  // 例：2025-12支給は 過不足税額 −26,670（還付）があり、これを入れないと検算が合わない。
  const others = readColumn(bodyRows, COL.その他);
  const otherTotal = otherTotalCell ?? sum(others);

  return {
    file,
    payDate,
    month: payDate.slice(0, 7),
    periodStart,
    periodEnd,
    periodMonth: periodStart ? periodStart.slice(0, 7) : null,
    grossTotal,
    deductionTotal,
    otherTotal,
    netAmount,
    earnings,
    deductions,
    others,
    attendance,
    // 検算：支給合計 − 控除合計 − その他合計 == 差引支給額
    checks: {
      netMatches: grossTotal !== null && deductionTotal !== null
        ? grossTotal - deductionTotal - otherTotal === netAmount : null,
      earningsSum: sum(earnings),
      deductionsSum: sum(deductions),
      othersSum: sum(others),
      earningsMatches: grossTotal !== null ? sum(earnings) === grossTotal : null,
      deductionsMatches: deductionTotal !== null ? sum(deductions) === deductionTotal : null,
    },
  };
}

/** 1列分を { 項目名: 金額 } に組み立てる */
function readColumn(bodyRows, inCol, numeric = true) {
  const out = {};
  let lastLabel = null;
  for (const row of bodyRows) {
    const cells = row.cells.filter((c) => inCol(c.x));
    if (cells.length === 0) continue;
    const labels = cells.filter((c) => !AMOUNT_RE.test(c.text));
    const amounts = cells.filter((c) => AMOUNT_RE.test(c.text));

    if (labels.length && amounts.length) {
      lastLabel = labels.map((l) => l.text).join('');
      out[lastLabel] = numeric ? toInt(amounts[0].text) : amounts[0].text;
    } else if (labels.length && lastLabel !== null) {
      // 折り返された項目名 → 直前の項目名に連結してキーを付け替える
      const merged = lastLabel + labels.map((l) => l.text).join('');
      out[merged] = out[lastLabel];
      delete out[lastLabel];
      lastLabel = merged;
    } else if (amounts.length && lastLabel !== null && !(lastLabel in out)) {
      out[lastLabel] = numeric ? toInt(amounts[0].text) : amounts[0].text;
    }
  }
  return out;
}

function sum(obj) {
  return Object.values(obj).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
}

function toInt(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).normalize('NFKC').replace(/[,\s円]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

function pad(n) { return String(n).padStart(2, '0'); }
