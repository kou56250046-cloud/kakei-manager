import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import { ROOT, DATA, writeJson, yen } from './lib/io.js';

/**
 * docs/index.html の暗号文から data/*.json を復元する。
 *
 * ★なぜ必要か
 *   data/ は .gitignore されているため、リポジトリはバックアップにならない。
 *   一方 docs/index.html には全データが AES-256-GCM で暗号化されて入っており、
 *   毎月コミットされている。**バックアップは既に存在するのに、戻す手段だけが無かった。**
 *   このスクリプトがその欠けていた半分。
 *
 * 使い方:
 *   npm run restore                       内容を確認するだけ（何も書かない）
 *   npm run restore -- --force            data/ へ実際に書き戻す
 *   npm run restore -- --out /tmp/check   別の場所へ書き出す（検証用）
 *   npm run restore -- --from &lt;path&gt;      別の index.html から復元する
 *   npm run restore -- --pass "合言葉"     .webpass が無い環境（新しいPC）で使う
 *
 * PCが壊れた場合の手順:
 *   1. git clone https://github.com/&lt;user&gt;/kakei-manager.git
 *   2. cd kakei-manager
 *   3. npm run restore -- --pass "合言葉" --force
 */

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes('--' + n);

const srcPath = opt('from') ?? join(ROOT, 'docs', 'index.html');
const outDir = opt('out') ?? DATA;
const write = has('force') || opt('out') !== undefined;

if (!existsSync(srcPath)) {
  console.error(`\n  復元元が見つかりません: ${srcPath}\n  npm run build:web を実行するか、--from でパスを指定してください。\n`);
  process.exit(1);
}

// --- 合言葉 -----------------------------------------------------------------

const passFile = join(ROOT, '.webpass');
const passphrase = opt('pass') ?? (existsSync(passFile) ? readFileSync(passFile, 'utf8').trim() : null);
if (!passphrase) {
  console.error(`
  合言葉が指定されていません。

    npm run restore -- --pass "合言葉"

  （.webpass がある環境では省略できます）
`);
  process.exit(1);
}

// --- 暗号文の取り出し --------------------------------------------------------

const html = readFileSync(srcPath, 'utf8');
const m = /const PAYLOAD = (\{.*?\});/s.exec(html);
if (!m) {
  console.error(`\n  ${srcPath} から暗号文を取り出せませんでした。\n  build-web.js が生成したファイルか確認してください。\n`);
  process.exit(1);
}
const payload = JSON.parse(m[1]);
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// --- 復号 -------------------------------------------------------------------

const baseKey = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt: b64(payload.salt), iterations: payload.iterations, hash: 'SHA-256' },
  baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
);

let data;
try {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64(payload.iv) }, key, b64(payload.data),
  );
  data = JSON.parse(new TextDecoder().decode(plain));
} catch {
  console.error('\n  ✖ 復号に失敗しました。合言葉が違います。\n');
  process.exit(1);
}

// --- 中身の確認 --------------------------------------------------------------

const tx = data.transactions ?? [];
const months = [...new Set(tx.map((t) => t.date.slice(0, 7)))].sort();
const total = tx.reduce((a, t) => a + t.amount, 0);

console.log('');
console.log(`  復元元: ${srcPath}`);
console.log(`  生成日時: ${data.builtAt ?? '不明'}`);
console.log('  ' + '─'.repeat(70));
console.log(`  取引        ${String(tx.length).padStart(5)}件  ${months[0] ?? '-'} 〜 ${months[months.length - 1] ?? '-'}  ${yen(total)}`);
console.log(`  収入        ${String((data.incomes ?? []).length).padStart(5)}件`);
console.log(`  口座        ${String((data.accounts ?? []).length).padStart(5)}件`);
console.log(`  残高記録    ${String((data.balances ?? []).length).padStart(5)}件`);
console.log(`  固定費      ${String((data.fixedCosts ?? []).length).padStart(5)}件`);
console.log(`  献金記録    ${String((data.tithe ?? []).length).padStart(5)}件`);
console.log(`  取込ログ    ${String((data.importLog ?? []).length).padStart(5)}件`);
const rules = data.backup?.categoryRules;
console.log(`  分類ルール  ${String(rules?.rules?.length ?? 0).padStart(5)}件${rules ? '' : '  ⚠ このファイルは古く、分類ルールを含んでいません'}`);
console.log(`  定期収入    ${String((data.backup?.recurringIncomes ?? []).length).padStart(5)}件`);
console.log('  ' + '─'.repeat(70));

// --- 書き戻し ---------------------------------------------------------------

if (!write) {
  const existing = existsSync(join(DATA, 'transactions'))
    ? readdirSync(join(DATA, 'transactions')).filter((f) => f.endsWith('.json')).length : 0;
  console.log(`\n  確認のみで、何も書き込んでいません。`);
  if (existing > 0) {
    console.log(`  ⚠ data/transactions/ には既に ${existing}ヶ月分のファイルがあります。`);
    console.log(`     上書きする場合は  npm run restore -- --force`);
    console.log(`     壊さず中身だけ見る場合は  npm run restore -- --out ./restore-check`);
  } else {
    console.log(`  書き戻すには  npm run restore -- --force`);
  }
  console.log('');
  process.exit(0);
}

// 月別ファイルは一度消してから書く（復元元より新しい月が残ると不整合になる）
const txDir = join(outDir, 'transactions');
if (existsSync(txDir)) {
  for (const f of readdirSync(txDir).filter((f) => f.endsWith('.json'))) rmSync(join(txDir, f));
}
const byMonth = new Map();
for (const t of tx) {
  const k = t.date.slice(0, 7);
  if (!byMonth.has(k)) byMonth.set(k, []);
  byMonth.get(k).push(t);
}
for (const [k, list] of byMonth) {
  list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  writeJson(join(txDir, `${k}.json`), list);
}

const files = [
  ['incomes.json', data.incomes ?? []],
  ['tithe.json', data.tithe ?? []],
  ['balances.json', data.balances ?? []],
  ['accounts.json', data.accounts ?? []],
  ['fixed_costs.json', data.fixedCosts ?? []],
  ['import_log.json', data.importLog ?? []],
];
if (data.backup?.categoryRules) files.push(['category_rules.json', data.backup.categoryRules]);
if (data.backup?.recurringIncomes) files.push(['recurring_incomes.json', data.backup.recurringIncomes]);

for (const [name, value] of files) writeJson(join(outDir, name), value);

console.log(`\n  ${outDir} に復元しました（月別 ${byMonth.size}ファイル ＋ ${files.length}ファイル）`);
console.log(`  ※ 内容は同一ですが、整形（インデント）は JSON.stringify のものに変わります。`);
if (!data.backup?.categoryRules) {
  console.log(`  ⚠ 分類ルールは復元されていません。data/category_rules.json を手当てしてください。`);
}
console.log(`\n  次に  npm run build  でダッシュボードを生成できます。\n`);
