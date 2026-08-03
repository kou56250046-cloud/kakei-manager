import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import { ROOT, dataPath, readJson, readAllTransactions, yen } from './lib/io.js';

/**
 * GitHub Pages 用の「暗号化されたダッシュボード」を docs/index.html に書き出す。
 *
 * ★なぜ暗号化するのか
 *   GitHub Pages は **プライベートリポジトリからでも公開サイトになる**。
 *   アクセス制限は Enterprise プランのみ。つまりリポジトリを private にしても、
 *   URL を知られればサイトの中身は誰でも読める。
 *   本データには手取り給与・口座残高・献金額（＝要配慮個人情報）・生活圏が含まれるため、
 *   平文で置いてはいけない。
 *
 *   そこで家計データを AES-256-GCM で暗号化し、暗号文だけをコミットする。
 *   鍵は PBKDF2-SHA256（60万回）で合言葉から導出し、復号はブラウザ内でのみ行う。
 *   合言葉はどこにも送信されず、リポジトリにも残らない。
 *
 * 使い方:
 *   node scripts/build-web.js --pass "合言葉"
 *   （または .webpass ファイルに合言葉を書いておく。.gitignore 済み）
 */

const ITERATIONS = 600000; // OWASP 2023 の PBKDF2-SHA256 推奨値

const args = process.argv.slice(2);
const argPass = args.includes('--pass') ? args[args.indexOf('--pass') + 1] : null;
const passFile = join(ROOT, '.webpass');
const passphrase = argPass ?? (existsSync(passFile) ? readFileSync(passFile, 'utf8').trim() : null);

if (!passphrase) {
  console.error(`
  合言葉が指定されていません。

    node scripts/build-web.js --pass "好きな合言葉"

  または、リポジトリ直下に .webpass というファイルを作って合言葉を1行書いてください
  （.gitignore 済みなのでコミットされません）。

  ※ 推測されにくい合言葉にしてください。暗号文は公開リポジトリに置かれるため、
     総当たりを試せる状態になります（PBKDF2 60万回で1回の試行を重くしていますが、
     短い合言葉や辞書語は破られます）。
`);
  process.exit(1);
}

if (passphrase.length < 10) {
  console.error(`\n  ⚠ 合言葉が短すぎます（${passphrase.length}文字）。12文字以上を強く推奨します。\n`);
  process.exit(1);
}

// --- データ収集（ローカル版 build.js と同じ） --------------------------------

const transactions = readAllTransactions();

const months = [...new Set(transactions.map((t) => t.date.slice(0, 7)))].sort();
const total = transactions.reduce((a, t) => a + t.amount, 0);
const builtAt = new Date().toLocaleString('ja-JP');

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
  builtAt,
  // 画面では使わないが、復元（npm run restore）のために同梱する。
  // data/ は .gitignore されているため、ここに入れておかないと
  // PCが壊れたときに分類ルール（蓄積した資産）が失われる。
  backup: {
    categoryRules: readJson(dataPath('category_rules.json'), null),
    recurringIncomes: readJson(dataPath('recurring_incomes.json'), null),
  },
  // ★ 見出しの副題も暗号化側に入れる。
  //   以前はこれを平文で埋め込んでいたため、合言葉なしで
  //   「取引N件・合計N円・生成日時」が読めてしまっていた。
  subtitle: transactions.length
    ? `${months[0]} 〜 ${months[months.length - 1]}　取引 ${transactions.length}件　合計 ${yen(total)}　生成 ${builtAt}`
    : `データ未取込　生成 ${builtAt}`,
};

// --- 暗号化 -----------------------------------------------------------------

const enc = new TextEncoder();

// salt はビルドごとに変えず、`.websalt` に保存して再利用する。
// 毎回変えると、ブラウザに保存した復号鍵が更新のたびに無効になり、
// 毎月合言葉を入れ直すことになるため。
// （IV は毎回新しく生成する。AES-GCM で危険なのは IV の再利用であって salt の再利用ではない）
const saltFile = join(ROOT, '.websalt');
let salt;
if (existsSync(saltFile)) {
  salt = new Uint8Array(Buffer.from(readFileSync(saltFile, 'utf8').trim(), 'base64'));
  if (salt.length !== 16) salt = crypto.getRandomValues(new Uint8Array(16));
} else {
  salt = crypto.getRandomValues(new Uint8Array(16));
}
writeFileSync(saltFile, Buffer.from(salt).toString('base64') + '\n', 'utf8');

