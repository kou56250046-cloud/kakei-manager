import { watch, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, dataPath, readJson, writeJson, yen } from './lib/io.js';
import { runPipeline, ALL_STEPS, IMPORT_STEPS, BUILD_STEPS, stepLabel, snapshot, backupStatus } from './lib/pipeline.js';
import { acquireLock } from './lib/lock.js';
import { startPanel } from './lib/panel-server.js';
import { notify } from './lib/notify.js';
import { startPublish, holdWorktree, reportPublish } from './lib/publish.js';

/**
 * フォルダにファイルを置くだけで家計アプリへ反映する常駐ウォッチャ。
 *
 * ★何を解決するか
 *   これまでは「置く → ターミナルを開く → npm run close を叩く」の3手だった。
 *   月に1回しか触らないため、2手目で止まると翌月まで放置になり、
 *   要確認が倍になって戻れなくなる。置いた時点で終わっているのが理想。
 *
 * 使い方:
 *   npm run watch          手元で起動する（Ctrl+C で止まる）
 *   npm run watch:install  ログオン時に自動で起動するよう登録する
 */

const WATCH_DIRS = [
  { dir: 'imports', ext: '.csv' },
  { dir: '給与明細', ext: '.pdf' },
  { dir: 'd-カード', ext: '.txt' },
];

/** イベントが静まるまでの待ち時間。fs.watch は1回のコピーで何度も発火する */
const DEBOUNCE_MS = 3_000;

/** ファイルサイズの確認間隔と、安定と見なす連続一致回数 */
const SETTLE_INTERVAL_MS = 700;
const SETTLE_HITS = 2;

/** ここまで待っても書き込みが終わらなければ、その回は見送る（次のイベントで拾う） */
const SETTLE_TIMEOUT_MS = 30_000;

/** 履歴はこれだけ残す。暗号化バックアップに毎回同梱されるため、無制限には伸ばさない */
const LOG_KEEP = 200;

/**
 * 起動してから未反映分の公開を試みるまでの待ち。
 * ログオン直後はネットワークと資格情報マネージャがまだ整っておらず、
 * すぐ push すると毎回「失敗」の通知が出る
 */
const CATCHUP_DELAY_MS = 120_000;

const config = readJson(join(ROOT, 'config.json'), {});
const port = config.panel?.port ?? 4649;

const lock = acquireLock({ port });
if (!lock) {
  const held = readJson(join(ROOT, '.watch.lock'), {});
  console.error('');
  console.error(`  ウォッチャは既に動いています（PID ${held.pid}）。`);
  console.error(`  確定パネル: http://127.0.0.1:${held.port ?? port}/`);
  console.error('');
  process.exit(0);
}

const line = (s = '') => console.log(s);
const stamp = () => new Date().toLocaleTimeString('ja-JP');
const relPath = (p) => relative(ROOT, p).replace(/\\/g, '/');

// ---------------------------------------------------------------- 変化の判定

/**
 * 監視対象フォルダの中身を「相対パス → サイズ:更新時刻」で覚えておく。
 *
 * ★なぜ必要か
 *   `fs.watch` は中身が変わっていなくてもイベントを出す。実際、取り込みが
 *   フォルダを読んだだけで全ファイル分の通知が飛び、**自分の実行が次の実行を呼ぶ**
 *   状態になった（実測：1回の投入で全22ファイルが再検知された）。
 *   放っておくと動き続けるので、イベントではなく中身で判定する。
 *
 *   これは「止まっている間に置かれたファイル」を起動時に拾う役目も兼ねる。
 */
const STATE_FILE = dataPath('watch_state.json');

const signature = (path) => {
  try {
    const s = statSync(path);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return null; // 消えた・読めない
  }
};

function scanAll() {
  const out = {};
  for (const { dir, ext } of WATCH_DIRS) {
    const path = join(ROOT, dir);
    if (!existsSync(path)) continue;
    for (const f of readdirSync(path)) {
      if (!f.toLowerCase().endsWith(ext)) continue;
      const sig = signature(join(path, f));
      if (sig) out[`${dir}/${f}`] = sig;
    }
  }
  return out;
}

let known = readJson(STATE_FILE, { files: {} }).files ?? {};

