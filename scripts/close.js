import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { ROOT, dataPath, readJson, writeJson, readAllTransactions, writeTransactionsByMonth, yen } from './lib/io.js';
import { loadRules, classify, buildHistory } from './lib/classify.js';
import { merchantDisplay } from './lib/normalize.js';
import { runPipeline, IMPORT_STEPS, BUILD_STEPS, stepLabel, backupStatus } from './lib/pipeline.js';
import { applyOverride, byKey, insertRule, safePattern } from './lib/classify-apply.js';
import { recordBalance, parseAmount } from './lib/balance.js';
import { readLock, roleName } from './lib/lock.js';
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
 *   npm run close -- --force   ウォッチャが動いていても実行する
 */

const args = process.argv.slice(2);
const AUTO = args.includes('--yes');
const DO_COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const started = Date.now();

// ★ ウォッチャと同時に走らせない。
//   writeJson を不可分にしてもファイルが壊れなくなるだけで、2つのプロセスが
//   同時に「読む → 変える → 書き戻す」と、後から書いた方が相手の変更を消す。
//   どちらも readAllTransactions() → writeTransactionsByMonth() を通るため実際に起こる。
const holder = readLock();
if (holder && !FORCE) {
  const who = roleName(holder.role);
  console.error('');
  console.error(`  ${who}が動いています（PID ${holder.pid}／${holder.port ? `http://127.0.0.1:${holder.port}/` : 'ポート不明'}）。`);
  console.error('  同時に走らせると、片方の変更がもう片方に消されます。');
  console.error('');
  console.error('  どちらかにしてください:');
  console.error(`    ${who}を止めてから実行する（ウォッチャなら npm run watch:uninstall）`);
  console.error('    npm run close -- --force  で承知の上で実行する');
  console.error('');
  process.exit(2);
}
if (holder && FORCE) {
  console.warn(`  ⚠ ${roleName(holder.role)}（PID ${holder.pid}）が動いていますが --force のため続行します。\n`);
}

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

// 手順は lib/pipeline.js が持つ。ウォッチャ（watch.js）と同じ順番を共有するため、
// ここで並べ直さない（片方にスクリプトを足したときの漏れを防ぐ）
const imported = runPipeline(IMPORT_STEPS, {
  onStep: (script, i) => step(i + 1, TOTAL, stepLabel(script)),
});
if (!imported.ok) {
  throw new Error(`${imported.failedStep} が失敗しました（終了コード ${imported.exitCode}）`);
}

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
      applyOverride(transactions, byKey(q.key), { category, subcategory });
      overrides++;
      line(`    → ${category}${subcategory ? ' / ' + subcategory : ''} に確定（この取引のみ・翌月以降には影響しません）`);
    } else {
      const display = await ask(`  表示名（空欄なら「${merchantDisplay(q.raw)}」）> `, merchantDisplay(q.raw));
      const raw = await ask(`  マッチさせる文字列（空欄なら「${q.key}」）> `, q.key);
      // 店名に括弧などが混ざったままだと、次回 loadRules が例外で全部止まる
      const pattern = safePattern(raw);
      const newRule = { pattern, category, subcategory: subcategory || null, display };

      // 配列は先勝ちなので、既に当たっているルールの前に入れる（insertRule の責務）
      const { insertedBefore } = insertRule(rulesFile.rules, newRule, q.key);
      if (insertedBefore >= 0) overrides++;
      added++;
      line(`    → ルール追加：${pattern} → ${category}${subcategory ? ' / ' + subcategory : ''}`
        + (insertedBefore >= 0 ? `（既存ルールより前に挿入）` : ''));
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
  // 記録の仕方は lib/balance.js が持つ。確定パネルからも同じ関数を通す
  // （2か所で書くと、同じ口座・同じ日に2件並ぶような壊れ方をする）
  for (const a of banks) {
    const prev = balances.filter((b) => b.account_id === a.id).sort((x, y) => x.date.localeCompare(y.date)).pop();
    const hint = prev ? `前回 ${yen(prev.actual_balance)}（${prev.date}）` : '記録なし';
    const raw = await ask(`  ${a.name}　${hint}\n    残高 > `, '');
    const amount = parseAmount(raw);
    if (amount === null) { line('    → 飛ばしました'); continue; }
    const r = recordBalance(a.id, amount, today);
    line(r.ok ? `    → ${yen(amount)} を ${today} で記録` : `    → ${r.error}`);
  }
}

// ---------------------------------------------------------------- 7. ビルド

const built = runPipeline(BUILD_STEPS, {
  onStep: (script, i) => { if (i === 0) step(7, TOTAL, 'ダッシュボードを生成する'); },
});

// ★ build-web.js の失敗を握りつぶさない。
//   docs/index.html は data/ の唯一のバックアップ（data/ は .gitignore 済み）。
//   合言葉が無い・短いとここで落ちるが、取込は成功し続けるため
//   「バックアップだけが黙って古くなる」状態になる。1行の警告では読み飛ばされるので、
//   最後の報告にも日付を出し、--commit も止める。
if (!built.ok) {
  line();
  line(`  ⚠ ${built.failedStep} が失敗しました（終了コード ${built.exitCode}）`);
  if (built.failedStep === 'build-web.js') {
    line('     バックアップ（docs/index.html）は更新されていません。');
    line('     .webpass に合言葉があるか確かめてから npm run build:web を実行してください。');
  }
}

// ---------------------------------------------------------------- 8. commit

if (DO_COMMIT) {
  step(8, TOTAL, 'コミットする');
  if (!built.ok) {
    // 古い docs/index.html を含んだまま「今月分を締めた」コミットを積まない。
    // 後から見ると締めたはずの月のバックアップが無い、という最悪の状態になる
    line('  ビルドが失敗しているためコミットを飛ばしました。');
  } else {
    const month = new Date().toISOString().slice(0, 7);
    spawnSync('git', ['add', '-A'], { stdio: 'inherit', cwd: ROOT });
    const r = spawnSync('git', ['commit', '-m', `${month} の家計を締め`], { stdio: 'inherit', cwd: ROOT });
    if (r.status === 0) line('  コミットしました（push は手動で）');
    else line('  コミットする変更はありませんでした');
  }
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

// ★ バックアップの日付を必ず出す。
//   data/ は Git 管理外で、docs/index.html（暗号化済み）だけが復元手段。
//   ここに出さないと、生成が止まっていることに何ヶ月も気づけない
const backup = backupStatus(today);
line(backup === null
  ? '  バックアップ  ⚠ 未生成（npm run build:web を実行してください）'
  // 今回の生成に失敗している場合、日付が今日でも「今日の分は入っていない」。
  // 直前の成功が今日だと ✅ に見えてしまうので、成否を優先して出す
  : !built.ok
    ? `  バックアップ  ⚠ 今回は更新できていません（最終 ${backup.date}）`
    : backup.stale
      ? `  バックアップ  ⚠ ${backup.date}（今日ではありません。docs/index.html が古いままです）`
      : `  バックアップ  ${backup.date} ✅`);

line();
line('  dist/index.html を開いて確認してください。');
if (!DO_COMMIT) line('  問題なければ  git add -A && git commit && git push');
line();

rl?.close();