const iv = crypto.getRandomValues(new Uint8Array(12));

const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  baseKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt'],
);
const cipher = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)),
);

const payload = {
  v: 1,
  alg: 'AES-GCM-256/PBKDF2-SHA256',
  iterations: ITERATIONS,
  salt: Buffer.from(salt).toString('base64'),
  iv: Buffer.from(iv).toString('base64'),
  data: Buffer.from(cipher).toString('base64'),
};

// --- 組み立て ---------------------------------------------------------------

const UI = join(ROOT, 'ui');
const template = readFileSync(join(UI, 'web-template.html'), 'utf8');
const style = readFileSync(join(UI, 'style.css'), 'utf8');
const summary = readFileSync(join(UI, 'summary.js'), 'utf8').replace(/^export\s+/gm, '');
const app = readFileSync(join(UI, 'app.js'), 'utf8');

// 描画コードは文字列として埋め込み、復号後に <script> として注入する。
// こうするとローカル版（dist/index.html）と完全に同じ app.js をそのまま使える。
const html = template
  .replace('/*__STYLE__*/', () => style)
  .replace('/*__PAYLOAD__*/null', () => JSON.stringify(payload))
  .replace('/*__APP_SRC__*/""', () => JSON.stringify(summary + '\n' + app));

const OUT_DIR = join(ROOT, 'docs');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'index.html'), html, 'utf8');
writeFileSync(join(OUT_DIR, '.nojekyll'), '', 'utf8');

/**
 * 平文が混入していないかの自己点検（コミット前の最後の砦）。
 *
 * 以前は「店名1件・手取り額1件・口座残高1件」だけを見ており、
 * 自分が埋め込んだ subtitle（合計金額を含む）を検査対象から外していた。
 * そのため穴を自分で開けて自分で見逃していた。
 * ここでは暗号文を取り除いた残り全体を、機械的に総当たりする。
 */
const scrubbed = html
  .replace(payload.data, '')
  .replace(payload.salt, '')
  .replace(payload.iv, '');

const leaks = [];

// ① 3桁区切りの数字（金額の形をしたもの）が1つでも残っていたらアウト
for (const m of new Set(scrubbed.match(/\d{1,3}(,\d{3})+/g) ?? [])) {
  leaks.push(['金額らしき数字', m]);
}

// ② 店名（表示名・原文とも）
const merchants = new Set();
for (const t of transactions) {
  for (const v of [t.merchant, t.merchant_raw]) if (v && v.length >= 3) merchants.add(v);
}
for (const m of merchants) if (scrubbed.includes(m)) leaks.push(['店名', m]);

// ③ 収入・残高・固定費の金額（区切りなしの生の数字）
const amounts = new Set();
for (const i of data.incomes) for (const v of [i.net_amount, i.gross_amount]) if (v) amounts.add(String(v));
for (const b of data.balances) if (b.actual_balance) amounts.add(String(b.actual_balance));
for (const f of data.fixedCosts) if (f.amount) amounts.add(String(f.amount));
for (const e of data.importLog) if (e.billed) amounts.add(String(e.billed));
amounts.add(String(total));
for (const a of amounts) if (a.length >= 4 && scrubbed.includes(a)) leaks.push(['金額', a]);

console.log('');
console.log(`  docs/index.html を生成しました（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
console.log(`  暗号化: ${payload.alg} / PBKDF2 ${ITERATIONS.toLocaleString()}回`);
console.log(`  ${data.subtitle}（この行は暗号化側に入っており、公開HTMLには出ません）`);
if (leaks.length > 0) {
  console.error(`\n  ✖ 平文が混入しています: ${leaks.map(([n]) => n).join(', ')} — コミットしないでください\n`);
  process.exit(1);
}
console.log('  ✅ 平文混入チェック: 家計データは暗号文のみ');
console.log('');