/**
 * 「ここまで処理した」という姿を覚える。
 *
 * ★渡すのは実行“開始時点”のスキャン結果にすること。
 *   終わったあとに scanAll() し直すと、**取り込み中に置かれたファイルまで
 *   処理済みとして覚えてしまう**。そのファイルは今回の取り込みに間に合っていない
 *   かもしれないのに、次のイベントで「変化なし」と判定されて永久に取り込まれない。
 */
const remember = (files) => {
  known = files;
  writeJson(STATE_FILE, { files: known, updatedAt: new Date().toISOString() });
};

// ---------------------------------------------------------------- 検知

/** デバウンス中に溜める。同じファイルが何度来ても1つにまとまる */
const pending = new Set();
let debounceTimer = null;
let running = false;
let rerun = false;

function onEvent(dir, filename) {
  if (!filename) return;
  const spec = WATCH_DIRS.find((w) => w.dir === dir);
  if (!spec || !filename.toLowerCase().endsWith(spec.ext)) return;

  const full = join(ROOT, dir, filename);
  pending.add(full);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

/**
 * 書き込みが終わるまで待つ。
 *
 * ★なぜ必要か
 *   ブラウザのダウンロードもエクスプローラのコピーも、まず0バイトのファイルを作る。
 *   そこで読むと「0行・検算不一致」として取り込んでしまい、
 *   しかも取り込み自体は成功扱いで終わるため気づけない。
 */
async function settled(path) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = -1;
  let hits = 0;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return false; // 置いてすぐ消した場合
    let size;
    try { size = statSync(path).size; } catch { return false; }
    if (size > 0 && size === last) {
      if (++hits >= SETTLE_HITS) return true;
    } else {
      hits = 0;
    }
    last = size;
    await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
  }
  return false;
}

async function flush() {
  if (running) { rerun = true; return; }

  // ★ イベントで来たものだけでなく、「まだ処理済みになっていない」ファイルも毎回さらう。
  //   取り込みが失敗した回は署名を記録しないので、そのとき置かれていたファイルは
  //   未処理のまま残る。しかし pending は flush のたびに空になるため、
  //   これが無いと**次に何を置いても、その置き去りのファイルだけ拾われない**。
  //   通常は差分ゼロなので、この走査の費用はほぼかからない。
  const unseen = Object.entries(scanAll())
    .filter(([k, sig]) => known[k] !== sig)
    .map(([k]) => join(ROOT, k));

  const files = [...new Set([...pending, ...unseen])];
  pending.clear();
  if (files.length === 0) return;

  running = true;
  try {
    const ready = [];
    for (const f of files) {
      if (!(await settled(f))) {
        line(`  ${stamp()} 書き込み中のため見送り: ${relPath(f)}`);
        continue;
      }
      // 中身が前回と同じなら無視する。ここを通さないと自分の実行で再び火がつく
      if (known[relPath(f)] === signature(f)) continue;
      ready.push(f);
    }
    if (ready.length > 0) await runOnce(ready);
  } finally {
    running = false;
    if (rerun) { rerun = false; setTimeout(flush, 0); }
  }
}

// ---------------------------------------------------------------- 実行

