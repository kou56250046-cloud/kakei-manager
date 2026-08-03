import { readAllTransactions, writeTransactionsByMonth, yen } from './lib/io.js';
import { loadRules, classify, buildHistory } from './lib/classify.js';
import { merchantDisplay } from './lib/normalize.js';

/**
 * 既存の取引を category_rules.json で再分類する。
 *
 *   npm run review           要確認（needs_review）の取引だけを再評価する
 *   npm run review -- --all  すべての取引を再評価する（ルールを直した後に使う）
 *   npm run review -- --list 変更を書き込まず、要確認の一覧だけ表示する
 *
 * manual_override: true が付いた取引は、人が手で確定したものとみなして
 * 常に再分類の対象外にする。
 */

const args = process.argv.slice(2);
const all = args.includes('--all');
const listOnly = args.includes('--list');

const transactions = readAllTransactions();
if (transactions.length === 0) {
  console.log('取引がありません。先に npm run import を実行してください。');
  process.exit(0);
}

const rules = loadRules();
const history = buildHistory(transactions);

if (listOnly) {
  const review = transactions.filter((t) => t.needs_review);
  console.log(`\n要確認 ${review.length}件 / 全 ${transactions.length}件\n`);
  const grouped = new Map();
  for (const t of review) {
    const g = grouped.get(t.merchant_key) ?? { n: 0, sum: 0, merchant: t.merchant, dates: [] };
    g.n++; g.sum += t.amount; g.dates.push(t.date); grouped.set(t.merchant_key, g);
  }
  for (const [key, g] of [...grouped].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${String(g.sum).padStart(8)}円 ${String(g.n).padStart(3)}件  ${g.merchant}`);
    console.log(`           正規化キー: ${key}`);
    console.log(`           利用日: ${g.dates.join(', ')}`);
  }
  console.log('\n  data/category_rules.json にルールを追記してから');
  console.log('  npm run review -- --all を実行すると既存データに反映されます。\n');
  process.exit(0);
}

let changed = 0;
const changes = [];

for (const t of transactions) {
  if (t.manual_override) continue;
  if (!all && !t.needs_review) continue;

  const c = classify(t.merchant_key, rules, history);
  const newMerchant = c.display ?? merchantDisplay(t.merchant_raw);
  const before = `${t.category}/${t.subcategory ?? '-'}`;
  const after = `${c.category}/${c.subcategory ?? '-'}`;
  // 表示名(display)だけを直した場合も反映されるよう、比較対象に含める
  if (
    before === after &&
    t.merchant === newMerchant &&
    t.needs_review === c.needs_review &&
    t.is_fixed_cost === c.is_fixed_cost
  ) continue;

  changes.push({
    merchant: t.merchant, amount: t.amount, date: t.date,
    before: before + (t.merchant !== newMerchant ? `「${t.merchant}」` : ''),
    after: after + (t.merchant !== newMerchant ? `「${newMerchant}」` : ''),
  });
  t.category = c.category;
  t.subcategory = c.subcategory;
  t.merchant = newMerchant;
  t.is_fixed_cost = c.is_fixed_cost;
  t.confidence = c.confidence;
  t.needs_review = c.needs_review;
  changed++;
}

if (changed === 0) {
  console.log('\n変更はありませんでした。\n');
} else {
  writeTransactionsByMonth(transactions);
  console.log(`\n${changed}件を再分類しました。\n`);
  const seen = new Set();
  for (const c of changes) {
    const k = `${c.merchant}|${c.before}|${c.after}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${c.merchant}  ${c.before} → ${c.after}`);
  }
}

const review = transactions.filter((t) => t.needs_review);
console.log(`要確認 ${review.length}件 / 全 ${transactions.length}件 / ${yen(transactions.reduce((a, t) => a + t.amount, 0))}\n`);
