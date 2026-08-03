import { join } from 'node:path';
import { ROOT, dataPath, readJson, writeJson, readAllTransactions, writeTransactionsByMonth, yen } from './lib/io.js';
import { roundTithe } from '../ui/summary.js';

/**
 * 固定費マスタと定期収入マスタから、月ごとの取引・収入を生成する。
 *
 * ★二重計上の防止（仕様書 4.3）
 *   明細CSVを取り込んでいるカード（イオンゴールド）の固定費は生成しない。
 *   CSVに実額が出るため、生成すると二重に計上される。
 *   逆に、**CSVを取り込んでいないカード（dカード）の固定費は生成する**。
 *   生成しないと支出から完全に漏れるため。この分岐は auto_generate で明示している。
 *
 * 生成物は source: 'fixed' / 'recurring' を持ち、実行のたびに作り直される
 * （元データではなく導出データなので、毎回消して作り直すのが安全）。
 */

const config = readJson(join(ROOT, 'config.json'), {});
const fixedCosts = readJson(dataPath('fixed_costs.json'), []);
const recurringIncomes = readJson(dataPath('recurring_incomes.json'), []);
const allTx = readAllTransactions();
const incomes = readJson(dataPath('incomes.json'), []);

// 生成済みのものを一度すべて捨てる（マスタを直したら必ず作り直す）
const kept = allTx.filter((t) => t.source !== 'fixed');
const keptIncomes = incomes.filter((i) => i.source !== 'recurring');

// 生成する月の範囲：マスタの最も早い start_month 〜 データのある最終月
const dataMonths = [
  ...kept.map((t) => t.date.slice(0, 7)),
  ...keptIncomes.map((i) => i.date.slice(0, 7)),
];
if (dataMonths.length === 0) {
  console.error('取引も収入もありません。先に npm run import を実行してください。');
  process.exit(1);
}
const lastMonth = dataMonths.sort()[dataMonths.length - 1];
const starts = [...fixedCosts, ...recurringIncomes].map((m) => m.start_month).filter(Boolean).sort();
const firstMonth = starts[0] ?? lastMonth;
const months = monthRange(firstMonth, lastMonth);

// --- 定期収入の生成（献金の計算に使うので取引より先に作る） -------------------

const genIncomes = [];
for (const ri of recurringIncomes) {
  for (const m of months) {
    if (!inRange(m, ri.start_month, ri.end_month)) continue;
    genIncomes.push({
      id: `inc_${m}_${ri.id}`,
      date: `${m}-${pad(ri.payment_day ?? 1)}`,
      name: ri.name,
      period_month: m,
      gross_amount: ri.amount,
      net_amount: ri.amount,
      deposit_account_id: ri.deposit_account_id ?? null,
      is_tithe_target: ri.is_tithe_target === true,
      tithe_base: 'net',
      source: 'recurring',
      recurring_id: ri.id,
    });
  }
}
const mergedIncomes = [...keptIncomes, ...genIncomes].sort((a, b) => a.date.localeCompare(b.date));

// 月ごとの献金対象額（十分の一献金の計算に使う）
const titheBase = new Map();
for (const inc of mergedIncomes) {
  if (inc.is_tithe_target === false) continue;
  const m = inc.date.slice(0, 7);
  const addBack = config?.tithe?.add_back_savings_deduction === true;
  const base = (inc.net_amount ?? 0) + (addBack ? (inc.savings_deduction ?? 0) : 0);
  titheBase.set(m, (titheBase.get(m) ?? 0) + base);
}

// --- 固定費の生成 -----------------------------------------------------------

const genTx = [];
const skipped = [];

for (const fc of fixedCosts) {
  if (fc.auto_generate !== true) continue;

  for (const m of months) {
    if (!inRange(m, fc.start_month, fc.end_month)) continue;

    let amount;
    if (fc.compute === 'tithe') {
      const base = titheBase.get(m) ?? 0;
      if (base <= 0) continue; // その月に対象収入がなければ献金も発生しない
      amount = roundTithe(base * (config?.tithe?.rate ?? 0.1), config?.tithe?.rounding ?? 'ceil', config?.tithe?.rounding_unit ?? 100);
    } else {
      amount = fc.amount;
    }

    if (amount === null || amount === undefined) {
      skipped.push({ name: fc.name, month: m, reason: '金額が未登録' });
      continue;
    }

    genTx.push({
      id: `fx_${m}_${fc.id}`,
      date: `${m}-${pad(fc.payment_day ?? 1)}`,
      billing_month: m,
      billing_date: null,
      amount,
      type: 'expense',
      category: fc.category,
      subcategory: fc.subcategory ?? null,
      merchant_raw: fc.name,
      merchant: fc.name,
      merchant_key: fc.id,
      source: 'fixed',
      account_id: fc.account_id ?? null,
      payment_method: fc.payment_method,
      is_fixed_cost: true,
      fixed_cost_id: fc.id,
      note: fc.payment_day ? '' : '引落日は未確認のため月初で計上',
      confidence: 'high',
      needs_review: false,
    });
  }
}

// --- 書き出し ---------------------------------------------------------------

writeTransactionsByMonth([...kept, ...genTx]);
writeJson(dataPath('incomes.json'), mergedIncomes);

console.log('');
console.log(`  対象月: ${months[0]} 〜 ${months[months.length - 1]}（${months.length}ヶ月）`);
console.log('');

const byCost = new Map();
for (const t of genTx) {
  const e = byCost.get(t.fixed_cost_id) ?? { name: t.merchant, n: 0, sum: 0 };
  e.n++; e.sum += t.amount; byCost.set(t.fixed_cost_id, e);
}
console.log('  生成した固定費:');
for (const [, e] of [...byCost].sort((a, b) => b[1].sum - a[1].sum)) {
  console.log(`    ${String(yen(e.sum)).padStart(12)}  ${String(e.n).padStart(2)}ヶ月  ${e.name}`);
}

if (genIncomes.length > 0) {
  const ri = new Map();
  for (const i of genIncomes) {
    const e = ri.get(i.recurring_id) ?? { name: i.name, n: 0, sum: 0 };
    e.n++; e.sum += i.net_amount; ri.set(i.recurring_id, e);
  }
  console.log('\n  生成した定期収入:');
  for (const [, e] of ri) {
    console.log(`    ${String(yen(e.sum)).padStart(12)}  ${String(e.n).padStart(2)}ヶ月  ${e.name}`);
  }
}

if (skipped.length > 0) {
  const g = new Map();
  for (const s of skipped) g.set(s.name, (g.get(s.name) ?? 0) + 1);
  console.log('\n  ⚠ 金額が未登録のため生成しなかった固定費:');
  for (const [name, n] of g) console.log(`    ${name}（${n}ヶ月分）— data/fixed_costs.json に amount を入れてください`);
}

console.log(`\n  取引 ${kept.length + genTx.length}件（うち生成 ${genTx.length}件） / 収入 ${mergedIncomes.length}件\n`);

// ---------------------------------------------------------------- helpers

function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function inRange(month, start, end) {
  if (start && month < start) return false;
  if (end && month > end) return false;
  return true;
}

function pad(n) { return String(n).padStart(2, '0'); }
