import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { ROOT, dataPath, readJson, writeJson, readAllTransactions, writeTransactionsByMonth, yen } from './lib/io.js';
import { loadRules, classify, buildHistory } from './lib/classify.js';
import { merchantDisplay } from './lib/normalize.js';
import { settlementRisk } from '../ui/summary.js';

/**
 * 月次の締めを1コマンドで通す。
 *
 * ★なぜ必要か
 *   従来は「取込 → 出力を読む → 一覧コマンド → JSONを手で開いて配列の正しい位置に追記
 *   → 反映コマンド → 再ビルド → 残高をJSONに手で追記 → 再ビルド → commit」で
 *   14ステップ・ビルド3回・エディタ往復2回だった。
 *   月1回しか触らないツールでこの手数は「今月はいいや」を生み、
 *   一度飛ばすと翌月は要確認が倍になって復帰できなくなる。
 *
 *   このスクリプトは、判断が要るところ（分類・残高）だけを聞いて、
 *   それ以外を全部自動でつなぐ。
 *
 * 使い方:
 *   npm run close              対話つきで締める
 *   npm run close -- --commit  最後に git commit まで行う
 *   npm run close -- --yes     対話を飛ばす（要確認と残高はそのまま）
 */

const args = process.argv.slice(2);
const AUTO = args.includes('--yes');
const DO_COMMIT = args.includes('--commit');
const started = Date.now();

// --yes のときだけ対話を止める。パイプ入力でも readline は動くので TTY は条件にしない
const rl = AUTO ? null : createInterface({ input: stdin, output: stdout });
let rlClosed = false;
rl?.on('close', () => { rlClosed = true; });

/** 入力が尽きた（EOF）場合は既定値で先へ進む。ここで固まると締めが終わらない */
const ask = async (q, def = '') => {
  if (!rl || rlClosed) return def;
  try {
    const a = await Promise.race([
      rl.question(q),
      new Promise((res) => rl.once('close', () => res(null))),
    ]);
    if (a === null) { stdout.write('\n'); return def; }
    const s = a.trim();
    return s === '' ? def : s;
  } catch {
    return def;
  }
};

const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));
const step = (n, total, label) => { line(); rule(); line(`  [${n}/${total}] ${label}`); rule(); };

function run(script, extra = []) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...extra], {
    // ★ stdin は渡さない。'inherit' にすると子プロセスが親の標準入力を奪い、
    //   このあとの対話（要確認の確定・残高入力）が応答しなくなる
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: ROOT,
  });
  if (r.status !== 0) throw new Error(`${script} が失敗しました（終了コード ${r.status}）`);
}

// ---------------------------------------------------------------- 1〜4. 取込

const TOTAL = DO_COMMIT ? 8 : 7;

step(1, TOTAL, 'カード明細を取り込む');
run('import-card.js');

step(2, TOTAL, '給与明細を取り込む');
run('import-payslip.js');

// dカードは明細CSVを取り込めないため、ドコモの請求内訳から実額だけを拾う。
// 取引を作るのは次の generate-fixed.js 側（ここで作ると二重計上になる）
step(3, TOTAL, 'ドコモ（dカード）の請求内訳を取り込む');
run('import-dcard.js');

step(4, TOTAL, '固定費・定期収入を生成する');
run('generate-fixed.js');

// ---------------------------------------------------------------- 5. 要確認

step(5, TOTAL, '分類が未確定の取引を確定する');

const transactions = readAllTransactions();
const pending = new Map();
for (const t of transactions) {
  if (!t.needs_review) continue;
  const e = pending.get(t.merchant_key) ?? { key: t.merchant_key, merchant: t.merchant, raw: t.merchant_raw, n: 0, sum: 0, dates: [] };
  e.n++; e.sum += t.amount; e.dates.push(t.date);
  pending.set(t.merchant_key, e);
}
const queue = [...pending.values()].sort((a, b) => b.sum - a.sum);

const rulesFile = readJson(dataPath('category_rules.json'), { rules: [] });

// 既存ルールからカテゴリ体系を組み立て、番号で選べるようにする
const taxonomy = new Map();
for (const r of rulesFile.rules) {
  if (!taxonomy.has(r.category)) taxonomy.set(r.category, new Set());
  if (r.subcategory) taxonomy.get(r.category).add(r.subcategory);
}
const categories = [...taxonomy.keys()].filter((c) => c !== '不明');

let added = 0, overrides = 0;

