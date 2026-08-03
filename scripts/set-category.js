import { readAllTransactions, writeTransactionsByMonth, yen } from './lib/io.js';

/**
 * 特定の取引だけ分類を手で確定する。
 *
 * 商業施設（ノクティプラザ等）や百貨店のように「同じ店名でも毎回中身が違う」
 * ものは、店名ルールを作ると翌月以降を誤分類する。そういうものはルールにせず、
 * この方法で1件だけ確定させる。
 *
 * 付けた取引には manual_override: true が入り、npm run review では
 * 二度と上書きされない。
 *
 * 使い方:
 *   node scripts/set-category.js --match ノクテイプラザ --date 2026-06-02 \
 *        --category 教養・娯楽 --sub 書籍 --merchant "ノクティプラザ（布絵本）" --note "ベビー用布絵本"
 *
 *   --match    店名（原文・正規化キー・表示名のいずれかに部分一致）
 *   --date     利用日で絞り込む（省略可）
 *   --amount   金額で絞り込む（省略可）
 *   --category 大分類（必須）
 *   --sub      中分類
 *   --merchant 表示名を上書き
 *   --note     備考を上書き
 *   --dry      書き込まずに対象だけ表示する
 */

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes('--' + name);

const match = opt('match');
const category = opt('category');
if (!match || !category) {
  console.error('必須: --match <店名> --category <大分類>');
  console.error('例: node scripts/set-category.js --match ノクテイプラザ --category 教養・娯楽 --sub 書籍');
  process.exit(1);
}

const date = opt('date');
const amount = opt('amount') ? Number(opt('amount')) : undefined;

const transactions = readAllTransactions();
const targets = transactions.filter((t) => {
  const hay = `${t.merchant_raw} ${t.merchant_key} ${t.merchant}`;
  if (!hay.includes(match)) return false;
  if (date && t.date !== date) return false;
  if (amount !== undefined && t.amount !== amount) return false;
  return true;
});

if (targets.length === 0) {
  console.error(`\n該当する取引がありません（--match "${match}"${date ? ` --date ${date}` : ''}）\n`);
  process.exit(1);
}

console.log('');
for (const t of targets) {
  console.log(`  ${t.date}  ${String(yen(t.amount)).padStart(10)}  ${t.merchant}`);
  console.log(`      ${t.category}/${t.subcategory ?? '-'} → ${category}/${opt('sub') ?? '-'}`);
}

if (has('dry')) {
  console.log(`\n  --dry のため書き込んでいません（${targets.length}件が対象）\n`);
  process.exit(0);
}

for (const t of targets) {
  t.category = category;
  t.subcategory = opt('sub') ?? null;
  if (opt('merchant')) t.merchant = opt('merchant');
  if (opt('note')) t.note = opt('note');
  t.needs_review = false;
  t.confidence = 'high';
  t.manual_override = true; // 以降 reclassify で上書きされない
}

writeTransactionsByMonth(transactions);
console.log(`\n  ${targets.length}件を確定しました（manual_override）\n`);
