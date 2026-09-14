import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readAllTransactions, writeTransactionsByMonth } from './io.js';
import { applyOverride, byKey, addRule } from './classify-apply.js';
import { recordBalance, parseAmount } from './balance.js';
import { snapshot } from './pipeline.js';

/**
 * 分類が未確定の取引を、ダッシュボードの上で確定するためのローカルサーバ。
 *
 * ★なぜサーバが要るか
 *   `dist/index.html` は単一ファイルで、`file://` から開ける（そこが利点）。
 *   しかしブラウザから `data/` を書き換える手段が無いため、分類の確定だけは
 *   ターミナルに戻る必要があった。そこが「Claude Code が要る」最後の1か所だった。
 *
 * ★安全側の作り
 *   - 127.0.0.1 にだけ bind する。LAN の他端末からは繋がらない
 *   - Host ヘッダを検査する（DNSリバインディング対策）
 *   - 起動ごとに使い捨てのトークンを作り、配信時にHTMLへ差し込む。
 *     **ファイルには書かない**ので、`dist/index.html` は今までどおり file:// で開け、
 *     git にも公開版にもトークンは載らない
 *   - 書き込みは直列。触るのは1人だけなので、これで足りる
 */

const MAX_BODY = 64 * 1024;

/** dist/index.html の </head> 直前に差し込む。ここに無いものは confirm UI を出さない */
function inject(html, token, port) {
  const tag = `<script>window.PANEL=${JSON.stringify({ token, port })};</script>`;
  const i = html.indexOf('</head>');
  return i < 0 ? tag + html : html.slice(0, i) + tag + html.slice(i);
}

function runScript(script, args = []) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: ROOT,
  });
  return r.status === 0;
}

/**
 * 分類を確定して、ダッシュボードを作り直す。
 *
 * @param {object} req  { mode, key, category, subcategory, display, pattern, note }
 */
function classify(req) {
  const { mode, key, category } = req;
  if (!key || !category) return { ok: false, error: '店名と大分類は必須です' };

  let detail;
  if (mode === 'rule') {
    // 店名ルール。翌月以降も同じ店が自動で分類される
    const { insertedBefore } = addRule({
      key,
      pattern: req.pattern,
      category,
      subcategory: req.subcategory,
      display: req.display,
    });
    // 既存データへ反映する。manual_override が付いた取引はここでも触られない
    if (!runScript('reclassify.js', ['--all'])) return { ok: false, error: 'reclassify.js が失敗しました' };
    detail = insertedBefore >= 0 ? '既存ルールの前に挿入しました' : 'ルールを追加しました';
  } else if (mode === 'once') {
    // この取引だけ。商業施設のように毎回中身が違う店はこちら
    const tx = readAllTransactions();
    const n = applyOverride(tx, byKey(key), {
      category,
      subcategory: req.subcategory,
      merchant: req.display,
      note: req.note,
    });
    if (n === 0) return { ok: false, error: '対象の取引が見つかりませんでした' };
    writeTransactionsByMonth(tx);
    detail = `${n}件を確定しました`;
  } else {
    return { ok: false, error: 'mode は rule か once です' };
  }

  if (!runScript('build.js')) return { ok: false, error: 'build.js が失敗しました' };
  // バックアップ（docs/index.html）も追随させる。失敗は致命ではないので続行し、理由を返す
  const backedUp = runScript('build-web.js');

  return { ok: true, detail, backedUp, pending: snapshot().pending };
}

/**
 * 口座残高を記録して、ダッシュボードを作り直す。
 *
 * 残高が入って初めて「次の引落に足りるか」が判定できる。
 * このツールで唯一、行動につながる警告がそれなので、入力の敷居を下げる価値が高い。
 */
function balance(req) {
  const amount = parseAmount(req.amount);
  if (amount === null) return { ok: false, error: '金額は数字で入れてください' };

  const date = req.date || new Date().toISOString().slice(0, 10);
  const r = recordBalance(req.accountId, amount, date);
  if (!r.ok) return r;

  if (!runScript('build.js')) return { ok: false, error: 'build.js が失敗しました' };
  const backedUp = runScript('build-web.js');

  return {
    ok: true,
    detail: `${date} の残高として記録しました${r.replaced ? '（同じ日の記録を置き換え）' : ''}`,
    backedUp,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {number} opts.port           希望ポート。使用中なら +1 を最大10回試す
 * @param {() => boolean} [opts.isBusy] 取り込み中なら true を返す関数（その間は409）
 */
export async function startPanel({ port = 4649, isBusy = () => false } = {}) {
  const token = randomUUID();
  let actualPort = port; // 使用中なら下のループでずれる。Host の検査に使う

  // ★ 書き込みは実際には spawnSync でイベントループごと止まるため、
  //   同時に2件投げても順番に処理される（＝競合しない）。
  //   このフラグは、将来この処理を非同期に変えたときに素通りさせないための歯止め。
  //   確定の数秒間はページの読み込みも待たされるが、触るのは1人なので問題にならない。
  let busyWrite = false;

  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    // ★ Host を検査する。127.0.0.1 に bind していても、攻撃者のページから
    //   名前解決を自分に向けられる（DNSリバインディング）ため、名前で弾く
    const host = (req.headers.host ?? '').toLowerCase();
    const allowed = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowed.includes(host)) return send(403, { ok: false, error: 'forbidden host' });

    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const file = join(ROOT, 'dist', 'index.html');
      if (!existsSync(file)) return send(503, '<h1>まだ dist/index.html がありません</h1><p>npm run build を実行してください。</p>', 'text/html; charset=utf-8');
      return send(200, inject(readFileSync(file, 'utf8'), token, actualPort), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && (req.url === '/api/classify' || req.url === '/api/balance')) {
      const origin = req.headers.origin;
      if (origin && !allowed.some((a) => origin === `http://${a}`)) {
        return send(403, { ok: false, error: 'forbidden origin' });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(400, { ok: false, error: '読み取れない要求です' });
      }
      if (body?.token !== token) return send(403, { ok: false, error: 'token が違います（ページを再読み込みしてください）' });

      // 取り込み中は data/ を触らせない。両方が書くと片方の変更が消える
      if (isBusy()) return send(409, { ok: false, error: '取り込み中です。終わってからもう一度お試しください' });
      if (busyWrite) return send(409, { ok: false, error: '前の確定を処理中です' });

      busyWrite = true;
      try {
        const result = req.url === '/api/balance' ? balance(body) : classify(body);
        return send(result.ok ? 200 : 400, result);
      } catch (e) {
        return send(500, { ok: false, error: String(e?.message ?? e) });
      } finally {
        busyWrite = false;
      }
    }

    send(404, { ok: false, error: 'not found' });
  });

  // 使用中なら少しずらして試す。既に別の何かが 4649 を使っていても起動できるように
  for (let i = 0; i < 10; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(actualPort, '127.0.0.1');
      });
      return { server, port: actualPort, token, close: () => server.close() };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      actualPort = port + i + 1;
    }
  }
  throw new Error(`ポート ${port}〜${port + 10} がすべて使用中です`);
}
