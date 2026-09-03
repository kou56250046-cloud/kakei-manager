import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * ドコモの「ご利用料金の内訳」ページをコピーしたテキストを読む。
 *
 * ★ 電話番号は絶対に保存しない（parse-meisai.js が口座番号・名義人を読み捨てるのと同じ理由）。
 *    ここでは回線数の数え上げと検算にだけ使い、返り値には含めない。
 *
 * 形式は「ラベル / 空行 / 金額 / 円」の繰り返し。
 * コピー元にゼロ幅スペース（U+200B）が混ざるため、必ず除去してから読む。
 *
 * 検算：回線ごとの金額の合計 ＝ 「合計」欄。
 *   （内訳の (計) 項目の合計とも一致するが、回線側のほうが表記の揺れに強い）
 *   カード明細と同じく、不一致でも中止はしない。
 */

// 「7月（8月請求分）」「2026年7月」のどちらでも読めるようにする
const RE_YEAR_MONTH = /(20\d{2})\s*年\s*(\d{1,2})\s*月/;
const RE_MONTH = /(\d{1,2})\s*月/;
const RE_BILLING = /（\s*(\d{1,2})\s*月請求分\s*）/;
const RE_PHONE = /^0\d{1,3}-\d{2,4}-\d{4}/;

// 継続しない費用（回線を足した月などに出る）
const ONE_TIME_LABELS = ['契約事務手数料', '解約金', '違約金'];

export function parseDcard(path, today = new Date().toISOString().slice(0, 10)) {
  const raw = readFileSync(path, 'utf8').replace(/[​‎‏﻿]/g, '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

  const file = basename(path);
  const { usageMonth, billingMonth } = monthsFromName(file, today);

  const total = valueAfter(lines, (l) => l === '合計');

  // 回線ごとの金額（電話番号の次に来る数値）。番号そのものは持ち回らない
  let lineSum = 0;
  let lineCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!RE_PHONE.test(lines[i])) continue;
    const v = nextNumber(lines, i + 1);
    if (v === null) continue;
    lineSum += v;
    lineCount++;
  }

  // 内訳の (計) 項目。金額そのものは記録せず、名前と額だけ返す（検算の補助）
  const breakdown = [];
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i];
    if (!/（計）$/.test(label)) continue;
    const v = nextNumber(lines, i + 1);
    if (v !== null) breakdown.push({ name: label, amount: v });
  }
  // 「端末等代金分割支払金」は (計) が付かないが独立した項目なので拾う
  const installment = valueAfter(lines, (l) => l === '端末等代金分割支払金');
  if (installment !== null) breakdown.push({ name: '端末等代金分割支払金', amount: installment });

  const breakdownSum = breakdown.reduce((a, b) => a + b.amount, 0);

  // その月かぎりの費用。翌月と比べたときに「値上がり」と見えてしまうため、
  // 何が乗っているかを記録に残す（金額は (計) 側に含まれるので検算には足さない）
  const oneTime = [];
  for (const name of ONE_TIME_LABELS) {
    const v = valueAfter(lines, (l) => l === name);
    if (v !== null) oneTime.push({ name, amount: v });
  }

  return {
    file,
    usageMonth,
    billingMonth,
    amount: total ?? 0,
    lineSum,
    lineCount,
    breakdown,
    breakdownSum,
    oneTime,
    diff: (total ?? 0) - lineSum,
  };
}

/**
 * ファイル名から利用月と請求月を決める。
 * 年が書かれていない場合は「実行日から見て直近の過去」として補う
 * （未来の月になったら前年と解釈する）。
 */
function monthsFromName(file, today) {
  const [ty, tm] = today.split('-').map(Number);

  const ym = file.match(RE_YEAR_MONTH);
  let year = null, month = null;
  if (ym) {
    year = Number(ym[1]);
    month = Number(ym[2]);
  } else {
    const m = file.match(RE_MONTH);
    if (!m) return { usageMonth: null, billingMonth: null };
    month = Number(m[1]);
    year = month > tm ? ty - 1 : ty;
  }

  const usageMonth = `${year}-${pad(month)}`;

  const b = file.match(RE_BILLING);
  let billingMonth = null;
  if (b) {
    const bm = Number(b[1]);
    // 請求月が利用月より小さければ年をまたいでいる（12月利用 → 1月請求）
    billingMonth = `${bm < month ? year + 1 : year}-${pad(bm)}`;
  } else {
    // 表記がなければドコモの既定（利用月の翌月請求）
    const d = new Date(Date.UTC(year, month, 1));
    billingMonth = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  }

  return { usageMonth, billingMonth };
}

function valueAfter(lines, match) {
  for (let i = 0; i < lines.length; i++) {
    if (match(lines[i])) {
      const v = nextNumber(lines, i + 1);
      if (v !== null) return v;
    }
  }
  return null;
}

/** i 以降で最初に現れる金額行を読む（「円」だけの行や説明行は読み飛ばす） */
function nextNumber(lines, i) {
  for (let j = i; j < Math.min(i + 4, lines.length); j++) {
    const s = lines[j].replace(/[,\s円]/g, '');
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  }
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }
