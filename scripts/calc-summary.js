import { join } from 'node:path';
import { ROOT, dataPath, readJson, readAllTransactions } from './lib/io.js';
import {
  monthlyTotals, markIncompleteMonths, byCategory, byMerchant,
  fixedVsVariable, titheByMonth, reviewQueue, yenFmt,
} from '../ui/summary.js';

/**
 * 月次サマリーをターミナルに表示する。
 * 集計ロジックは ui/summary.js に一本化し、ダッシュボードと同じ結果になるようにしている。
 *
 *   npm run summary            全期間のサマリー
 *   npm run summary -- 2026-05 指定月の内訳
 */

const arg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}$/.test(a));

const transactions = readAllTransactions();
const incomes = readJson(dataPath('incomes.json'), []);
const tithe = readJson(dataPath('tithe.json'), []);
const importLog = readJson(dataPath('import_log.json'), []);
const config = readJson(join(ROOT, 'config.json'), {});

if (transactions.length === 0) {
  console.log('取引がありません。npm run import を実行してください。');
  process.exit(0);
}

const months = markIncompleteMonths(monthlyTotals(transactions), importLog, config?.analysis?.start_month);
const bar = (n, max, width = 28) => '█'.repeat(Math.max(0, Math.round((n / max) * width)));

console.log('\n━━━━━━━━━━━━━━━━ 月次支出（利用日ベース） ━━━━━━━━━━━━━━━━');
const maxM = Math.max(...months.map((m) => m.amount));
for (const m of months) {
  const mark = m.incomplete ? ' ※明細範囲外あり（不完全）' : '';
  console.log(`  ${m.month}  ${String(yenFmt(m.amount)).padStart(9)}円 ${String(m.count).padStart(3)}件  ${bar(m.amount, maxM)}${mark}`);
}

const target = arg ?? null;
const label = target ?? '全期間';

console.log(`\n━━━━━━━━━━━━━━━━ カテゴリ別支出（${label}） ━━━━━━━━━━━━━━━━`);
const cats = byCategory(transactions, target);
const catTotal = cats.reduce((a, c) => a + c.amount, 0);
const maxC = Math.max(...cats.map((c) => c.amount), 1);
for (const c of cats) {
  const pct = ((c.amount / catTotal) * 100).toFixed(1);
  console.log(`  ${c.category.padEnd(8, '　')} ${String(yenFmt(c.amount)).padStart(9)}円 ${String(pct).padStart(5)}% ${String(c.count).padStart(3)}件  ${bar(c.amount, maxC, 24)}`);
  for (const s of c.subs.slice(0, 4)) {
    if (c.subs.length <= 1) break;
    console.log(`    └ ${String(s.name).padEnd(12, '　')} ${String(yenFmt(s.amount)).padStart(8)}円`);
  }
}
console.log(`  ${'合計'.padEnd(8, '　')} ${String(yenFmt(catTotal)).padStart(9)}円`);

const fv = fixedVsVariable(transactions, target);
if (fv.total > 0) {
  console.log(`\n  固定費 ${yenFmt(fv.fixed)}円 (${((fv.fixed / fv.total) * 100).toFixed(1)}%) / 変動費 ${yenFmt(fv.variable)}円 (${((fv.variable / fv.total) * 100).toFixed(1)}%)`);
}

console.log(`\n━━━━━━━━━━━━━━━━ 店舗別 TOP15（${label}） ━━━━━━━━━━━━━━━━`);
for (const m of byMerchant(transactions, target).slice(0, 15)) {
  console.log(`  ${String(yenFmt(m.amount)).padStart(9)}円 ${String(m.count).padStart(3)}件  ${m.merchant}  [${m.category}]`);
}

const titheRows = titheByMonth(incomes, tithe, config, transactions);
if (titheRows.length > 0) {
  console.log('\n━━━━━━━━━━━━━━━━ 献金（手取り基準・10%） ━━━━━━━━━━━━━━━━');
  for (const r of titheRows) {
    const state = r.remaining === 0 ? '✅' : `未献金 ${yenFmt(r.remaining)}円`;
    console.log(`  ${r.month}  手取り ${String(yenFmt(r.base)).padStart(9)}円 → 献金額 ${String(yenFmt(r.calculated)).padStart(7)}円  献金済 ${String(yenFmt(r.paid)).padStart(7)}円  ${state}`);
  }
  const last = titheRows[titheRows.length - 1];
  const sumCalc = titheRows.reduce((a, r) => a + r.calculated, 0);
  const sumPaid = titheRows.reduce((a, r) => a + r.paid, 0);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  計算額合計 ${yenFmt(sumCalc)}円 / 献金済合計 ${yenFmt(sumPaid)}円 / 累積未献金 ${yenFmt(last.carryOver)}円`);
}

const review = reviewQueue(transactions);
if (review.length > 0) {
  console.log('\n━━━━━━━━━━━━━━━━ 要確認キュー ━━━━━━━━━━━━━━━━');
  for (const r of review) {
    console.log(`  ${String(yenFmt(r.amount)).padStart(8)}円 ${String(r.count).padStart(2)}件  ${r.merchant}  [${r.key}]`);
  }
}

const mismatch = importLog.filter((e) => e.status === 'MISMATCH');
if (mismatch.length > 0) {
  console.log('\n⚠ 検算不一致のある請求月:');
  for (const e of mismatch) {
    console.log(`  ${e.billing_month}  請求 ${yenFmt(e.billed)}円 / 明細 ${yenFmt(e.detail_sum)}円 / 差 ${yenFmt(e.diff)}円`);
  }
}
console.log('');