if (queue.length === 0) {
  line('  要確認はありません。');
} else if (!rl) {
  line(`  要確認 ${queue.length}件（対話なしのためスキップ）`);
  for (const q of queue) line(`    ${String(yen(q.sum)).padStart(10)} ${String(q.n).padStart(2)}件  ${q.merchant}`);
} else {
  line(`  要確認 ${queue.length}件。金額の大きい順に確定します。`);
  line('  （Enterだけで「後で」。完璧を目指さず、大きいものから片付ければ十分です）');

  for (const [i, q] of queue.entries()) {
    line();
    line(`  ── ${i + 1}/${queue.length} ──────────────────────────────`);
    line(`  店名   ${q.merchant}`);
    line(`  原文   ${q.raw}`);
    line(`  金額   ${yen(q.sum)}（${q.n}件）`);
    line(`  利用日 ${q.dates.slice(0, 6).join(', ')}${q.dates.length > 6 ? ' …' : ''}`);
    line(`  キー   ${q.key}`);
    line();
    line('  この店は？');
    line('    r) 扱う物が決まっている  → 店名ルールにする（翌月以降も自動で分類）');
    line('    1) 毎回中身が違う        → この取引だけ確定する（商業施設・百貨店など）');
    line('    s) 後で');
    const kind = (await ask('  > [r/1/s] (既定 s): ', 's')).toLowerCase();
    if (kind !== 'r' && kind !== '1') { line('    → 後で'); continue; }

    // カテゴリ選択
    line();
    categories.forEach((c, n) => line(`    ${String(n + 1).padStart(2)}) ${c}`));
    line(`    ${String(categories.length + 1).padStart(2)}) 新しいカテゴリを入力`);
    const ci = Number(await ask('  カテゴリ番号 > ', '0'));
    let category;
    if (ci === categories.length + 1) {
      category = await ask('  新しいカテゴリ名 > ', '');
      if (!category) { line('    → 後で'); continue; }
    } else if (ci >= 1 && ci <= categories.length) {
      category = categories[ci - 1];
    } else {
      line('    → 後で'); continue;
    }

    // 中分類
    const subs = [...(taxonomy.get(category) ?? [])];
    if (subs.length) line('    既存の中分類: ' + subs.join(' / '));
    const subcategory = await ask('  中分類（空欄可）> ', '');

    if (kind === '1') {
      // その1件だけ確定（set-category と同じ扱い）
      for (const t of transactions) {
        if (t.merchant_key !== q.key) continue;
        t.category = category;
        t.subcategory = subcategory || null;
        t.needs_review = false;
        t.confidence = 'high';
        t.manual_override = true;
      }
      overrides++;
      line(`    → ${category}${subcategory ? ' / ' + subcategory : ''} に確定（この取引のみ・翌月以降には影響しません）`);
    } else {
      const display = await ask(`  表示名（空欄なら「${merchantDisplay(q.raw)}」）> `, merchantDisplay(q.raw));
      const pattern = await ask(`  マッチさせる文字列（空欄なら「${q.key}」）> `, q.key);
      const newRule = { pattern, category, subcategory: subcategory || null, display };

      // ★ ルールは配列の先勝ち。既にこのキーに当たるルールがあるなら、その前に置く。
      //   （needs_review: true の暫定ルールを上書きする場合がこれに当たる）
      const idx = rulesFile.rules.findIndex((r) => {
        try { return new RegExp(r.pattern, 'i').test(q.key); } catch { return false; }
      });
      if (idx >= 0) { rulesFile.rules.splice(idx, 0, newRule); overrides++; }
      else { rulesFile.rules.push(newRule); }
      added++;
      line(`    → ルール追加：${pattern} → ${category}${subcategory ? ' / ' + subcategory : ''}`
        + (idx >= 0 ? `（既存ルールより前に挿入）` : ''));
    }
  }

  if (overrides > 0 || added > 0) writeTransactionsByMonth(transactions);
  if (added > 0) writeJson(dataPath('category_rules.json'), rulesFile);
}

// ルールを追加したら既存データへ反映
if (added > 0) {
  line();
  run('reclassify.js', ['--all']);
}

// ---------------------------------------------------------------- 6. 残高

step(6, TOTAL, '口座残高を記録する');

const accounts = readJson(dataPath('accounts.json'), []);
const balances = readJson(dataPath('balances.json'), []);
const banks = accounts.filter((a) => a.type === 'bank');
const today = new Date().toISOString().slice(0, 10);

