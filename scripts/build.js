import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, dataPath, readJson, readAllTransactions, yen } from './lib/io.js';

/**
 * data/ + ui/ から dist/index.html（単一ファイル）を生成する。
 *
 * データはHTMLに直接埋め込む。fetch を使わないので file:// で開いても動き、
 * ネットワークが無くてもグラフまで含めて完全に表示される。
 * ※ このファイルには家計データがそのまま入るため .gitignore 済み。
 */

const UI = join(ROOT, 'ui');
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, 'index.html');

const transactions = readAllTransactions();
const data = {
  transactions,
  incomes: readJson(dataPath('incomes.json'), []),
  tithe: readJson(dataPath('tithe.json'), []),
  balances: readJson(dataPath('balances.json'), []),
  accounts: readJson(dataPath('accounts.json'), []),
  fixedCosts: readJson(dataPath('fixed_costs.json'), []),
  importLog: readJson(dataPath('import_log.json'), []),
  config: readJson(join(ROOT, 'config.json'), {}),
  today: new Date().toISOString().slice(0, 10),
  builtAt: new Date().toLocaleString('ja-JP'),
};

const template = readFileSync(join(UI, 'template.html'), 'utf8');
const style = readFileSync(join(UI, 'style.css'), 'utf8');
// summary.js は Node からも import する共有モジュール。
// ブラウザ側ではスコープに展開するだけなので export キーワードだけ落とす。
const summary = readFileSync(join(UI, 'summary.js'), 'utf8').replace(/^export\s+/gm, '');
const app = readFileSync(join(UI, 'app.js'), 'utf8');

const json = JSON.stringify(data)
  // </script> がデータ中に現れてもスクリプトが閉じないようにする
  .replace(/<\/script/gi, '<\\/script')
  .replace(/<!--/g, '<\\!--');

const months = [...new Set(transactions.map((t) => t.date.slice(0, 7)))].sort();
const total = transactions.reduce((a, t) => a + t.amount, 0);
const sub = transactions.length
  ? `${months[0]} 〜 ${months[months.length - 1]}　取引 ${transactions.length}件　合計 ${yen(total)}　生成 ${data.builtAt}`
  : `データ未取込　生成 ${data.builtAt}`;

const html = template
  .replace('/*__STYLE__*/', () => style)
  .replace('/*__DATA__*/null', () => json)
  .replace('/*__SUMMARY__*/', () => summary)
  .replace('/*__APP__*/', () => app)
  .replace('<p class="page-sub" id="page-sub"></p>', `<p class="page-sub" id="page-sub">${escapeHtml(sub)}</p>`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html, 'utf8');

console.log('');
console.log(`  dist/index.html を生成しました（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
console.log(`  ${sub}`);
console.log(`  → ${OUT}`);
console.log('');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