async function runOnce(files) {
  const at = new Date().toISOString();
  const started = Date.now();
  const rel = files.map(relPath);

  line();
  line('─'.repeat(74));
  line(`  ${stamp()}  ${rel.join(' / ')} を検知しました`);
  line('─'.repeat(74));

  // ★ 件数は各スクリプトの出力を読まずに data/ の差分から取る。
  //   出力の書式を変えた瞬間に静かに壊れる作りにしない
  const before = snapshot();
  // 実行中に置かれたものを取りこぼさないよう、覚える姿はここで固定する
  const seenAtStart = scanAll();

  // ★ 前の公開が git add〜commit している最中なら、それが終わるのを待つ。
  //   build-web.js が docs/ を書いている途中を add されると、書きかけがコミットされる。
  //   取ったら直後の try で必ず返す（返し損ねると以後の公開がすべて止まる）
  const total = ALL_STEPS.length;
  const onStep = (offset) => (script, i) => line(`  [${offset + i + 1}/${total}] ${stepLabel(script)}`);

  let result;
  let imported = false;
  const release = await holdWorktree();
  try {
    lock.setBusy(true);
    // ★ 取り込みとビルドを分けて呼ぶ。
    //   間で watch_log.json を書いておかないと、build.js がそれを読む時点では
    //   まだ今回の記録が無く、画面の「最後の自動反映」が毎回1回ぶん古くなる。
    result = runPipeline(IMPORT_STEPS, { onStep: onStep(0) });
    imported = result.ok;

    if (result.ok) {
      const mid = snapshot();
      appendLog({
        at, trigger: rel,
        seconds: Math.round((Date.now() - started) / 1000),
        ok: true, failed_step: null,
        added: mid.total - before.total,
        pending: mid.pending,
        mismatch: mid.mismatch,
      });
      result = runPipeline(BUILD_STEPS, { onStep: onStep(IMPORT_STEPS.length) });
    }
  } finally {
    lock.setBusy(false);
    // 鍵は公開の前に返す。startPublish は自分で鍵を取り直す（持ったまま呼ぶと待ち合って止まる）
    release();
  }

  const after = snapshot();
  const seconds = Math.round((Date.now() - started) / 1000);
  const added = after.total - before.total;

  // ★ 取り込みが失敗したときは、何も「処理済み」にしない。
  //   scanAll() は監視対象3フォルダぶんをまとめて撮るため、
  //   ここで無条件に覚えると「壊れたCSVのせいで import-card.js が落ちた回に、
  //   まだ一度も読まれていない給与明細のPDFまで処理済みになる」。
  //   そのPDFは中身を変えない限り二度とイベントで拾われず、起動時の追いつきにも出てこない。
  //   ビルドだけの失敗なら取り込みは終わっているので、覚えてよい。
  if (imported) remember(seenAtStart);
  else line('  （取り込みが失敗したため、処理済みとして記録しません。直せば次の変化で再挑戦します）');

  // 取り込みが失敗したときは上でまだ記録していない。ビルドが失敗したときは
  // 上の楽観的な記録を今の結果で上書きする（どちらも最後の1件を書き換えるだけ）
  appendLog({
    at, trigger: rel, seconds,
    ok: result.ok,
    failed_step: result.failedStep,
    added,
    pending: after.pending,
    mismatch: after.mismatch,
    // プッシュは待たないので、ここでは暫定。終わったら下の then で書き換える
    publish: result.ok ? 'pending' : 'skipped',
  }, { replaceSameStart: true });

  report(result, { added, after, seconds });

  // ★ 公開はコミットまでだけ待つ（running は真のまま＝パネルは断られる）。
  //   プッシュまで待つと、通信が詰まったときにパネルが数分「取り込み中」になる
  if (result.ok) {
    const pub = startPublish('import');
    pub.result.then((res) => {
      patchLog(at, { publish: res.status });
      reportPublish(res, 'import');
    });
    await pub.committed;
  }
}

function report(result, { added, after, seconds }) {
  if (!result.ok) {
    const why = `${result.failedStep} が終了コード ${result.exitCode} で停止`;
    line(`  ⚠ ${why}`);
    // build-web.js だけは特別。docs/index.html は data/ の唯一のバックアップなので、
    // 取込が成功していてもバックアップだけ古くなっていることを知らせる
    const extra = result.failedStep === 'build-web.js'
      ? 'バックアップ（docs/index.html）が更新されていません'
      : '取り込みは完了していません';
    notify('家計への反映に失敗', [why, extra]);
    return;
  }

  const head = added > 0 ? `新規 ${added}件` : '新規なし（変化はありませんでした）';
  const tail = after.pending > 0 ? `要確認 ${after.pending}件` : '要確認 なし';
  line(`  ✅ ${head} / ${tail} / ${seconds}秒`);

  const title = after.mismatch > 0 ? '家計に反映しました（検算 ⚠）' : '家計に反映しました';
  const lines = [`${head} / ${tail}`];
  if (after.mismatch > 0) lines.push(`検算不一致 ${after.mismatch}ファイル / 分類は http://127.0.0.1:${port}/`);
  else if (after.pending > 0) lines.push(`分類を決める: http://127.0.0.1:${port}/`);
  else {
    const backup = backupStatus();
    lines.push(backup ? `バックアップ ${backup.date}` : '');
  }
  notify(title, lines.filter(Boolean));
}

/**
 * 実行の記録を残す。
 *
 * 1回の実行で2度呼ぶ（ビルド前の暫定と、終わったあとの確定）。
 * `replaceSameStart` を付けた側は、同じ開始時刻の記録を積み増さずに置き換える。
 */