if (!rl) {
  line('  対話なしのためスキップしました。');
} else {
  line('  ネットバンキングで確認した残高を入力してください（Enterで飛ばせます）。');
  line('  ※ 残高がないと「引落に足りるか」の判定ができません。');
  let recorded = 0;
  for (const a of banks) {
    const prev = balances.filter((b) => b.account_id === a.id).sort((x, y) => x.date.localeCompare(y.date)).pop();
    const hint = prev ? `前回 ${yen(prev.actual_balance)}（${prev.date}）` : '記録なし';
    const raw = await ask(`  ${a.name}　${hint}\n    残高 > `, '');
    const v = raw.replace(/[,\s円]/g, '');
    if (!/^\d+$/.test(v)) { line('    → 飛ばしました'); continue; }
    const idx = balances.findIndex((b) => b.account_id === a.id && b.date === today);
    const rec = { account_id: a.id, date: today, actual_balance: parseInt(v, 10) };
    if (idx >= 0) balances[idx] = rec; else balances.push(rec);
    recorded++;
    line(`    → ${yen(rec.actual_balance)} を ${today} で記録`);
  }
  if (recorded > 0) {
    balances.sort((a, b) => a.date.localeCompare(b.date) || a.account_id.localeCompare(b.account_id));
    writeJson(dataPath('balances.json'), balances);
  }
}

// ---------------------------------------------------------------- 7. ビルド

step(7, TOTAL, 'ダッシュボードを生成する');
run('build.js');
try {
  run('build-web.js');
} catch (e) {
  // 合言葉が無い環境でも、ここまでの取込結果は失われない
  line(`  ⚠ Web公開版の生成は飛ばしました（${e.message}）`);
}

// ---------------------------------------------------------------- 8. commit

if (DO_COMMIT) {
  step(8, TOTAL, 'コミットする');
  const month = new Date().toISOString().slice(0, 7);
  spawnSync('git', ['add', '-A'], { stdio: 'inherit', cwd: ROOT });
  const r = spawnSync('git', ['commit', '-m', `${month} の家計を締め`], { stdio: 'inherit', cwd: ROOT });
  if (r.status === 0) line('  コミットしました（push は手動で）');
  else line('  コミットする変更はありませんでした');
}

// ---------------------------------------------------------------- 締めの報告

const elapsed = Math.round((Date.now() - started) / 1000);
const mm = Math.floor(elapsed / 60), ss = elapsed % 60;

const finalTx = readAllTransactions();
const finalMonths = [...new Set(finalTx.map((t) => t.date.slice(0, 7)))].sort();
const stillPending = finalTx.filter((t) => t.needs_review).length;
const risk = settlementRisk(
  accounts, readJson(dataPath('balances.json'), []), readJson(dataPath('import_log.json'), []), today,
);

// 所要時間を記録する。「10分で終わる」という約束が守られているかを、
// ツール自身が毎月測って残す（北極星指標の自動計測）
const closeLog = readJson(dataPath('close_log.json'), []);
closeLog.push({ date: today, seconds: elapsed, transactions: finalTx.length, pending: stillPending, rules_added: added });
writeJson(dataPath('close_log.json'), closeLog);

line();
rule();
line(`  ${finalMonths[finalMonths.length - 1]} の締め 完了　所要 ${mm}分${ss}秒`);
rule();
line(`  取引        ${finalTx.length}件（${finalMonths[0]} 〜 ${finalMonths[finalMonths.length - 1]}）`);
line(`  要確認      ${stillPending === 0 ? '0件 ✅' : stillPending + '件（次回 npm run close で確定できます）'}`);
if (added > 0) line(`  追加ルール  ${added}件`);
if (risk) {
  line(risk.covered
    ? `  次の引落    ${risk.date} ${yen(risk.amount)} — 残高 ${yen(risk.balance)} で足ります ✅`
    : `  次の引落    ${risk.date} ${yen(risk.amount)} — ⚠ ${yen(risk.shortfall)} 不足`);
} else {
  // null になる理由は2つある。取り違えると「残高を入れたのに出ない」と混乱するので分ける
  const hasBalance = readJson(dataPath('balances.json'), []).length > 0;
  const hasUpcoming = readJson(dataPath('import_log.json'), [])
    .some((e) => e.payment_date && e.payment_date >= today);
  line(!hasBalance
    ? '  次の引落    判定できません（口座残高が未登録）'
    : !hasUpcoming
      ? '  次の引落    予定なし（取り込み済みの請求はすべて引落済み）'
      : '  次の引落    判定できません');
}
if (closeLog.length > 1) {
  const avg = Math.round(closeLog.reduce((a, c) => a + c.seconds, 0) / closeLog.length);
  line(`  平均所要    ${Math.floor(avg / 60)}分${avg % 60}秒（${closeLog.length}回）`);
}
line();
line('  dist/index.html を開いて確認してください。');
if (!DO_COMMIT) line('  問題なければ  git add -A && git commit && git push');
line();

rl?.close();