function appendLog(entry, { replaceSameStart = false } = {}) {
  const log = readJson(dataPath('watch_log.json'), []);
  const i = replaceSameStart ? log.findIndex((e) => e.at === entry.at) : -1;
  if (i >= 0) log[i] = entry;
  else log.push(entry);
  // 古いものから捨てる。履歴は「いつから動いていないか」が分かれば足りる
  writeJson(dataPath('watch_log.json'), log.slice(-LOG_KEEP));
}

/** 既存の記録の一部だけ書き換える（公開の結果は実行の記録より後に分かるため） */
function patchLog(at, patch) {
  const log = readJson(dataPath('watch_log.json'), []);
  const i = log.findIndex((e) => e.at === at);
  if (i < 0) return;
  log[i] = { ...log[i], ...patch };
  writeJson(dataPath('watch_log.json'), log);
}

// ---------------------------------------------------------------- 起動

const watchers = [];
for (const { dir, ext } of WATCH_DIRS) {
  const path = join(ROOT, dir);
  if (!existsSync(path)) {
    line(`  ⚠ ${dir}/ がありません（監視しません）`);
    continue;
  }
  const w = watch(path, (_event, filename) => onEvent(dir, filename));

  // ★ 監視自体のエラーでプロセスごと落とさない。
  //   フォルダを削除・リネームすると 'error' が飛ぶ。ハンドラが無いと例外になって
  //   ウォッチャが死に、タスクスケジューラが立て直しては同じ理由でまた死ぬ、を繰り返す。
  //   そのフォルダの監視だけ諦め、残りは動かし続ける。
  w.on('error', (e) => {
    line(`  ⚠ ${dir}/ の監視を終了します（${e.message}）。ここに置いても反映されません。`);
    try { w.close(); } catch { /* 既に閉じていれば何もしない */ }
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
    notify('家計ウォッチャの監視が1つ止まりました', [`${dir}/ を見られなくなりました`, '再開するには npm run watch:status で確認してください']);
  });

  watchers.push(w);
  line(`  監視: ${dir}/*${ext}`);
}

if (watchers.length === 0) {
  console.error('  監視できるフォルダがありません。');
  lock.release();
  process.exit(1);
}

// 確定パネルを同じプロセスに載せる。
// 別プロセスに分けると、2つが同じ data/ を別々に書く二重系になる。
// 取り込み中（running）は書き込みを断るため、running をそのまま渡す。
const panel = await startPanel({ port, isBusy: () => running });
lock.setPort(panel.port);

line();
line(`  ウォッチャを起動しました（PID ${process.pid}）。ファイルを置くと自動で反映します。`);
line(`  確定パネル: http://127.0.0.1:${panel.port}/`);
line('  止めるときは Ctrl+C。');
line();

// ★ 止まっている間に置かれたファイルを拾う。
//   PCを再起動した直後や、ウォッチャを止めていた期間に投入したものが取り残されると、
//   「置いたのに反映されない」という、この仕組みで最も困る状態になる。
//   前回と中身が同じなら何も起きないので、ログオンのたびに走ることはない。
{
  const now = scanAll();
  const changed = Object.keys(now).filter((k) => known[k] !== now[k]);
  if (changed.length > 0) {
    line(`  止まっている間に ${changed.length}件の変化がありました。追いつきます。`);
    for (const k of changed) pending.add(join(ROOT, k));
    setTimeout(flush, 0);
  }
}

// ★ 前回プッシュに失敗して残ったコミットや、ウォッチャを止めていた間に
//   手で build:web した docs/ を拾う。変化が無ければ何もしない（no_change）
setTimeout(() => {
  startPublish('catchup').result.then((res) => reportPublish(res, 'catchup'));
}, CATCHUP_DELAY_MS);

const shutdown = () => {
  for (const w of watchers) w.close();
  panel.close();
  lock.release();
  line('\n  ウォッチャを停止しました。');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ★ 予期しない例外で黙って死なせない。在席票を片付けてから、理由を残して落ちる
process.on('uncaughtException', (e) => {
  console.error('  ⚠ ウォッチャが異常終了します:', e?.stack ?? e);
  notify('家計ウォッチャが停止しました', [String(e?.message ?? e), 'タスクスケジューラが立て直します']);
  lock.release();
  process.exit(1);
});
